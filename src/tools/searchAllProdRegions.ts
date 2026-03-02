import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions } from '../config/regions.js';

export function registerSearchAllProdRegionsTool(server: McpServer): void {
  server.tool(
    'search_all_prod_regions',
    'Search across all production regions in parallel',
    {
      query: z.string().describe('Sumo Logic search query'),
      from: z.string().optional().describe('Start time'),
      to: z.string().optional().describe('End time'),
      limit: z.number().optional().default(50).describe('Limit per region'),
    },
    async ({ query, from, to, limit }) => {
      const configuredProdRegions = getProdRegions().filter(r => 
        getConfiguredRegions().includes(r)
      );

      if (configuredProdRegions.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No production regions are configured. Please set API credentials in .env file.',
          }],
          isError: true,
        };
      }

      const results: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      const cleanQuery = `${query.replace(/\n/g, ' ')} | limit ${limit}`;

      await Promise.all(
        configuredProdRegions.map(async (region) => {
          try {
            const client = getClient(region);
            const result = await search(client, cleanQuery, { from, to });
            results[region] = {
              messageCount: result.messages?.length || 0,
              messages: result.messages || [],
            };
          } catch (error) {
            errors[region] = (error as Error).message;
          }
        })
      );

      const totalMessages = Object.values(results).reduce(
        (acc, r: any) => acc + (r.messageCount || 0), 0
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: cleanQuery,
            timeRange: { from: from || '-15m', to: to || 'now' },
            regionsSearched: configuredProdRegions,
            totalMessages,
            results,
            errors: Object.keys(errors).length > 0 ? errors : undefined,
          }, null, 2),
        }],
      };
    }
  );
}