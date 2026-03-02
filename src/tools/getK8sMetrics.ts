import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMetricsClient } from '../lib/sumologic/metricsClientFactory.js';
import { getConfiguredRegions, getClusterName } from '../config/regions.js';
import moment from 'moment';

function parseTimeString(timeStr: string): string {
  if (timeStr === 'now') {
    return moment().toISOString();
  }
  const relativeMatch = timeStr.match(/^-(\d+)([mhd])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    switch (unit) {
      case 'm': return moment().subtract(value, 'minutes').toISOString();
      case 'h': return moment().subtract(value, 'hours').toISOString();
      case 'd': return moment().subtract(value, 'days').toISOString();
    }
  }
  return timeStr;
}

function calculateStats(values: number[]): { avg: number; min: number; max: number; latest: number } {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, latest: 0 };
  const validValues = values.filter(v => v !== null && !isNaN(v));
  if (validValues.length === 0) return { avg: 0, min: 0, max: 0, latest: 0 };
  
  return {
    avg: validValues.reduce((a, b) => a + b, 0) / validValues.length,
    min: Math.min(...validValues),
    max: Math.max(...validValues),
    latest: validValues[validValues.length - 1],
  };
}

export function registerGetK8sMetricsTool(server: McpServer): void {
  server.tool(
    'get_k8s_metrics',
    'Get Kubernetes resource metrics (CPU, memory) for a deployment using Sumo Logic Metrics API',
    {
      namespace: z.string().describe('Kubernetes namespace (e.g., okrs, roadmaps, logbook)'),
      deployment: z.string().describe('Deployment name (e.g., okrs-api, roadmaps-api)'),
      region: z.string().describe(`Region. Available: ${getConfiguredRegions().join(', ')}`),
      metric: z.enum(['memory', 'cpu', 'all']).optional().default('all'),
      from: z.string().optional().default('-1h').describe('Start time (e.g., -1h, -24h, -15m)'),
      to: z.string().optional().default('now').describe('End time (e.g., now)'),
    },
    async ({ namespace, deployment, region, metric, from, to }) => {
      try {
        const metricsClient = getMetricsClient(region);
        const cluster = getClusterName(region);

        const startTime = parseTimeString(from || '-1h');
        const endTime = parseTimeString(to || 'now');

        const results: Record<string, unknown> = {
          cluster,
          namespace,
          deployment,
          region,
          timeRange: { from: startTime, to: endTime },
        };

        // Memory Metrics (in MB)
        if (metric === 'memory' || metric === 'all') {
          const memoryQuery = `cluster="${cluster}" namespace="${namespace}" deployment="${deployment}" metric=container_memory_working_set_bytes`;
          
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
              
              results.memory = {
                unit: 'MB',
                average: stats.avg.toFixed(2),
                min: stats.min.toFixed(2),
                max: stats.max.toFixed(2),
                latest: stats.latest.toFixed(2),
                dataPointCount: datapoints.value.length,
                query: memoryQuery,
              };
            } else {
              results.memory = { message: 'No memory metrics found', query: memoryQuery };
            }
          } catch (e) {
            results.memory = { error: (e as Error).message, query: memoryQuery };
          }
        }

        // CPU Metrics (in cores)
        if (metric === 'cpu' || metric === 'all') {
          const cpuQuery = `cluster="${cluster}" namespace="${namespace}" deployment="${deployment}" metric=container_cpu_usage_seconds_total | rate`;
          
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
              
              results.cpu = {
                unit: 'cores',
                average: stats.avg.toFixed(4),
                min: stats.min.toFixed(4),
                max: stats.max.toFixed(4),
                latest: stats.latest.toFixed(4),
                dataPointCount: datapoints.value.length,
                query: cpuQuery,
              };
            } else {
              results.cpu = { message: 'No CPU metrics found', query: cpuQuery };
            }
          } catch (e) {
            results.cpu = { error: (e as Error).message, query: cpuQuery };
          }
        }

        // Generate health summary
        const summary = generateHealthSummary(results);
        results.summary = summary;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(results, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

function generateHealthSummary(results: Record<string, unknown>): Record<string, unknown> {
  const alerts: string[] = [];
  let status = '🟢 Healthy';

  const memory = results.memory as Record<string, unknown> | undefined;
  if (memory && memory.latest && !memory.error) {
    const memoryMB = parseFloat(String(memory.latest));
    if (memoryMB > 2000) {
      alerts.push(`⚠️ High memory usage: ${memoryMB.toFixed(0)} MB`);
      status = '🟡 Warning';
    }
    if (memoryMB > 4000) {
      alerts.push(`🔴 Critical memory usage: ${memoryMB.toFixed(0)} MB`);
      status = '🔴 Critical';
    }
  }

  const cpu = results.cpu as Record<string, unknown> | undefined;
  if (cpu && cpu.latest && !cpu.error) {
    const cpuCores = parseFloat(String(cpu.latest));
    if (cpuCores > 0.8) {
      alerts.push(`⚠️ High CPU usage: ${(cpuCores * 100).toFixed(1)}%`);
      if (status !== '🔴 Critical') status = '🟡 Warning';
    }
    if (cpuCores > 0.95) {
      alerts.push(`🔴 Critical CPU usage: ${(cpuCores * 100).toFixed(1)}%`);
      status = '🔴 Critical';
    }
  }

  return {
    status,
    alerts: alerts.length > 0 ? alerts : ['No issues detected'],
  };
}