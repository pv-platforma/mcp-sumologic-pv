import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../domains/sumologic/client.js';
import { getClient } from '../lib/sumologic/clientFactory.js';
import { getProdRegions, getConfiguredRegions } from '../config/regions.js';

interface IssueAnalysis {
  hasIssues: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'healthy';
  errorSpikes: Array<{ time: string; count: number }>;
  topErrorPatterns: Array<{ pattern: string; count: number }>;
  slowRequests: number;
  recommendations: string[];
}

function generateRecommendations(patterns: Array<{ pattern: string; count: number }>): string[] {
  const recommendations: string[] = [];

  for (const { pattern } of patterns) {
    if (pattern?.toLowerCase().includes('timeout')) {
      recommendations.push('⏱️ Timeout errors detected - Consider increasing timeout thresholds or optimizing slow operations');
    }
    if (pattern?.toLowerCase().includes('connection')) {
      recommendations.push('🔌 Connection errors detected - Check network connectivity and connection pool settings');
    }
    if (pattern?.toLowerCase().includes('memory') || pattern?.toLowerCase().includes('oom')) {
      recommendations.push('💾 Memory issues detected - Review memory allocation and check for memory leaks');
    }
    if (pattern?.toLowerCase().includes('null') || pattern?.toLowerCase().includes('undefined')) {
      recommendations.push('🔍 Null pointer errors detected - Review null checks in the codebase');
    }
    if (pattern?.toLowerCase().includes('auth') || pattern?.toLowerCase().includes('permission')) {
      recommendations.push('🔐 Authentication/Authorization errors detected - Verify credentials and permissions');
    }
    if (pattern?.toLowerCase().includes('database') || pattern?.toLowerCase().includes('sql')) {
      recommendations.push('🗄️ Database errors detected - Check database connectivity and query performance');
    }
  }

  return recommendations.length > 0 ? [...new Set(recommendations)] : ['✅ No specific issues identified'];
}

export function registerDetectIssuesTool(server: McpServer): void {
  server.tool(
    'detect_issues',
    'Detect issues, anomalies, and error patterns in application logs',
    {
      application: z.string().describe('Application name'),
      region: z.string().optional().describe('Specific region or omit for all prod regions'),
      from: z.string().describe('Start time'),
      to: z.string().describe('End time'),
      errorThreshold: z.number().optional().default(10).describe('Error count threshold per 5-min window'),
    },
    async ({ application, region, from, to, errorThreshold }) => {
      const targetRegions = region 
        ? [region] 
        : getProdRegions().filter(r => getConfiguredRegions().includes(r));

      const issues: Record<string, IssueAnalysis | { error: string }> = {};

      for (const reg of targetRegions) {
        try {
          const client = getClient(reg);

          // Error spikes query
          const errorSpikeQuery = `
            (_sourceCategory=*${application}* OR namespace=*${application}*)
            | where level = "ERROR" OR level = "error" OR _loglevel = "ERROR"
            | timeslice 5m
            | count by _timeslice
            | where _count > ${errorThreshold}
            | order by _timeslice desc
            | limit 20
          `.replace(/\n/g, ' ').trim();

          const errorSpikesResult = await search(client, errorSpikeQuery, { from, to });

          // Error patterns query
          const errorPatternsQuery = `
            (_sourceCategory=*${application}* OR namespace=*${application}*)
            | where level = "ERROR" OR level = "error" OR _loglevel = "ERROR"
            | parse regex "(?<error_pattern>\\w*Exception|\\w*Error|\\w*Failure|\\w*Timeout)" nodrop
            | where !isNull(error_pattern)
            | count by error_pattern
            | order by _count desc
            | limit 10
          `.replace(/\n/g, ' ').trim();

          const errorPatternsResult = await search(client, errorPatternsQuery, { from, to });

          // Slow requests query
          const slowRequestsQuery = `
            (_sourceCategory=*${application}* OR namespace=*${application}*)
            | parse regex "(?:duration|latency|response_time)[=:\\s]*(?<latency>\\d+)" nodrop
            | where latency > 5000
            | count as slow_request_count
          `.replace(/\n/g, ' ').trim();

          const slowRequestsResult = await search(client, slowRequestsQuery, { from, to });

          const errorSpikes = errorSpikesResult.messages?.map(m => ({
            time: m.map?._timeslice || '',
            count: parseInt(m.map?._count || '0'),
          })) || [];

          const topErrorPatterns = errorPatternsResult.messages?.map(m => ({
            pattern: m.map?.error_pattern || '',
            count: parseInt(m.map?._count || '0'),
          })) || [];

          const slowRequests = parseInt(
            slowRequestsResult.messages?.[0]?.map?.slow_request_count || '0'
          );

          const hasIssues = errorSpikes.length > 0 || topErrorPatterns.length > 0 || slowRequests > 0;
          
          let severity: IssueAnalysis['severity'] = 'healthy';
          if (errorSpikes.length > 10 || topErrorPatterns.some(p => p.count > 100)) {
            severity = 'critical';
          } else if (errorSpikes.length > 5 || topErrorPatterns.some(p => p.count > 50)) {
            severity = 'high';
          } else if (errorSpikes.length > 2 || topErrorPatterns.length > 3) {
            severity = 'medium';
          } else if (hasIssues) {
            severity = 'low';
          }

          issues[reg] = {
            hasIssues,
            severity,
            errorSpikes,
            topErrorPatterns,
            slowRequests,
            recommendations: generateRecommendations(topErrorPatterns),
          };
        } catch (error) {
          issues[reg] = { error: (error as Error).message };
        }
      }

      // Global summary
      const issueAnalyses = Object.values(issues).filter(
        (i): i is IssueAnalysis => 'hasIssues' in i
      );
      
      const globalSummary = {
        totalRegionsAnalyzed: targetRegions.length,
        regionsWithIssues: issueAnalyses.filter(i => i.hasIssues).length,
        criticalRegions: Object.entries(issues)
          .filter(([_, i]) => 'severity' in i && i.severity === 'critical')
          .map(([r]) => r),
        healthyRegions: Object.entries(issues)
          .filter(([_, i]) => 'severity' in i && i.severity === 'healthy')
          .map(([r]) => r),
        overallSeverity: issueAnalyses.some(i => i.severity === 'critical') ? 'critical' :
                         issueAnalyses.some(i => i.severity === 'high') ? 'high' :
                         issueAnalyses.some(i => i.severity === 'medium') ? 'medium' :
                         issueAnalyses.some(i => i.severity === 'low') ? 'low' : 'healthy',
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            application,
            timeRange: { from, to },
            errorThreshold,
            globalSummary,
            regionDetails: issues,
          }, null, 2),
        }],
      };
    }
  );
}