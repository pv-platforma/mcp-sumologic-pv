import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search, type SearchResult } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getMetricsClient } from '../lib/sumologic/metricsClientFactory.js';
import { getProdRegions, getConfiguredRegions, getPartition, getClusterName } from '../config/regions.js';
import type { Client } from '../lib/sumologic/types.js';
import moment from 'moment';

/**
 * Parse time strings into ISO 8601 UTC format for Metrics API only.
 * Log searches use raw relative strings — handled by search() internally.
 */
function parseTimeString(timeStr: string): string {
  if (!timeStr || timeStr.toLowerCase() === 'now') {
    return moment.utc().format('YYYY-MM-DDTHH:mm:ss.SSS') + 'Z';
  }

  const relativeMatch = timeStr.match(/^-(\d+)([mhd])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];

    let result: moment.Moment;
    switch (unit) {
      case 'm': result = moment.utc().subtract(value, 'minutes'); break;
      case 'h': result = moment.utc().subtract(value, 'hours'); break;
      case 'd': result = moment.utc().subtract(value, 'days'); break;
      default:  result = moment.utc().subtract(value, 'hours');
    }
    return result.format('YYYY-MM-DDTHH:mm:ss.SSS') + 'Z';
  }

  const parsed = moment.utc(timeStr);
  if (parsed.isValid()) {
    return parsed.format('YYYY-MM-DDTHH:mm:ss.SSS') + 'Z';
  }

  return timeStr;
}

function calculateStats(values: number[]): { avg: number; min: number; max: number; latest: number } {
  const validValues = values.filter(v => v !== null && !isNaN(v));
  if (validValues.length === 0) return { avg: 0, min: 0, max: 0, latest: 0 };
  return {
    avg: validValues.reduce((a, b) => a + b, 0) / validValues.length,
    min: Math.min(...validValues),
    max: Math.max(...validValues),
    latest: validValues[validValues.length - 1],
  };
}

/**
 * Execute a log query with fallback: cluster first, then partition.
 *
 * Flow:
 *   1. cluster="fd-platform-usw2-prod" namespace="okrs" <queryPart>
 *   2. If no results → _index=fd_platform_usw2_prod_debug_null namespace="okrs" <queryPart>
 */
async function searchWithFallback(
  client: Client,
  partition: string,
  cluster: string,
  namespace: string,
  queryPart: string,
  options: { from: string; to: string }
): Promise<{ result: SearchResult; querySource: string; queryUsed: string }> {
  // Strategy 1: Try cluster first (this was the original working approach)
  const clusterQuery = `cluster="${cluster}" namespace="${namespace}" ${queryPart}`;

  try {
    const result = await search(client, clusterQuery, options);

    if (result.messageCount > 0 || result.recordCount > 0) {
      return { result, querySource: 'cluster', queryUsed: clusterQuery };
    }
  } catch (e) {
    console.error(`[SumoLogic] Cluster query failed: ${(e as Error).message}`);
  }

  // Strategy 2: Try partition index
  if (partition) {
    const partitionQuery = `_index=${partition} namespace="${namespace}" ${queryPart}`;

    try {
      const partitionResult = await search(client, partitionQuery, options);

      if (partitionResult.messageCount > 0 || partitionResult.recordCount > 0) {
        return { result: partitionResult, querySource: 'partition', queryUsed: partitionQuery };
      }
    } catch (e) {
      console.error(`[SumoLogic] Partition query failed: ${(e as Error).message}`);
    }
  }

  // Strategy 3: Try sourceCategory as last resort
  const sourceCatQuery = `_sourceCategory=*${namespace}* ${queryPart}`;

  try {
    const sourceCatResult = await search(client, sourceCatQuery, options);
    return { result: sourceCatResult, querySource: 'sourceCategory (fallback)', queryUsed: sourceCatQuery };
  } catch (e) {
    console.error(`[SumoLogic] SourceCategory query failed: ${(e as Error).message}`);
  }

  // All strategies failed — return empty result
  return {
    result: { messages: [], records: [], messageCount: 0, recordCount: 0 },
    querySource: 'none (all strategies failed)',
    queryUsed: clusterQuery,
  };
}

export function registerGetPerformanceMetricsTool(server: McpServer): void {
  server.tool(
    'get_performance_metrics',
    'Get performance metrics including memory, CPU (from Metrics API), latency, throughput, and error rates (from logs with cluster→partition→sourceCategory fallback)',
    {
      application: z.string().describe('Application/service name (e.g., okrs, roadmaps, logbook)'),
      namespace: z.string().optional().describe('Kubernetes namespace (defaults to application name)'),
      deployment: z.string().optional().describe('Deployment name (defaults to {application}-api)'),
      region: z.string().optional().describe('Specific region or omit for all prod regions'),
      from: z.string().describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z.string().describe('End time (e.g., now)'),
      metricType: z.enum(['memory', 'cpu', 'latency', 'throughput', 'error_rate', 'all']).optional().default('all'),
    },
    async ({ application, namespace, deployment, region, from, to, metricType }) => {
      const targetRegions = region
        ? [region]
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const ns = namespace || application;
      const deploy = deployment || `${application}-api`;

      // For Metrics API only — needs absolute ISO timestamps
      const startTime = parseTimeString(from);
      const endTime = parseTimeString(to);

      const metrics: Record<string, unknown> = {};

      for (const reg of targetRegions) {
        try {
          const logClient = getClient(reg);
          const metricsClient = getMetricsClient(reg);
          const cluster = getClusterName(reg);
          let partition: string;
          try {
            partition = getPartition(reg);
          } catch {
            partition = '';
          }
          const regionMetrics: Record<string, unknown> = {};

          // ========================================
          // METRICS API: Memory (in MB)
          // ========================================
          if (metricType === 'memory' || metricType === 'all') {
            const memoryQuery = `cluster="${cluster}" deployment="${deploy}" namespace="${ns}" metric=container_memory_working_set_bytes`;

            try {
              const memoryResult = await metricsClient.queryMetrics({
                query: memoryQuery,
                startTime,
                endTime,
                rollup: 'avg',
              });

              if (memoryResult.response?.[0]?.results?.length > 0) {
                const datapoints = memoryResult.response[0].results[0].datapoints;
                const valuesInMB = datapoints.value.map(v => v / (1024 * 1024));
                const stats = calculateStats(valuesInMB);

                regionMetrics.memory = {
                  unit: 'MB',
                  avg: stats.avg.toFixed(2),
                  min: stats.min.toFixed(2),
                  max: stats.max.toFixed(2),
                  latest: stats.latest.toFixed(2),
                  dataPoints: datapoints.value.length,
                  query: memoryQuery,
                };
              } else {
                regionMetrics.memory = { message: 'No memory metrics found', query: memoryQuery };
              }
            } catch (e) {
              regionMetrics.memory = { error: (e as Error).message, query: memoryQuery };
            }
          }

          // ========================================
          // METRICS API: CPU (in cores)
          // ========================================
          if (metricType === 'cpu' || metricType === 'all') {
            const cpuQuery = `cluster="${cluster}" namespace="${ns}" deployment="${deploy}" metric=container_cpu_usage_seconds_total | rate`;

            try {
              const cpuResult = await metricsClient.queryMetrics({
                query: cpuQuery,
                startTime,
                endTime,
                rollup: 'avg',
              });

              if (cpuResult.response?.[0]?.results?.length > 0) {
                const datapoints = cpuResult.response[0].results[0].datapoints;
                const stats = calculateStats(datapoints.value);

                regionMetrics.cpu = {
                  unit: 'cores',
                  avg: stats.avg.toFixed(4),
                  min: stats.min.toFixed(4),
                  max: stats.max.toFixed(4),
                  latest: stats.latest.toFixed(4),
                  dataPoints: datapoints.value.length,
                  query: cpuQuery,
                };
              } else {
                regionMetrics.cpu = { message: 'No CPU metrics found', query: cpuQuery };
              }
            } catch (e) {
              regionMetrics.cpu = { error: (e as Error).message, query: cpuQuery };
            }
          }

          // ========================================
          // LOG API: Latency (cluster → partition → sourceCategory fallback)
          // ========================================
          if (metricType === 'latency' || metricType === 'all') {
            const latencyQueryPart = [
              '| parse regex "(?:duration|latency|response_time|elapsed|took)[=:\\\\s]*(?<latency_ms>\\\\d+)" nodrop',
              '| where !isNull(latency_ms)',
              '| num(latency_ms)',
              '| avg(latency_ms) as avg_latency_ms,',
              '  max(latency_ms) as max_latency_ms,',
              '  min(latency_ms) as min_latency_ms,',
              '  pct(latency_ms, 50) as p50_ms,',
              '  pct(latency_ms, 95) as p95_ms,',
              '  pct(latency_ms, 99) as p99_ms',
            ].join(' ');

            try {
              const { result: latencyResult, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, latencyQueryPart, { from, to }
              );

              if (latencyResult.records && latencyResult.records.length > 0) {
                regionMetrics.latency = {
                  ...latencyResult.records[0].map,
                  unit: 'ms',
                  querySource,
                };
              } else {
                regionMetrics.latency = { message: 'No latency data found in logs', querySource };
              }
            } catch (e) {
              regionMetrics.latency = { error: (e as Error).message };
            }
          }

          // ========================================
          // LOG API: Throughput (cluster → partition → sourceCategory fallback)
          // ========================================
          if (metricType === 'throughput' || metricType === 'all') {
            const throughputQueryPart = [
              '| where _raw matches "*request*" OR _raw matches "*HTTP*" OR _raw matches "*GET*" OR _raw matches "*POST*"',
              '| timeslice 1m',
              '| count by _timeslice',
              '| avg(_count) as avg_rpm,',
              '  max(_count) as peak_rpm,',
              '  sum(_count) as total_requests',
            ].join(' ');

            try {
              const { result: throughputResult, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, throughputQueryPart, { from, to }
              );

              if (throughputResult.records && throughputResult.records.length > 0) {
                regionMetrics.throughput = {
                  ...throughputResult.records[0].map,
                  unit: 'requests',
                  querySource,
                };
              } else {
                regionMetrics.throughput = { message: 'No throughput data found', querySource };
              }
            } catch (e) {
              regionMetrics.throughput = { error: (e as Error).message };
            }
          }

          // ========================================
          // LOG API: Error Rate (cluster → partition → sourceCategory fallback)
          // ========================================
          if (metricType === 'error_rate' || metricType === 'all') {
            const errorRateQueryPart = [
              '| if(level = "ERROR" OR level = "error" OR _loglevel = "ERROR" OR _raw matches "*error*" OR _raw matches "*ERROR*", 1, 0) as is_error',
              '| sum(is_error) as error_count,',
              '  count as total_count',
              '| error_count / total_count * 100 as error_rate_percent',
            ].join(' ');

            try {
              const { result: errorRateResult, querySource } = await searchWithFallback(
                logClient, partition, cluster, ns, errorRateQueryPart, { from, to }
              );

              if (errorRateResult.records && errorRateResult.records.length > 0) {
                const record = errorRateResult.records[0].map;
                regionMetrics.errorRate = {
                  errorCount: record.error_count,
                  totalCount: record.total_count,
                  errorRatePercent: record.error_rate_percent,
                  unit: '%',
                  querySource,
                };
              } else {
                regionMetrics.errorRate = { message: 'No error rate data found', querySource };
              }
            } catch (e) {
              regionMetrics.errorRate = { error: (e as Error).message };
            }
          }

          metrics[reg] = {
            cluster,
            partition: partition || 'N/A',
            namespace: ns,
            deployment: deploy,
            ...regionMetrics,
          };
        } catch (error) {
          metrics[reg] = { error: (error as Error).message };
        }
      }

      const summary = generateMetricsSummary(metrics);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            application,
            namespace: ns,
            deployment: deploy,
            timeRange: { from, to },
            metricType,
            summary,
            regionDetails: metrics,
          }, null, 2),
        }],
      };
    }
  );
}

function generateMetricsSummary(metrics: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    regionsAnalyzed: Object.keys(metrics).length,
    healthStatus: '🟢 healthy',
    alerts: [] as string[],
  };

  const alerts: string[] = [];

  for (const [region, data] of Object.entries(metrics)) {
    const regionData = data as Record<string, unknown>;

    const memory = regionData.memory as Record<string, unknown> | undefined;
    if (memory && !memory.error && !memory.message) {
      const avgMemory = parseFloat(String(memory.avg || memory.latest || 0));
      if (avgMemory > 4000) {
        alerts.push(`🔴 Critical memory in ${region}: ${avgMemory.toFixed(0)} MB`);
        summary.healthStatus = '🔴 critical';
      } else if (avgMemory > 2000) {
        alerts.push(`⚠️ High memory in ${region}: ${avgMemory.toFixed(0)} MB`);
        if (summary.healthStatus !== '🔴 critical') summary.healthStatus = '🟡 warning';
      }
    }

    const cpu = regionData.cpu as Record<string, unknown> | undefined;
    if (cpu && !cpu.error && !cpu.message) {
      const avgCpu = parseFloat(String(cpu.avg || cpu.latest || 0));
      if (avgCpu > 0.9) {
        alerts.push(`🔴 Critical CPU in ${region}: ${(avgCpu * 100).toFixed(1)}%`);
        summary.healthStatus = '🔴 critical';
      } else if (avgCpu > 0.7) {
        alerts.push(`⚠️ High CPU in ${region}: ${(avgCpu * 100).toFixed(1)}%`);
        if (summary.healthStatus !== '🔴 critical') summary.healthStatus = '🟡 warning';
      }
    }

    const errorRate = regionData.errorRate as Record<string, unknown> | undefined;
    if (errorRate && errorRate.errorRatePercent && !errorRate.error) {
      const rate = parseFloat(String(errorRate.errorRatePercent));
      if (rate > 5) {
        alerts.push(`🔴 High error rate in ${region}: ${rate.toFixed(2)}%`);
        summary.healthStatus = '🔴 critical';
      } else if (rate > 1) {
        alerts.push(`🟡 Elevated error rate in ${region}: ${rate.toFixed(2)}%`);
        if (summary.healthStatus !== '🔴 critical') summary.healthStatus = '🟡 warning';
      }
    }
  }

  summary.alerts = alerts.length > 0 ? alerts : ['✅ All systems healthy'];
  return summary;
}