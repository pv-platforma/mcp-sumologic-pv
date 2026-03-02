import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions } from '../config/regions.js';

export function registerSummarizeLogsTool(server: McpServer): void {
  server.tool(
    'summarize_logs',
    'Get a summary of logs including log level distribution and top errors',
    {
      application: z.string().describe('Application name, namespace, or source category pattern'),
      region: z.string().optional().describe('Specific region or omit for all prod regions'),
      from: z.string().describe('Start time (e.g., -1h, -24h, 2024-01-01T00:00:00Z)'),
      to: z.string().describe('End time (e.g., now, 2024-01-01T12:00:00Z)'),
      logLevel: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'ALL']).optional().default('ALL'),
    },
    async ({ application, region, from, to, logLevel }) => {
      const targetRegions = region 
        ? [region] 
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const summaries: Record<string, unknown> = {};

      for (const reg of targetRegions) {
        try {
          const client = getClient(reg);
          
          // Log level distribution query
          const levelFilter = logLevel !== 'ALL' ? `| where level = "${logLevel}" OR _loglevel = "${logLevel}"` : '';
          const countQuery = `
            (_sourceCategory=*${application}* OR _sourceHost=*${application}* OR namespace=*${application}*)
            ${levelFilter}
            | if(isNull(level), _loglevel, level) as log_level
            | count by log_level
            | order by _count desc
          `.replace(/\n/g, ' ').trim();

          const countResult = await search(client, countQuery, { from, to });

          // Top errors query
          const errorQuery = `
            (_sourceCategory=*${application}* OR _sourceHost=*${application}* OR namespace=*${application}*)
            | where level = "ERROR" OR level = "error" OR _loglevel = "ERROR"
            | limit 10
            | fields _raw, _messagetime, _sourceHost
          `.replace(/\n/g, ' ').trim();

          const errorSamples = await search(client, errorQuery, { from, to });

          // Calculate totals
          const logLevels = countResult.messages || [];
          const totalLogs = logLevels.reduce((acc, m) => acc + parseInt(m.map?._count || '0'), 0);
          const errorCount = logLevels.find(m => 
            m.map?.log_level?.toUpperCase() === 'ERROR'
          )?.map?._count || '0';
          const warnCount = logLevels.find(m => 
            m.map?.log_level?.toUpperCase() === 'WARN' || m.map?.log_level?.toUpperCase() === 'WARNING'
          )?.map?._count || '0';

          summaries[reg] = {
            totalLogs,
            errorCount: parseInt(errorCount),
            warnCount: parseInt(warnCount),
            logLevelDistribution: logLevels.map(l => ({
              level: l.map?.log_level,
              count: parseInt(l.map?._count || '0'),
            })),
            recentErrors: errorSamples.messages?.slice(0, 5).map(e => ({
              time: e.map?._messagetime,
              host: e.map?._sourceHost,
              message: e.map?._raw?.substring(0, 500),
            })) || [],
            healthStatus: parseInt(errorCount) > 100 ? 'critical' : 
                          parseInt(errorCount) > 10 ? 'warning' : 'healthy',
          };
        } catch (error) {
          summaries[reg] = { error: (error as Error).message };
        }
      }

      // Generate overall summary
      const overallErrors = Object.values(summaries).reduce(
        (acc, s: any) => acc + (s.errorCount || 0), 0
      );
      const criticalRegions = Object.entries(summaries)
        .filter(([_, s]: [string, any]) => s.healthStatus === 'critical')
        .map(([r]) => r);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            application,
            timeRange: { from, to },
            overallSummary: {
              totalErrors: overallErrors,
              criticalRegions,
              regionsAnalyzed: targetRegions.length,
            },
            regionDetails: summaries,
          }, null, 2),
        }],
      };
    }
  );
}