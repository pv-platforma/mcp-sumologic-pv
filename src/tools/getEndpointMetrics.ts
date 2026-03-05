import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search, type SearchResult } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions, getPartition, getClusterName } from '../config/regions.js';
import type { Client } from '../lib/sumologic/types.js';

// ──────────────────────────────────────────────────────────
// Common HTTP access log regex for all queries
// Matches: "GET /api/v1/objectives HTTP/1.1" 200 0 12.345
// ──────────────────────────────────────────────────────────
const HTTP_LOG_PARSE = [
  '| json "log" as msg',
  '| where !isNull(msg)',
  '| where !(msg contains "/healthcheck")',
  '| parse regex field=msg "\\"(?:GET|POST|PUT|DELETE|PATCH) (?<api_endpoint>/api/[^\\s\\"]+) HTTP/\\d+\\.\\d+\\" (?<status_code>\\d+) \\d+ (?<response_time>\\d+\\.\\d+)"',
].join(' ');

/**
 * Build a scoped query with fallback strategy:
 *   1. cluster="..." namespace="..." deployment="..."
 *   2. _index=<partition> namespace="..." deployment="..."
 *   3. _sourceCategory=*<namespace>*
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
  // Strategy 1: Cluster + namespace + deployment
  const clusterScope = `cluster="${cluster}" namespace=${namespace} deployment=${deployment} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;

  try {
    const result = await search(client, clusterQuery, options);
    if (result.messageCount > 0 || result.recordCount > 0) {
      return { result, querySource: 'cluster', queryUsed: clusterQuery };
    }
  } catch (e) {
    console.error(`[EndpointMetrics] Cluster query failed: ${(e as Error).message}`);
  }

  // Strategy 2: Partition index
  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace} deployment=${deployment} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;

    try {
      const result = await search(client, partitionQuery, options);
      if (result.messageCount > 0 || result.recordCount > 0) {
        return { result, querySource: 'partition', queryUsed: partitionQuery };
      }
    } catch (e) {
      console.error(`[EndpointMetrics] Partition query failed: ${(e as Error).message}`);
    }
  }

  // Strategy 3: Source category fallback
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

/** Query 1: Per-endpoint performance breakdown */
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

/** Query 2: Success count over time (timesliced) */
function buildSuccessTimeseriesQuery(timeslice: string): string {
  return [
    HTTP_LOG_PARSE,
    '| if(status_code matches "2*", 1, 0) as Successes',
    `| timeslice by ${timeslice}`,
    '| sum(Successes) as Successes by _timeslice',
    '| sort by _timeslice asc',
  ].join(' ');
}

/** Query 3: Failure count over time (timesliced) */
function buildFailureTimeseriesQuery(timeslice: string): string {
  return [
    HTTP_LOG_PARSE,
    '| if(status_code > 400, 1, 0) as Failures',
    `| timeslice by ${timeslice}`,
    '| sum(Failures) as Failures by _timeslice',
    '| sort by _timeslice asc',
  ].join(' ');
}

/** Query 4: Success & Failure combined with totals */
function buildSuccessFailureTotalsQuery(timeslice: string): string {
  return [
    HTTP_LOG_PARSE,
    '| if(status_code > 400, 1, 0) as Failures',
    '| if(status_code matches "2*", 1, 0) as Successes',
    `| timeslice by ${timeslice}`,
    '| sum(Failures) as Failures, sum(Successes) as Successes by _timeslice',
    '| sort by _timeslice asc',
    '| sum(Failures) as Total_Failures, sum(Successes) as Total_Successes',
  ].join(' ');
}

/** Query 5: Throughput per second (using collector-based or cluster-based) */
function buildThroughputQuery(): string {
  return [
    HTTP_LOG_PARSE,
    '| timeslice 1s',
    '| count by _timeslice',
    '| avg(_count) as avg_throughput_per_sec,',
    '  max(_count) as peak_throughput_per_sec,',
    '  min(_count) as min_throughput_per_sec',
  ].join(' ');
}

/** Query 6: Unique users */
function buildUniqueUsersQuery(): string {
  return [
    '| json "log" as msg',
    '| where !isNull(msg)',
    '| where !(msg contains "/healthcheck")',
    '| where !(msg contains "/api/ui")',
    '| parse "user_id: *" as user_id nodrop',
    '| parse regex field=msg "user[_-]?id[=:\\\\s]+(?<user_id_alt>[^\\s,\\"]+)" nodrop',
    '| if(!isNull(user_id), user_id, user_id_alt) as effective_user_id',
    '| where !isNull(effective_user_id)',
    '| count by effective_user_id',
    '| count as unique_users',
  ].join(' ');
}

// ──────────────────────────────────────────────────────────
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerGetEndpointMetricsTool(server: McpServer): void {
  server.tool(
    'get_endpoint_metrics',
    'Get detailed API endpoint metrics including per-endpoint performance, throughput, success/failure rates, and unique users. Mirrors Sumo Logic UI dashboard queries.',
    {
      application: z.string().describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z.string().optional().describe('Deployment name (e.g., okrs-api). Defaults to <application>-api'),
      region: z.string().optional().describe('Specific region (e.g., usw2-prod, aps2-prod) or omit for all prod regions'),
      metricType: z.enum([
        'endpoint_performance',
        'success_timeseries',
        'failure_timeseries',
        'success_failure_totals',
        'throughput',
        'unique_users',
        'all',
      ]).default('all').describe('Which metric to fetch'),
      timeslice: z.string().optional().default('1h').describe('Time bucket for timeseries queries (e.g., 1h, 15m, 1d)'),
      from: z.string().optional().default('-24h').describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z.string().optional().default('now').describe('End time'),
    },
    async ({ application, deployment, region, metricType, timeslice, from, to }) => {
      const deploy = deployment || `${application}-api`;
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