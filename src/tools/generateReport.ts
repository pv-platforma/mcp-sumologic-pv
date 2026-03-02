import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions, SUMO_REGIONS } from '../config/regions.js';

interface RegionReport {
  region: string;
  displayName: string;
  errorCount: number;
  warnCount: number;
  totalLogs: number;
  status: '🔴' | '🟡' | '🟢' | '⚪';
  topErrors: Array<{ pattern: string; count: number }>;
  error?: string;
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: Array<{
    type: string;
    text: string;
  }>;
}

function formatSlackReport(
  application: string,
  timeRange: { from: string; to: string },
  reports: RegionReport[]
): string {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Log Report: ${application}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Time Range:* \`${timeRange.from}\` → \`${timeRange.to}\``,
      },
    },
    { type: 'divider' },
  ];

  for (const report of reports) {
    if (report.error) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚪ *${report.displayName}*\n_Error: ${report.error}_`,
        },
      });
    } else {
      const errorList = report.topErrors.length > 0
        ? report.topErrors.slice(0, 3).map(e => `  • ${e.pattern}: ${e.count}`).join('\n')
        : '  _No errors_';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${report.status} *${report.displayName}*\n` +
                `• Errors: ${report.errorCount} | Warnings: ${report.warnCount} | Total: ${report.totalLogs}\n` +
                `*Top Errors:*\n${errorList}`,
        },
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '🟢 Healthy (<10 errors) | 🟡 Warning (10-100) | 🔴 Critical (>100) | ⚪ Error fetching data',
      },
    ],
  });

  return JSON.stringify({ blocks }, null, 2);
}

function formatMarkdownReport(
  application: string,
  timeRange: { from: string; to: string },
  reports: RegionReport[]
): string {
  let md = `# 📊 Log Report: ${application}\n\n`;
  md += `**Time Range:** \`${timeRange.from}\` → \`${timeRange.to}\`\n\n`;
  md += `---\n\n`;

  for (const report of reports) {
    md += `## ${report.status} ${report.displayName}\n\n`;
    
    if (report.error) {
      md += `_Error: ${report.error}_\n\n`;
    } else {
      md += `| Metric | Count |\n|--------|-------|\n`;
      md += `| Errors | ${report.errorCount} |\n`;
      md += `| Warnings | ${report.warnCount} |\n`;
      md += `| Total Logs | ${report.totalLogs} |\n\n`;

      if (report.topErrors.length > 0) {
        md += `**Top Errors:**\n`;
        for (const err of report.topErrors.slice(0, 5)) {
          md += `- ${err.pattern}: ${err.count}\n`;
        }
      }
    }
    md += `\n---\n\n`;
  }

  md += `\n**Legend:** 🟢 Healthy (<10 errors) | 🟡 Warning (10-100) | 🔴 Critical (>100)\n`;

  return md;
}

export function registerGenerateReportTool(server: McpServer): void {
  server.tool(
    'generate_report',
    'Generate a formatted report for Slack or other chat platforms',
    {
      application: z.string().describe('Application name'),
      region: z.string().optional().describe('Specific region or omit for all prod regions'),
      from: z.string().describe('Start time'),
      to: z.string().describe('End time'),
      format: z.enum(['slack', 'markdown', 'json']).optional().default('slack'),
    },
    async ({ application, region, from, to, format }) => {
      const targetRegions = region 
        ? [region] 
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const reports: RegionReport[] = [];

      for (const reg of targetRegions) {
        const regionConfig = SUMO_REGIONS[reg];
        
        try {
          const client = getClient(reg);

          // Get log level counts
          const countQuery = `
            (_sourceCategory=*${application}* OR namespace=*${application}*)
            | if(isNull(level), _loglevel, level) as log_level
            | count by log_level
          `.replace(/\n/g, ' ').trim();

          const countResult = await search(client, countQuery, { from, to });

          // Get top error patterns
          const errorQuery = `
            (_sourceCategory=*${application}* OR namespace=*${application}*)
            | where level = "ERROR" OR level = "error" OR _loglevel = "ERROR"
            | parse regex "(?<error_pattern>\\w*Exception|\\w*Error)" nodrop
            | count by error_pattern
            | order by _count desc
            | limit 5
          `.replace(/\n/g, ' ').trim();

          const errorResult = await search(client, errorQuery, { from, to });

          const logLevels = countResult.messages || [];
          const errorCount = parseInt(
            logLevels.find(m => m.map?.log_level?.toUpperCase() === 'ERROR')?.map?._count || '0'
          );
          const warnCount = parseInt(
            logLevels.find(m => 
              m.map?.log_level?.toUpperCase() === 'WARN' || 
              m.map?.log_level?.toUpperCase() === 'WARNING'
            )?.map?._count || '0'
          );
          const totalLogs = logLevels.reduce((acc, m) => acc + parseInt(m.map?._count || '0'), 0);

          const status: RegionReport['status'] = 
            errorCount > 100 ? '🔴' : 
            errorCount > 10 ? '🟡' : '🟢';

          reports.push({
            region: reg,
            displayName: regionConfig.displayName,
            errorCount,
            warnCount,
            totalLogs,
            status,
            topErrors: errorResult.messages?.map(m => ({
              pattern: m.map?.error_pattern || 'Unknown',
              count: parseInt(m.map?._count || '0'),
            })) || [],
          });
        } catch (error) {
          reports.push({
            region: reg,
            displayName: regionConfig.displayName,
            errorCount: 0,
            warnCount: 0,
            totalLogs: 0,
            status: '⚪',
            topErrors: [],
            error: (error as Error).message,
          });
        }
      }

      let output: string;
      if (format === 'slack') {
        output = formatSlackReport(application, { from, to }, reports);
      } else if (format === 'markdown') {
        output = formatMarkdownReport(application, { from, to }, reports);
      } else {
        output = JSON.stringify({
          application,
          timeRange: { from, to },
          reports,
        }, null, 2);
      }

      return {
        content: [{ type: 'text', text: output }],
      };
    }
  );
}