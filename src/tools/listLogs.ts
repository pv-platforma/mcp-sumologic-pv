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
  const deployFilter = deployment ? ` deployment=${deployment}` : '';

  const clusterScope = `cluster="${cluster}" namespace=${namespace}${deployFilter} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;

  let clusterResult: SearchResult | null = null;
  let partitionResult: SearchResult | null = null;

  try {
    clusterResult = await search(client, clusterQuery, options);
  } catch (e) {
    console.error(`[ListLogs] Cluster query failed: ${(e as Error).message}`);
  }

  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace}${deployFilter} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;
    try {
      partitionResult = await search(client, partitionQuery, options);
    } catch (e) {
      console.error(`[ListLogs] Partition query failed: ${(e as Error).message}`);
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

  const sourceCatQuery = `_sourceCategory=*${namespace}* ${queryPart}`;
  try {
    const result = await search(client, sourceCatQuery, options);
    return { result, querySource: 'sourceCategory', queryUsed: sourceCatQuery };
  } catch (e) {
    console.error(`[ListLogs] SourceCategory query failed: ${(e as Error).message}`);
  }

  return {
    result: { messages: [], records: [], messageCount: 0, recordCount: 0 },
    querySource: 'none (all strategies failed)',
    queryUsed: clusterQuery,
  };
}

// ──────────────────────────────────────────────────────────
// Common JSON log parsing prefix — filters out all health check noise
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
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerListLogsTool(server: McpServer): void {
  server.tool(
    'list_logs',
    'List raw log entries from application deployments. Returns actual log messages sorted by time. Filters out health checks, kube-probes, and monitoring noise. Use this when asked to "list", "show", or "get" logs.',
    {
      application: z
        .string()
        .describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z
        .string()
        .optional()
        .describe('Deployment name (e.g., okrs-api, logbook-odata). Omit to list logs from ALL deployments in the namespace'),
      region: z
        .string()
        .optional()
        .describe('Specific region (e.g., aps2-prod) or omit for all prod regions'),
      from: z
        .string()
        .optional()
        .default('-1h')
        .describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z
        .string()
        .optional()
        .default('now')
        .describe('End time'),
      logLevel: z
        .enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'ALL'])
        .optional()
        .default('ALL')
        .describe('Filter by log level'),
      limit: z
        .number()
        .optional()
        .describe('Max number of log entries to return. Defaults to 200 for namespace-wide queries, 50 for specific deployments'),
    },
    async ({ application, deployment, region, from, to, logLevel, limit }) => {
      // Dynamic default: 200 for whole namespace, 50 for specific deployment
      const effectiveLimit = limit ?? (deployment ? 50 : 200);
      const deploy = deployment || '';
      const ns = application;
      const targetRegions = region
        ? [region]
        : getProdRegions().filter((r) => getConfiguredRegions().includes(r));

      const allResults: Record<string, Record<string, unknown>> = {};

      for (const reg of targetRegions) {
        try {
          const client = getClient(reg);
          const cluster = getClusterName(reg);
          let partition: string;
          try {
            partition = getPartition(reg);
          } catch {
            partition = '';
          }

          const searchOpts = { from: from || '-1h', to: to || 'now' };

          // Build log listing query
          let queryPart = [
            JSON_LOG_PARSE,
            // Parse log level from JSON "level" field or from message text
            '| json field=msg "level" as json_level nodrop',
            '| parse regex field=msg "(?<regex_level>(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL))" nodrop',
            '| if(!isNull(json_level), toUpperCase(json_level), regex_level) as log_level',
          ].join(' ');

          // Apply log level filter if specified
          if (logLevel !== 'ALL') {
            queryPart += ` | where log_level = "${logLevel}"`;
          }

          queryPart += [
            '',
            '| count by deployment, msg, log_level, _messageTime',
            '| sort _messageTime desc',
            '| fields deployment, log_level, msg',
            `| limit ${effectiveLimit}`,
          ].join(' ');

          const { result, querySource } = await searchWithFallback(
            client, partition, cluster, ns, deploy, queryPart, searchOpts,
          );

          const data = result.records?.length ? result.records : result.messages || [];

          // Detect unique deployments in the results
          const deployments = new Set<string>();
          const entries = data.map((r) => {
            const dep = r.map?.deployment || 'unknown';
            deployments.add(dep);
            return {
              deployment: dep,
              level: r.map?.log_level || '',
              message: r.map?.msg?.substring(0, 500),
            };
          });

          allResults[reg] = {
            cluster,
            namespace: ns,
            deployment: deploy || 'all',
            deploymentsFound: Array.from(deployments),
            deploymentCount: deployments.size,
            logs: entries,
            logCount: entries.length,
            querySource,
          };
        } catch (error) {
          allResults[reg] = { error: (error as Error).message };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                application: ns,
                deployment: deploy || 'all',
                timeRange: { from, to },
                logLevel,
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
