import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search, type SearchResult } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getConfiguredRegions, getClusterName, getPartition, findRegionByCluster } from '../config/regions.js';

export function registerSearchByClusterTool(server: McpServer): void {
  server.tool(
    'search_by_cluster',
    'Search logs by cluster/region. Tries partition index first, falls back to cluster query if no results.',
    {
      cluster: z.string().optional().describe('Cluster name (e.g., fd-platform-usw2-prod)'),
      region: z.string().optional().describe('Region name (e.g., usw2-prod, aps2-prod, euc1-prod)'),
      namespace: z.string().optional().describe('Kubernetes namespace to filter (e.g., okrs, logbook, roadmaps)'),
      query: z.string().optional().describe('Additional search query/filter'),
      level: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'ALL']).optional().default('ALL'),
      from: z.string().optional().default('-1h').describe('Start time (e.g., -1h, -15m, -24h, -7d)'),
      to: z.string().optional().default('now').describe('End time'),
      limit: z.number().optional().default(50).describe('Max results to return'),
    },
    async ({ cluster, region, namespace, query, level, from, to, limit }) => {
      // Determine region
      let targetRegion: string;

      if (region) {
        targetRegion = region;
      } else if (cluster) {
        const foundRegion = findRegionByCluster(cluster);
        if (!foundRegion) {
          return {
            content: [{
              type: 'text',
              text: `Unknown cluster: ${cluster}. Configured regions: ${getConfiguredRegions().join(', ')}`,
            }],
            isError: true,
          };
        }
        targetRegion = foundRegion;
      } else {
        targetRegion = 'usw2-prod';
      }

      // Check if region is configured
      if (!getConfiguredRegions().includes(targetRegion)) {
        return {
          content: [{
            type: 'text',
            text: `Region ${targetRegion} is not configured. Configured regions: ${getConfiguredRegions().join(', ')}`,
          }],
          isError: true,
        };
      }

      try {
        const client = getClient(targetRegion);
        const clusterName = getClusterName(targetRegion);
        let partition: string;
        try {
          partition = getPartition(targetRegion);
        } catch {
          partition = '';
        }

        // Build filter parts
        const levelFilter = (level && level !== 'ALL')
          ? `(_loglevel="${level}" OR level="${level}" OR level="${level.toLowerCase()}")`
          : '';
        const namespaceFilter = namespace ? `namespace="${namespace}"` : '';
        const customFilter = query ? `(${query})` : '';

        // Helper to build full query
        const buildQuery = (baseScope: string): string => {
          const parts = [baseScope, namespaceFilter, levelFilter, customFilter].filter(Boolean);
          return parts.join(' ') + ` | limit ${limit}`;
        };

        let result: SearchResult;
        let usedQuery: string;
        let querySource: string;

        // Note: `from` and `to` are passed as-is — the search() function handles
        // parsing relative strings like "-1h" to proper ISO timestamps
        const searchOpts = { from: from || '-1h', to: to || 'now' };

        if (partition) {
          // ============================================
          // Strategy 1: Try partition index first
          // ============================================
          const partitionQuery = buildQuery(`_index=${partition}`);

          try {
            result = await search(client, partitionQuery, searchOpts);
            usedQuery = partitionQuery;
            querySource = 'partition';

            // If no results from partition, try cluster query
            if (result.messageCount === 0) {
              const clusterQuery = buildQuery(`cluster="${clusterName}"`);
              const clusterResult = await search(client, clusterQuery, searchOpts);

              if (clusterResult.messageCount > 0) {
                result = clusterResult;
                usedQuery = clusterQuery;
                querySource = 'cluster (partition had no results)';
              }
            }
          } catch {
            // Partition query failed, try cluster query
            const clusterQuery = buildQuery(`cluster="${clusterName}"`);
            result = await search(client, clusterQuery, searchOpts);
            usedQuery = clusterQuery;
            querySource = 'cluster (partition query failed)';
          }
        } else {
          // No partition configured, use cluster directly
          const clusterQuery = buildQuery(`cluster="${clusterName}"`);
          result = await search(client, clusterQuery, searchOpts);
          usedQuery = clusterQuery;
          querySource = 'cluster';
        }

        const messages = result.messages?.map(m => ({
          time: m.map._messagetime || m.map._receipttime,
          level: m.map._loglevel || m.map.level,
          message: m.map._raw?.substring(0, 1000),
          source: m.map._sourceCategory,
          namespace: m.map.namespace,
          pod: m.map.pod || m.map.pod_name,
        })) || [];

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              region: targetRegion,
              cluster: clusterName,
              partition: partition || 'N/A',
              namespace: namespace || 'all',
              querySource,
              queryUsed: usedQuery,
              timeRange: { from, to },
              totalFound: result.messageCount,
              returned: messages.length,
              messages,
            }, null, 2),
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