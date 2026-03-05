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
// Fallback search: cluster → partition → sourceCategory
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
  // Strategy 1: cluster + namespace + deployment
  const clusterScope = `cluster="${cluster}" namespace=${namespace} deployment=${deployment} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;
  try {
    const result = await search(client, clusterQuery, options);
    if (result.messageCount > 0 || result.recordCount > 0) {
      return { result, querySource: 'cluster', queryUsed: clusterQuery };
    }
  } catch (e) {
    console.error(`[SummarizeLogs] Cluster query failed: ${(e as Error).message}`);
  }

  // Strategy 2: partition index
  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace} deployment=${deployment} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;
    try {
      const result = await search(client, partitionQuery, options);
      if (result.messageCount > 0 || result.recordCount > 0) {
        return { result, querySource: 'partition', queryUsed: partitionQuery };
      }
    } catch (e) {
      console.error(`[SummarizeLogs] Partition query failed: ${(e as Error).message}`);
    }
  }

  // Strategy 3: sourceCategory
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
].join(' ');

// ──────────────────────────────────────────────────────────
// Query builders
// ──────────────────────────────────────────────────────────

/** Lists actual log messages (mirrors your Sumo UI query exactly) */
function buildListLogsQuery(limit: number): string {
  return [
    JSON_LOG_PARSE,
    '| count by deployment, msg, _messageTime',
    '| sort _messageTime desc',
    '| fields - _messageTime, _count',
    `| limit ${limit}`,
  ].join(' ');
}

/** Log level distribution */
function buildLogLevelDistributionQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| parse regex field=msg "(?<log_level>(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL))" nodrop',
    '| if(isNull(log_level), "UNKNOWN", log_level) as log_level',
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
    '| parse regex field=msg "(?<log_level>(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL))" nodrop',
    '| if(isNull(log_level), "UNKNOWN", log_level) as log_level',
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
    'Get a comprehensive log summary including actual log listing, log level distribution, top errors, and log volume over time. Supports cluster, partition, and sourceCategory fallback.',
    {
      application: z
        .string()
        .describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z
        .string()
        .optional()
        .describe('Deployment name (e.g., okrs-api). Defaults to <application>-api'),
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
        .enum(['list_logs', 'summary', 'top_errors', 'log_volume', 'all'])
        .optional()
        .default('all')
        .describe('What to fetch: list_logs (raw messages), summary (level distribution), top_errors, log_volume (timeseries), or all'),
      logLevel: z
        .enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'ALL'])
        .optional()
        .default('ALL')
        .describe('Filter by log level (only for list_logs mode)'),
      timeslice: z
        .string()
        .optional()
        .default('1h')
        .describe('Time bucket for log_volume timeseries'),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Max number of log entries / error groups to return'),
    },
    async ({ application, deployment, region, from, to, mode, logLevel, timeslice, limit }) => {
      const deploy = deployment || `${application}-api`;
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

          // ── List Logs (mirrors your exact Sumo UI query) ──
          if (mode === 'list_logs' || mode === 'all') {
            try {
              let queryPart = buildListLogsQuery(limit);
              // Apply log level filter if specified
              if (logLevel !== 'ALL') {
                queryPart = queryPart.replace(
                  '| count by deployment, msg, _messageTime',
                  `| where msg matches "*${logLevel}*" | count by deployment, msg, _messageTime`,
                );
              }

              const { result, querySource, queryUsed } = await searchWithFallback(
                client, partition, cluster, ns, deploy, queryPart, searchOpts,
              );

              const data = result.records?.length ? result.records : result.messages || [];
              regionData.logs = {
                entries: data.map((r) => ({
                  deployment: r.map?.deployment,
                  message: r.map?.msg?.substring(0, 1000),
                })),
                count: data.length,
                querySource,
                queryUsed,
              };
            } catch (e) {
              regionData.logs = { error: (e as Error).message };
            }
          }

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
            partition: partition || 'N/A',
            namespace: ns,
            deployment: deploy,
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
                deployment: deploy,
                timeRange: { from, to },
                mode,
                overallSummary: {
                  totalLogs: totalLogsAllRegions,
                  totalErrors: overallErrors,
                  criticalRegions,
                  regionsAnalyzed: targetRegions.length,
                  regionsWithData: Object.keys(allResults).filter(
                    (r) => !allResults[r].error,
                  ).length,
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