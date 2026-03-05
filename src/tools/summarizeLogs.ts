import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search, type SearchResult } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import {
  getProdRegions,
  getConfiguredRegions,
  getPartition,
  getClusterName,
} from '../config/regions.js';
import type { Client } from '../lib/sumologic/types.js';

// ──────────────────────────────────────────────────────────
// Comprehensive search: cluster + partition combined, sourceCategory fallback
// ──────────────────────────────────────────────────────────

async function searchWithFallback(
  client: Client,
  partition: string,
  cluster: string,
  namespace: string,
  deployment: string,
  queryPart: string,
  options: { from: string; to: string },
): Promise<{ result: SearchResult; querySource: string; queryUsed: string }> {
  // Build scope: if deployment is provided, filter by it; otherwise get all deployments in namespace
  const deployFilter = deployment ? ` deployment=${deployment}` : '';

  // Strategy 1: Try BOTH cluster and partition to get complete data
  // Some deployments may only appear in one or the other
  const clusterScope = `cluster="${cluster}" namespace=${namespace}${deployFilter} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;

  let clusterResult: SearchResult | null = null;
  let partitionResult: SearchResult | null = null;

  // Try cluster
  try {
    clusterResult = await search(client, clusterQuery, options);
  } catch (e) {
    console.error(`[SummarizeLogs] Cluster query failed: ${(e as Error).message}`);
  }

  // Try partition (always try, not just as fallback)
  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace}${deployFilter} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;
    try {
      partitionResult = await search(client, partitionQuery, options);
    } catch (e) {
      console.error(`[SummarizeLogs] Partition query failed: ${(e as Error).message}`);
    }
  }

  // Pick the result with more data (cluster and partition may have different coverage)
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

  // Strategy 2: sourceCategory fallback (last resort)
  const sourceCatQuery = `_sourceCategory=*${namespace}* ${queryPart}`;
  try {
    const result = await search(client, sourceCatQuery, options);
    return { result, querySource: 'sourceCategory', queryUsed: sourceCatQuery };
  } catch (e) {
    console.error(`[SummarizeLogs] SourceCategory query failed: ${(e as Error).message}`);
  }

  return {
    result: { messages: [], records: [], messageCount: 0, recordCount: 0 },
    querySource: 'none (all strategies failed)',
    queryUsed: clusterQuery,
  };
}

// ──────────────────────────────────────────────────────────
// Common JSON log parsing prefix
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
// Query builders
// ──────────────────────────────────────────────────────────

/** Log level distribution */
function buildLogLevelDistributionQuery(): string {
  return [
    JSON_LOG_PARSE,
    // Try JSON "level" field first (Hasura, structured logs), then regex from message
    '| json field=msg "level" as json_level nodrop',
    '| parse regex field=msg "(?<regex_level>(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL))" nodrop',
    '| if(!isNull(json_level), toUpperCase(json_level), regex_level) as log_level',
    '| if(isNull(log_level) or log_level = "", "UNKNOWN", log_level) as log_level',
    '| count by log_level',
    '| order by _count desc',
  ].join(' ');
}

/** Top error messages grouped and ranked */
function buildTopErrorsQuery(limit: number): string {
  return [
    JSON_LOG_PARSE,
    '| where msg matches "*ERROR*" or msg matches "*error*" or msg matches "*Exception*" or msg matches "*FATAL*"',
    '| count by msg',
    '| order by _count desc',
    `| limit ${limit}`,
  ].join(' ');
}

/** Log volume over time */
function buildLogVolumeTimeseriesQuery(timeslice: string): string {
  return [
    JSON_LOG_PARSE,
    '| json field=msg "level" as json_level nodrop',
    '| parse regex field=msg "(?<regex_level>(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL))" nodrop',
    '| if(!isNull(json_level), toUpperCase(json_level), regex_level) as log_level',
    '| if(isNull(log_level) or log_level = "", "UNKNOWN", log_level) as log_level',
    `| timeslice ${timeslice}`,
    '| count by _timeslice, log_level',
    '| sort _timeslice asc',
  ].join(' ');
}

/** Total log count */
function buildTotalCountQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| count as total_logs',
  ].join(' ');
}

// ──────────────────────────────────────────────────────────
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerSummarizeLogsTool(server: McpServer): void {
  server.tool(
    'summarize_logs',
    'Get a comprehensive log summary including log level distribution, top errors, and log volume over time. Supports cluster, partition, and sourceCategory fallback. Use list_logs tool to list actual log entries.',
    {
      application: z
        .string()
        .describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z
        .string()
        .optional()
        .describe('Deployment name (e.g., okrs-api, okrs-worker). Omit to summarize ALL deployments in the namespace'),
      region: z
        .string()
        .optional()
        .describe('Specific region (e.g., aps2-prod) or omit for all prod regions'),
      from: z
        .string()
        .optional()
        .default('-24h')
        .describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z
        .string()
        .optional()
        .default('now')
        .describe('End time'),
      mode: z
        .enum(['summary', 'top_errors', 'log_volume', 'all'])
        .optional()
        .default('all')
        .describe('What to fetch: summary (level distribution), top_errors, log_volume (timeseries), or all'),
      timeslice: z
        .string()
        .optional()
        .default('1h')
        .describe('Time bucket for log_volume timeseries'),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Max number of error groups to return'),
    },
    async ({ application, deployment, region, from, to, mode, timeslice, limit }) => {
      const deploy = deployment || '';  // empty = all deployments in namespace
      const ns = application;
      const targetRegions = region
        ? [region]
        : getProdRegions().filter((r) => getConfiguredRegions().includes(r));

      const allResults: Record<string, Record<string, unknown>> = {};

      for (const reg of targetRegions) {
        const regionData: Record<string, unknown> = {};

        try {
          const client = getClient(reg);
          const cluster = getClusterName(reg);
          let partition: string;
          try {
            partition = getPartition(reg);
          } catch {
            partition = '';
          }

          const searchOpts = { from: from || '-24h', to: to || 'now' };

          // ── Log Level Distribution ──
          if (mode === 'summary' || mode === 'all') {
            try {
              const queryPart = buildLogLevelDistributionQuery();
              const { result, querySource } = await searchWithFallback(
                client, partition, cluster, ns, deploy, queryPart, searchOpts,
              );

              const data = result.records?.length ? result.records : result.messages || [];
              const distribution = data.map((r) => ({
                level: r.map?.log_level,
                count: parseInt(r.map?._count || '0'),
              }));

              const totalLogs = distribution.reduce((acc, d) => acc + d.count, 0);
              const errorCount = distribution
                .filter((d) => d.level === 'ERROR' || d.level === 'FATAL')
                .reduce((acc, d) => acc + d.count, 0);
              const warnCount = distribution
                .filter((d) => d.level === 'WARN' || d.level === 'WARNING')
                .reduce((acc, d) => acc + d.count, 0);

              regionData.summary = {
                totalLogs,
                errorCount,
                warnCount,
                errorRate: totalLogs > 0 ? `${((errorCount / totalLogs) * 100).toFixed(2)}%` : '0%',
                distribution,
                healthStatus:
                  errorCount > 100 ? 'critical' : errorCount > 10 ? 'warning' : 'healthy',
                querySource,
              };
            } catch (e) {
              regionData.summary = { error: (e as Error).message };
            }
          }

          // ── Top Errors ──
          if (mode === 'top_errors' || mode === 'all') {
            try {
              const queryPart = buildTopErrorsQuery(limit);
              const { result, querySource } = await searchWithFallback(
                client, partition, cluster, ns, deploy, queryPart, searchOpts,
              );

              const data = result.records?.length ? result.records : result.messages || [];
              regionData.topErrors = {
                errors: data.map((r) => ({
                  message: r.map?.msg?.substring(0, 500),
                  occurrences: parseInt(r.map?._count || '0'),
                })),
                uniqueErrorPatterns: data.length,
                querySource,
              };
            } catch (e) {
              regionData.topErrors = { error: (e as Error).message };
            }
          }

          // ── Log Volume Timeseries ──
          if (mode === 'log_volume' || mode === 'all') {
            try {
              const queryPart = buildLogVolumeTimeseriesQuery(timeslice);
              const { result, querySource } = await searchWithFallback(
                client, partition, cluster, ns, deploy, queryPart, searchOpts,
              );

              const data = result.records?.length ? result.records : result.messages || [];
              regionData.logVolume = {
                timeseries: data.map((r) => r.map),
                dataPoints: data.length,
                timeslice,
                querySource,
              };
            } catch (e) {
              regionData.logVolume = { error: (e as Error).message };
            }
          }

          // ── Total Count ──
          if (mode === 'summary' || mode === 'all') {
            try {
              const queryPart = buildTotalCountQuery();
              const { result, querySource } = await searchWithFallback(
                client, partition, cluster, ns, deploy, queryPart, searchOpts,
              );

              const data = result.records?.length ? result.records : result.messages || [];
              if (data.length > 0) {
                regionData.totalCount = {
                  total: parseInt(data[0].map?.total_logs || '0'),
                  querySource,
                };
              }
            } catch (e) {
              regionData.totalCount = { error: (e as Error).message };
            }
          }

          allResults[reg] = {
            cluster,
            namespace: ns,
            deployment: deploy || 'all',
            ...regionData,
          };
        } catch (error) {
          allResults[reg] = { error: (error as Error).message };
        }
      }

      // ── Overall Summary ──
      const overallErrors = Object.values(allResults).reduce((acc, s: any) => {
        return acc + (s.summary?.errorCount || 0);
      }, 0);

      const criticalRegions = Object.entries(allResults)
        .filter(([_, s]: [string, any]) => s.summary?.healthStatus === 'critical')
        .map(([r]) => r);

      const totalLogsAllRegions = Object.values(allResults).reduce((acc, s: any) => {
        return acc + (s.totalCount?.total || s.summary?.totalLogs || 0);
      }, 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                application: ns,
                deployment: deploy || 'all',
                timeRange: { from, to },
                overallSummary: {
                  totalLogs: totalLogsAllRegions,
                  totalErrors: overallErrors,
                  criticalRegions,
                },
                regionDetails: allResults,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}