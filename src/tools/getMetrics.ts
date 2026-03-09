import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMetricsClient } from '../lib/sumologic/metricsClientFactory.js';
import { getProdRegions, getConfiguredRegions, getClusterName } from '../config/regions.js';
import moment from 'moment';

/**
 * Parse time strings into ISO 8601 UTC format for Metrics API.
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

export function registerGetMetricsTool(server: McpServer): void {
  server.tool(
    'get_metrics',
    'Get Kubernetes resource metrics (CPU, memory) for deployments using Sumo Logic Metrics API. Use this for resource utilization, infra health, container sizing. When no deployment is specified, returns metrics for ALL deployments in the namespace. For latency, throughput, error rates, use get_performance_metrics instead.',
    {
      application: z.string().describe('Application/service name (e.g., okrs, roadmaps, logbook)'),
      namespace: z.string().optional().describe('Kubernetes namespace (defaults to application name)'),
      deployment: z.string().optional().describe('Specific deployment name (e.g., okrs-api, hasura). Omit to get metrics for ALL deployments in the namespace'),
      region: z.string().optional().describe('Specific region or omit for all prod regions'),
      from: z.string().describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z.string().describe('End time (e.g., now)'),
      metricType: z.enum(['memory', 'cpu', 'all']).optional().default('all'),
    },
    async ({ application, namespace, deployment, region, from, to, metricType }) => {
      const targetRegions = region
        ? [region]
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const ns = namespace || application;

      const startTime = parseTimeString(from);
      const endTime = parseTimeString(to);

      const metrics: Record<string, unknown> = {};

      for (const reg of targetRegions) {
        try {
          const metricsClient = getMetricsClient(reg);
          const cluster = getClusterName(reg);

          // If deployment specified, query just that one; otherwise query all in namespace
          const deployFilter = deployment ? `deployment="${deployment}"` : `deployment=*`;

          const regionMetrics: Record<string, Record<string, unknown>> = {};

          // ========================================
          // Memory (in MB) — grouped by deployment
          // ========================================
          if (metricType === 'memory' || metricType === 'all') {
            const memoryQuery = `cluster="${cluster}" ${deployFilter} namespace="${ns}" metric=container_memory_working_set_bytes | avg by deployment`;

            try {
              const memoryResult = await metricsClient.queryMetrics({
                query: memoryQuery,
                startTime,
                endTime,
                rollup: 'avg',
              });

              if (memoryResult.response?.[0]?.results?.length > 0) {
                for (const result of memoryResult.response[0].results) {
                  const deployName = result.metric?.dimensions?.find(
                    (d: any) => d.key === 'deployment'
                  )?.value || 'unknown';

                  if (!regionMetrics[deployName]) regionMetrics[deployName] = {};

                  const datapoints = result.datapoints;
                  const valuesInMB = datapoints.value.map((v: number) => v / (1024 * 1024));
                  const stats = calculateStats(valuesInMB);

                  regionMetrics[deployName].memory = {
                    unit: 'MB',
                    avg: stats.avg.toFixed(2),
                    min: stats.min.toFixed(2),
                    max: stats.max.toFixed(2),
                    latest: stats.latest.toFixed(2),
                    dataPoints: datapoints.value.length,
                  };
                }
              }
            } catch (e) {
              // If grouped query fails, store error at region level
              regionMetrics['_error_memory'] = { memory: { error: (e as Error).message } };
            }
          }

          // ========================================
          // CPU (in cores) — grouped by deployment
          // ========================================
          if (metricType === 'cpu' || metricType === 'all') {
            const cpuQuery = `cluster="${cluster}" namespace="${ns}" ${deployFilter} metric=container_cpu_usage_seconds_total | rate | avg by deployment`;

            try {
              const cpuResult = await metricsClient.queryMetrics({
                query: cpuQuery,
                startTime,
                endTime,
                rollup: 'avg',
              });

              if (cpuResult.response?.[0]?.results?.length > 0) {
                for (const result of cpuResult.response[0].results) {
                  const deployName = result.metric?.dimensions?.find(
                    (d: any) => d.key === 'deployment'
                  )?.value || 'unknown';

                  if (!regionMetrics[deployName]) regionMetrics[deployName] = {};

                  const datapoints = result.datapoints;
                  const stats = calculateStats(datapoints.value);

                  regionMetrics[deployName].cpu = {
                    unit: 'cores',
                    avg: stats.avg.toFixed(4),
                    min: stats.min.toFixed(4),
                    max: stats.max.toFixed(4),
                    latest: stats.latest.toFixed(4),
                    dataPoints: datapoints.value.length,
                  };
                }
              }
            } catch (e) {
              regionMetrics['_error_cpu'] = { cpu: { error: (e as Error).message } };
            }
          }

          // Clean up error-only keys
          const cleanMetrics: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(regionMetrics)) {
            if (!key.startsWith('_error_')) cleanMetrics[key] = val;
            else Object.assign(cleanMetrics, val);
          }

          metrics[reg] = {
            cluster,
            namespace: ns,
            deploymentsFound: Object.keys(cleanMetrics).filter(k => !k.startsWith('_')),
            deployments: cleanMetrics,
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
            deployment: deployment || 'all (auto-discovered)',
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
    if (regionData.error) continue;

    const deployments = regionData.deployments as Record<string, Record<string, unknown>> | undefined;
    if (!deployments) continue;

    for (const [deployName, deployData] of Object.entries(deployments)) {
      const memory = deployData.memory as Record<string, unknown> | undefined;
      if (memory && !memory.error && !memory.message) {
        const avgMemory = parseFloat(String(memory.avg || memory.latest || 0));
        if (avgMemory > 4000) {
          alerts.push(`🔴 Critical memory in ${region}/${deployName}: ${avgMemory.toFixed(0)} MB`);
          summary.healthStatus = '🔴 critical';
        } else if (avgMemory > 2000) {
          alerts.push(`⚠️ High memory in ${region}/${deployName}: ${avgMemory.toFixed(0)} MB`);
          if (summary.healthStatus !== '🔴 critical') summary.healthStatus = '🟡 warning';
        }
      }

      const cpu = deployData.cpu as Record<string, unknown> | undefined;
      if (cpu && !cpu.error && !cpu.message) {
        const avgCpu = parseFloat(String(cpu.avg || cpu.latest || 0));
        if (avgCpu > 0.9) {
          alerts.push(`🔴 Critical CPU in ${region}/${deployName}: ${(avgCpu * 100).toFixed(1)}%`);
          summary.healthStatus = '🔴 critical';
        } else if (avgCpu > 0.7) {
          alerts.push(`⚠️ High CPU in ${region}/${deployName}: ${(avgCpu * 100).toFixed(1)}%`);
          if (summary.healthStatus !== '🔴 critical') summary.healthStatus = '🟡 warning';
        }
      }
    }
  }

  summary.alerts = alerts.length > 0 ? alerts : ['✅ All systems healthy'];
  return summary;
}