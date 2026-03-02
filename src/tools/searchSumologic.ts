import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getConfiguredRegions } from '../config/regions.js';

export function registerSearchSumologicTool(server: McpServer): void {
  server.tool(
    'search_sumologic',
    'Search Sumo Logic logs in a specific region',
    {
      query: z.string().describe('Sumo Logic search query'),
      region: z.string().describe(`Region to search. Available: ${getConfiguredRegions().join(', ')}`),
      from: z.string().optional().describe('Start time (ISO 8601 or relative like -1h, -15m)'),
      to: z.string().optional().describe('End time (ISO 8601 or relative like now)'),
      limit: z.number().optional().default(100).describe('Maximum number of results'),
    },
    async ({ query, region, from, to, limit }) => {
      try {
        const client = getClient(region);
        const cleanQuery = `${query.replace(/\n/g, ' ')} | limit ${limit}`;
        const result = await search(client, cleanQuery, { from, to });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              region,
              query: cleanQuery,
              timeRange: { from: from || '-15m', to: to || 'now' },
              messageCount: result.messages?.length || 0,
              results: result,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error searching ${region}: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}