import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search, type SearchResult } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions, getPartition, getClusterName } from '../config/regions.js';
import type { Client } from '../lib/sumologic/types.js';

// ──────────────────────────────────────────────────────────
// Common log parsing: JSON extraction + health check filters
// ──────────────────────────────────────────────────────────
const JSON_LOG_PARSE = [
  '| json "log" as msg nodrop',
  '| if(isNull(msg), _raw, msg) as msg',
  '| where !isNull(msg)',
  '| where !(msg contains "/healthcheck")',
  '| where !(msg contains "kube-probe")',
  '| where !(msg contains "/healthz")',
  '| where !(msg contains "Site24x7")',
  '| where !(msg contains "/api/ui")',
].join(' ');

// ──────────────────────────────────────────────────────────
// HTTP access log regex for endpoint-level queries
// Matches: "GET /api/v1/objectives HTTP/1.1" 200 0 12.345
// ──────────────────────────────────────────────────────────
const HTTP_PARSE = '| parse regex field=msg "\\"(?:GET|POST|PUT|DELETE|PATCH) (?<api_endpoint>/[^\\s\\"]+) HTTP/\\d+\\.\\d+\\" (?<status_code>\\d+) \\d+ (?<response_time>\\d+\\.\\d+)" nodrop';

const HTTP_LOG_PARSE = [JSON_LOG_PARSE, HTTP_PARSE].join(' ');

// ──────────────────────────────────────────────────────────
// Application-level log regex for user context
// Matches: api/get_channel - admin_url: ... - planview_user_id: xxx - user_id: yyy - tenant_group_id: zzz
// ──────────────────────────────────────────────────────────
const APP_LOG_PARSE_USER_CONTEXT = [
  '| parse regex field=msg "^api/(?<app_action>[^\\s]+)\\s+-\\s+admin_url:\\s*(?<admin_url>[^\\s]*)\\s+-\\s+planview_user_id:\\s*(?<planview_user_id>[^\\s]*)\\s+-\\s+user_id:\\s*(?<app_user_id>[^\\s]*)\\s+-\\s+tenant_group_id:\\s*(?<tenant_group_id>[^\\s]*)" nodrop',
].join(' ');

// ──────────────────────────────────────────────────────────
// Combined log parsing: captures BOTH HTTP access logs AND application-level logs
// Uses two parse regex with nodrop to extract from either format,
// then unifies the endpoint name from both sources
// ──────────────────────────────────────────────────────────
const COMBINED_LOG_PARSE = [
  JSON_LOG_PARSE,
  // Parse HTTP access log format
  HTTP_PARSE,
  // Parse application-level api log format
  APP_LOG_PARSE_USER_CONTEXT,
  // Determine log type
  '| if(!isNull(api_endpoint), "http", if(!isNull(app_action), "app", "other")) as log_type',
  '| where log_type != "other"',
].join(' ');

/**
 * Build a scoped query with combined strategy:
 *   1. Try BOTH cluster and partition, pick the one with more data
 *   2. Fall back to _sourceCategory=*<namespace>*
 */
async function searchWithFallback(
  client: Client,
  partition: string,
  cluster: string,
  namespace: string,
  deployment: string,
  queryPart: string,
  options: { from: string; to: string }
): Promise<{ result: SearchResult; querySource: string; queryUsed: string }> {
  const deployFilter = deployment ? ` deployment=${deployment}` : '';

  // Strategy 1: Try BOTH cluster and partition to get complete data
  const clusterScope = `cluster="${cluster}" namespace=${namespace}${deployFilter} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;

  let clusterResult: SearchResult | null = null;
  let partitionResult: SearchResult | null = null;

  try {
    clusterResult = await search(client, clusterQuery, options);
  } catch (e) {
    console.error(`[EndpointMetrics] Cluster query failed: ${(e as Error).message}`);
  }

  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace}${deployFilter} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;
    try {
      partitionResult = await search(client, partitionQuery, options);
    } catch (e) {
      console.error(`[EndpointMetrics] Partition query failed: ${(e as Error).message}`);
    }
  }

  const clusterCount = (clusterResult?.messageCount || 0) + (clusterResult?.recordCount || 0);
  const partitionCount = (partitionResult?.messageCount || 0) + (partitionResult?.recordCount || 0);

  if (clusterCount > 0 || partitionCount > 0) {
    if (partitionCount > clusterCount && partitionResult) {
      return { result: partitionResult, querySource: 'partition', queryUsed: `_index=${partition} namespace=${namespace}${deployFilter} pod=* ${queryPart}` };
    }
    if (clusterResult && clusterCount > 0) {
      return { result: clusterResult, querySource: 'cluster', queryUsed: clusterQuery };
    }
    if (partitionResult && partitionCount > 0) {
      return { result: partitionResult, querySource: 'partition', queryUsed: `_index=${partition} namespace=${namespace}${deployFilter} pod=* ${queryPart}` };
    }
  }

  // Strategy 2: sourceCategory fallback
  const sourceCatQuery = `_sourceCategory=*${namespace}* ${queryPart}`;
  try {
    const result = await search(client, sourceCatQuery, options);
    return { result, querySource: 'sourceCategory', queryUsed: sourceCatQuery };
  } catch (e) {
    console.error(`[EndpointMetrics] SourceCategory query failed: ${(e as Error).message}`);
  }

  return {
    result: { messages: [], records: [], messageCount: 0, recordCount: 0 },
    querySource: 'none (all strategies failed)',
    queryUsed: clusterQuery,
  };
}

// ──────────────────────────────────────────────────────────
// Metric type query builders
// ──────────────────────────────────────────────────────────

/** Query 1: Per-endpoint performance breakdown (HTTP access logs only — these have response times & status codes) */
function buildEndpointPerformanceQuery(): string {
  return [
    HTTP_LOG_PARSE,
    '| toDouble(response_time) as response_time',
    '| toLong(status_code) as status_code',
    '| if(status_code > 400, 1, 0) as is_failure',
    '| avg(response_time) as avg_response_time,',
    '  min(response_time) as min_resp_time,',
    '  max(response_time) as max_resp_time,',
    '  pct(response_time, 50) as P_50,',
    '  pct(response_time, 90) as P_90,',
    '  pct(response_time, 95) as P_95,',
    '  count as request_count,',
    '  sum(is_failure) as failure_count',
    '  by api_endpoint',
    '| (100 * failure_count / request_count) as failure_rate_percent',
    '| sort by avg_response_time desc',
  ].join(' ');
}

/** Query 2: Success count over time (timesliced) — counts both HTTP + app logs */
function buildSuccessTimeseriesQuery(timeslice: string): string {
  return [
    COMBINED_LOG_PARSE,
    '| if(log_type = "http" and status_code matches "2*", 1, if(log_type = "app", 1, 0)) as Successes',
    `| timeslice by ${timeslice}`,
    '| sum(Successes) as Successes by _timeslice',
    '| sort by _timeslice asc',
  ].join(' ');
}

/** Query 3: Failure count over time (timesliced) — counts both HTTP + app logs */
function buildFailureTimeseriesQuery(timeslice: string): string {
  return [
    COMBINED_LOG_PARSE,
    '| if(log_type = "http" and status_code > 400, 1, 0) as Failures',
    `| timeslice by ${timeslice}`,
    '| sum(Failures) as Failures by _timeslice',
    '| sort by _timeslice asc',
  ].join(' ');
}

/** Query 4: Success & Failure combined totals — counts both HTTP + app logs */
function buildSuccessFailureTotalsQuery(timeslice: string): string {
  return [
    COMBINED_LOG_PARSE,
    '| if(log_type = "http" and status_code > 400, 1, 0) as Failures',
    '| if(log_type = "http" and status_code matches "2*", 1, if(log_type = "app", 1, 0)) as Successes',
    `| timeslice by ${timeslice}`,
    '| sum(Failures) as Failures, sum(Successes) as Successes by _timeslice',
    '| sort by _timeslice asc',
    '| sum(Failures) as Total_Failures, sum(Successes) as Total_Successes',
  ].join(' ');
}

/** Query 5: Throughput per second — counts both HTTP + app logs */
function buildThroughputQuery(): string {
  return [
    COMBINED_LOG_PARSE,
    '| timeslice 1s',
    '| count by _timeslice',
    '| avg(_count) as avg_throughput_per_sec,',
    '  max(_count) as peak_throughput_per_sec,',
    '  min(_count) as min_throughput_per_sec',
  ].join(' ');
}

/** Query 6: Unique users — parses planview_user_id from app-level logs */
function buildUniqueUsersQuery(): string {
  return [
    JSON_LOG_PARSE,
    // Parse user context from app-level logs: api/get_channel - admin_url: ... - planview_user_id: xxx - user_id: yyy
    '| parse regex field=msg "planview_user_id:\\s*(?<planview_user_id>[^\\s-]+)" nodrop',
    '| parse regex field=msg "user_id:\\s*(?<parsed_user_id>[^\\s-]+)" nodrop',
    '| parse regex field=msg "tenant_group_id:\\s*(?<parsed_tenant_group_id>[^\\s-]+)" nodrop',
    // Also try generic user_id patterns as fallback
    '| parse "user_id: *" as user_id_alt nodrop',
    '| parse regex field=msg "user[_-]?id[=:\\\\s]+(?<user_id_alt2>[^\\s,\\"]+)" nodrop',
    // Unify: prefer planview_user_id > parsed_user_id > user_id_alt > user_id_alt2
    '| if(!isNull(planview_user_id) and planview_user_id != "", planview_user_id, if(!isNull(parsed_user_id) and parsed_user_id != "", parsed_user_id, if(!isNull(user_id_alt), user_id_alt, user_id_alt2))) as effective_user_id',
    '| where !isNull(effective_user_id) and effective_user_id != ""',
    '| count by effective_user_id',
    '| count as unique_users',
  ].join(' ');
}

/** Query 7: Overall API latency (P50/P90/P95/P99) — HTTP access logs only (only source of response times) */
function buildLatencyQuery(): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(response_time)',
    '| toDouble(response_time) as response_time_ms',
    '| avg(response_time_ms) as avg_latency_ms,',
    '  min(response_time_ms) as min_latency_ms,',
    '  max(response_time_ms) as max_latency_ms,',
    '  pct(response_time_ms, 50) as p50_ms,',
    '  pct(response_time_ms, 90) as p90_ms,',
    '  pct(response_time_ms, 95) as p95_ms,',
    '  pct(response_time_ms, 99) as p99_ms,',
    '  count as total_requests',
  ].join(' ');
}

/** Query 8: Overall error rate (5xx server errors + 4xx client errors) — HTTP access logs only (only source of status codes) */
function buildErrorRateQuery(): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(status_code)',
    '| toLong(status_code) as status_code_num',
    '| if(status_code_num >= 500, 1, 0) as is_server_error',
    '| if(status_code_num >= 400 and status_code_num < 500, 1, 0) as is_client_error',
    '| sum(is_server_error) as server_errors,',
    '  sum(is_client_error) as client_errors,',
    '  count as total_requests',
    '| (server_errors / total_requests * 100) as server_error_rate_pct',
    '| (client_errors / total_requests * 100) as client_error_rate_pct',
    '| ((server_errors + client_errors) / total_requests * 100) as total_error_rate_pct',
  ].join(' ');
}

/** Query 8b: Error rate TREND over time — shows increasing/decreasing pattern */
function buildErrorRateTimeseriesQuery(timeslice: string): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(status_code)',
    '| toLong(status_code) as status_code_num',
    '| if(status_code_num >= 500, 1, 0) as is_server_error',
    '| if(status_code_num >= 400 and status_code_num < 500, 1, 0) as is_client_error',
    `| timeslice ${timeslice}`,
    '| sum(is_server_error) as server_errors,',
    '  sum(is_client_error) as client_errors,',
    '  count as total_requests by _timeslice',
    '| (server_errors / total_requests * 100) as error_rate_pct',
    '| sort _timeslice asc',
  ].join(' ');
}

/** Query 7b: Latency TREND over time — shows P50/P95 increasing/decreasing pattern */
function buildLatencyTimeseriesQuery(timeslice: string): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(response_time)',
    '| toDouble(response_time) as response_time_ms',
    `| timeslice ${timeslice}`,
    '| avg(response_time_ms) as avg_latency_ms,',
    '  pct(response_time_ms, 50) as p50_ms,',
    '  pct(response_time_ms, 95) as p95_ms,',
    '  count as request_count by _timeslice',
    '| sort _timeslice asc',
  ].join(' ');
}

/** Query 9: Per-user API activity — correlates users with the actions they called using app-level logs */
function buildUserActivityQuery(): string {
  return [
    JSON_LOG_PARSE,
    APP_LOG_PARSE_USER_CONTEXT,
    '| where !isNull(app_action)',
    '| count as request_count by planview_user_id, tenant_group_id, app_action',
    '| sort by request_count desc',
    '| limit 50',
  ].join(' ');
}

// ──────────────────────────────────────────────────────────
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerGetPerformanceMetricsTool(server: McpServer): void {
  server.tool(
    'get_performance_metrics',
    'Get application performance metrics: per-endpoint response times (P50/P90/P95), success/failure rates, throughput per second, unique users, per-user API activity, overall API latency (P50/P90/P95/P99) with time-series trend, and error rates (5xx/4xx) with time-series trend showing increase/decrease over time. Counts both HTTP access logs and application-level logs for accurate totals. Use this when asked about application performance, endpoint performance, latency, throughput, error rates, error rate trends, user activity, or how the app is performing.',
    {
      application: z.string().describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z.string().optional().describe('Deployment name (e.g., okrs-api). Omit to get metrics from ALL deployments in the namespace'),
      region: z.string().optional().describe('Specific region (e.g., usw2-prod, aps2-prod) or omit for all prod regions'),
      metricType: z.enum([
        'endpoint_performance',
        'success_timeseries',
        'failure_timeseries',
        'success_failure_totals',
        'throughput',
        'unique_users',
        'user_activity',
        'latency',
        'error_rate',
        'all',
      ]).default('all').describe('Which metric to fetch. Use user_activity to see per-user API call breakdown.'),
      timeslice: z.string().optional().default('1h').describe('Time bucket for timeseries queries (e.g., 1h, 15m, 1d)'),
      from: z.string().optional().default('-24h').describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z.string().optional().default('now').describe('End time'),
    },
    async ({ application, deployment, region, metricType, timeslice, from, to }) => {
      const deploy = deployment || '';  // empty = all deployments in namespace
      const ns = application;
      const targetRegions = region
        ? [region]
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const allResults: Record<string, Record<string, unknown>> = {};

      for (const reg of targetRegions) {
        const regionMetrics: Record<string, unknown> = {};

        try {
          const logClient = getClient(reg);
          const cluster = getClusterName(reg);
          let partition: string;
          try {
            partition = getPartition(reg);
          } catch {
            partition = '';
          }

          const searchOpts = { from: from || '-24h', to: to || 'now' };

          // ── Endpoint Performance ──
          if (metricType === 'endpoint_performance' || metricType === 'all') {
            try {
              const queryPart = buildEndpointPerformanceQuery();
              const { result, querySource, queryUsed } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              if (result.records && result.records.length > 0) {
                regionMetrics.endpointPerformance = {
                  endpoints: result.records.map(r => r.map),
                  count: result.records.length,
                  querySource,
                };
              } else if (result.messages && result.messages.length > 0) {
                regionMetrics.endpointPerformance = {
                  endpoints: result.messages.map(m => m.map),
                  count: result.messages.length,
                  querySource,
                };
              } else {
                regionMetrics.endpointPerformance = { message: 'No endpoint data found', querySource, queryUsed };
              }
            } catch (e) {
              regionMetrics.endpointPerformance = { error: (e as Error).message };
            }
          }

          // ── Success Timeseries ──
          if (metricType === 'success_timeseries' || metricType === 'all') {
            try {
              const queryPart = buildSuccessTimeseriesQuery(timeslice);
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              regionMetrics.successTimeseries = {
                timeseries: data.map(r => r.map),
                dataPoints: data.length,
                querySource,
              };
            } catch (e) {
              regionMetrics.successTimeseries = { error: (e as Error).message };
            }
          }

          // ── Failure Timeseries ──
          if (metricType === 'failure_timeseries' || metricType === 'all') {
            try {
              const queryPart = buildFailureTimeseriesQuery(timeslice);
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              regionMetrics.failureTimeseries = {
                timeseries: data.map(r => r.map),
                dataPoints: data.length,
                querySource,
              };
            } catch (e) {
              regionMetrics.failureTimeseries = { error: (e as Error).message };
            }
          }

          // ── Success/Failure Totals ──
          if (metricType === 'success_failure_totals' || metricType === 'all') {
            try {
              const queryPart = buildSuccessFailureTotalsQuery(timeslice);
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              regionMetrics.successFailureTotals = {
                data: data.map(r => r.map),
                querySource,
              };
            } catch (e) {
              regionMetrics.successFailureTotals = { error: (e as Error).message };
            }
          }

          // ── Throughput ──
          if (metricType === 'throughput' || metricType === 'all') {
            try {
              const queryPart = buildThroughputQuery();
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              if (data.length > 0) {
                regionMetrics.throughput = {
                  ...data[0].map,
                  unit: 'requests/sec',
                  querySource,
                };
              } else {
                regionMetrics.throughput = { message: 'No throughput data found', querySource };
              }
            } catch (e) {
              regionMetrics.throughput = { error: (e as Error).message };
            }
          }

          // ── Unique Users ──
          if (metricType === 'unique_users' || metricType === 'all') {
            try {
              const queryPart = buildUniqueUsersQuery();
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              if (data.length > 0) {
                regionMetrics.uniqueUsers = {
                  ...data[0].map,
                  querySource,
                };
              } else {
                regionMetrics.uniqueUsers = { message: 'No user data found', querySource };
              }
            } catch (e) {
              regionMetrics.uniqueUsers = { error: (e as Error).message };
            }
          }

          // ── Overall Latency (aggregated + timeseries trend) ──
          if (metricType === 'latency' || metricType === 'all') {
            try {
              const queryPart = buildLatencyQuery();
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              const latencyResult: Record<string, unknown> = {};

              if (data.length > 0) {
                latencyResult.totals = {
                  ...data[0].map,
                  unit: 'ms',
                };
              } else {
                latencyResult.totals = { message: 'No latency data found' };
              }

              // Latency trend over time
              try {
                const trendQuery = buildLatencyTimeseriesQuery(timeslice);
                const { result: trendResult } = await searchWithFallback(
                  logClient, partition, cluster, ns, deploy, trendQuery, searchOpts
                );
                const trendData = (trendResult.records?.length ? trendResult.records : trendResult.messages) || [];
                if (trendData.length > 0) {
                  latencyResult.trend = trendData.map(r => r.map);
                  latencyResult.trendBucket = timeslice;
                }
              } catch (e) {
                latencyResult.trend = { error: (e as Error).message };
              }

              latencyResult.querySource = querySource;
              regionMetrics.latency = latencyResult;
            } catch (e) {
              regionMetrics.latency = { error: (e as Error).message };
            }
          }

          // ── Error Rate (aggregated + timeseries trend) ──
          if (metricType === 'error_rate' || metricType === 'all') {
            try {
              const queryPart = buildErrorRateQuery();
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              const errorRateResult: Record<string, unknown> = {};

              if (data.length > 0) {
                const record = data[0].map || {};
                errorRateResult.totals = {
                  serverErrors: record.server_errors || '0',
                  clientErrors: record.client_errors || '0',
                  totalRequests: record.total_requests || '0',
                  serverErrorRate: `${record.server_error_rate_pct || '0'}%`,
                  clientErrorRate: `${record.client_error_rate_pct || '0'}%`,
                  totalErrorRate: `${record.total_error_rate_pct || '0'}%`,
                };
              } else {
                errorRateResult.totals = { message: 'No error rate data found' };
              }

              // Error rate trend over time
              try {
                const trendQuery = buildErrorRateTimeseriesQuery(timeslice);
                const { result: trendResult } = await searchWithFallback(
                  logClient, partition, cluster, ns, deploy, trendQuery, searchOpts
                );
                const trendData = (trendResult.records?.length ? trendResult.records : trendResult.messages) || [];
                if (trendData.length > 0) {
                  errorRateResult.trend = trendData.map(r => r.map);
                  errorRateResult.trendBucket = timeslice;
                }
              } catch (e) {
                errorRateResult.trend = { error: (e as Error).message };
              }

              errorRateResult.querySource = querySource;
              regionMetrics.errorRate = errorRateResult;
            } catch (e) {
              regionMetrics.errorRate = { error: (e as Error).message };
            }
          }

          // ── User Activity ──
          if (metricType === 'user_activity' || metricType === 'all') {
            try {
              const queryPart = buildUserActivityQuery();
              const { result, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, deploy, queryPart, searchOpts
              );

              const data = (result.records?.length ? result.records : result.messages) || [];
              if (data.length > 0) {
                regionMetrics.userActivity = {
                  entries: data.map(r => r.map),
                  count: data.length,
                  querySource,
                };
              } else {
                regionMetrics.userActivity = { message: 'No user activity data found', querySource };
              }
            } catch (e) {
              regionMetrics.userActivity = { error: (e as Error).message };
            }
          }

          allResults[reg] = {
            cluster,
            partition: partition || 'N/A',
            namespace: ns,
            deployment: deploy,
            ...regionMetrics,
          };
        } catch (error) {
          allResults[reg] = { error: (error as Error).message };
        }
      }

      // Generate summary
      const summary = generateEndpointSummary(allResults);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            application: ns,
            deployment: deploy,
            timeRange: { from, to },
            timeslice,
            metricType,
            summary,
            regionDetails: allResults,
          }, null, 2),
        }],
      };
    }
  );
}

function generateEndpointSummary(results: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const regions = Object.keys(results).filter(r => !results[r].error);

  summary.regionsQueried = Object.keys(results).length;
  summary.regionsWithData = regions.length;
  summary.regionsWithErrors = Object.keys(results).length - regions.length;

  // Summarize endpoints performance across regions
  const allEndpoints: Array<Record<string, string>> = [];
  for (const reg of regions) {
    const ep = results[reg].endpointPerformance as { endpoints?: Array<Record<string, string>> } | undefined;
    if (ep?.endpoints) {
      allEndpoints.push(...ep.endpoints);
    }
  }

  if (allEndpoints.length > 0) {
    const slowest = allEndpoints
      .filter(e => e.avg_response_time)
      .sort((a, b) => parseFloat(b.avg_response_time) - parseFloat(a.avg_response_time))
      .slice(0, 5);

    const highestFailure = allEndpoints
      .filter(e => e.failure_rate_percent)
      .sort((a, b) => parseFloat(b.failure_rate_percent) - parseFloat(a.failure_rate_percent))
      .slice(0, 5);

    const mostCalled = allEndpoints
      .filter(e => e.request_count)
      .sort((a, b) => parseInt(b.request_count) - parseInt(a.request_count))
      .slice(0, 5);

    summary.topSlowestEndpoints = slowest.map(e => ({
      endpoint: e.api_endpoint,
      avgResponseTime: e.avg_response_time,
      p95: e.P_95,
      requestCount: e.request_count,
    }));

    summary.highestFailureRateEndpoints = highestFailure.map(e => ({
      endpoint: e.api_endpoint,
      failureRate: e.failure_rate_percent + '%',
      failureCount: e.failure_count,
      requestCount: e.request_count,
    }));

    summary.mostCalledEndpoints = mostCalled.map(e => ({
      endpoint: e.api_endpoint,
      requestCount: e.request_count,
      avgResponseTime: e.avg_response_time,
    }));
  }

  return summary;
}