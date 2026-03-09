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
// Types
// ──────────────────────────────────────────────────────────

interface ErrorSpike {
  time: string;
  count: number;
  severity: string;
  deployment?: string;
}

interface ErrorPattern {
  message: string;
  count: number;
  deployment?: string;
  firstSeen?: string;
  lastSeen?: string;
}

interface FailingEndpoint {
  endpoint: string;
  statusCode: string;
  count: number;
  avgResponseTime?: string;
  deployment?: string;
}

interface PodHealth {
  pod: string;
  deployment?: string;
  errorCount: number;
  totalCount: number;
  errorRate: string;
}

interface RootCause {
  category: string;
  description: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  icon: string;
  action: string;
  reason: string;
}

interface IssueAnalysis {
  hasIssues: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'healthy';
  errorSpikes: ErrorSpike[];
  topErrorPatterns: ErrorPattern[];
  failingEndpoints: FailingEndpoint[];
  podHealth: PodHealth[];
  slowEndpoints: FailingEndpoint[];
  rootCauses: RootCause[];
  recommendations: Recommendation[];
  querySource: string;
}

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
  const clusterScope = `cluster="${cluster}" namespace=${namespace}${deployFilter} pod=*`;
  const clusterQuery = `${clusterScope} ${queryPart}`;

  let clusterResult: SearchResult | null = null;
  let partitionResult: SearchResult | null = null;

  // Try cluster
  try {
    clusterResult = await search(client, clusterQuery, options);
  } catch (e) {
    console.error(`[DetectIssues] Cluster query failed: ${(e as Error).message}`);
  }

  // Try partition (always try, not just as fallback)
  if (partition) {
    const partitionScope = `_index=${partition} namespace=${namespace}${deployFilter} pod=*`;
    const partitionQuery = `${partitionScope} ${queryPart}`;
    try {
      partitionResult = await search(client, partitionQuery, options);
    } catch (e) {
      console.error(`[DetectIssues] Partition query failed: ${(e as Error).message}`);
    }
  }

  // Pick the result with more data
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
    console.error(`[DetectIssues] SourceCategory query failed: ${(e as Error).message}`);
  }

  return {
    result: { messages: [], records: [], messageCount: 0, recordCount: 0 },
    querySource: 'none (all strategies failed)',
    queryUsed: clusterQuery,
  };
}

// ──────────────────────────────────────────────────────────
// Common log parsing
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

const HTTP_LOG_PARSE = [
  '| json "log" as msg nodrop',
  '| if(isNull(msg), _raw, msg) as msg',
  '| where !isNull(msg)',
  '| where !(msg contains "/healthcheck")',
  '| where !(msg contains "kube-probe")',
  '| where !(msg contains "/healthz")',
  '| where !(msg contains "Site24x7")',
  '| where !(msg contains "/api/ui")',
  '| parse regex field=msg "\\"(?<http_method>GET|POST|PUT|DELETE|PATCH) (?<api_endpoint>/api/[^\\s\\"]+) HTTP/\\d+\\.\\d+\\" (?<status_code>\\d+) \\d+ (?<response_time>\\d+\\.\\d+)" nodrop',
].join(' ');

// ──────────────────────────────────────────────────────────
// Query builders
// ──────────────────────────────────────────────────────────

/** Error spikes over time (5-min windows) */
function buildErrorSpikesQuery(errorThreshold: number): string {
  return [
    JSON_LOG_PARSE,
    '| where msg matches "*ERROR*" or msg matches "*Exception*" or msg matches "*FATAL*" or msg matches "*error*"',
    '| timeslice 5m',
    '| count by _timeslice, deployment',
    `| where _count > ${errorThreshold}`,
    '| order by _count desc',
    '| limit 30',
  ].join(' ');
}

/** Top error message patterns grouped */
function buildErrorPatternsQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| where msg matches "*ERROR*" or msg matches "*Exception*" or msg matches "*FATAL*" or msg matches "*error*"',
    // Extract a meaningful error snippet (first 200 chars of error line)
    '| parse regex field=msg "(?<error_line>(?:ERROR|Exception|FATAL|error)[^\\n]{0,200})" nodrop',
    '| if(isNull(error_line), msg, error_line) as error_line',
    '| count by error_line, deployment',
    '| order by _count desc',
    '| limit 30',
  ].join(' ');
}

/** HTTP 5xx and 4xx failing endpoints */
function buildFailingEndpointsQuery(): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(status_code)',
    '| toLong(status_code) as status_code_num',
    '| where status_code_num >= 400',
    '| toDouble(response_time) as response_time',
    '| count as error_count, avg(response_time) as avg_response_time by deployment, api_endpoint, status_code',
    '| order by error_count desc',
    '| limit 30',
  ].join(' ');
}

/** Per-pod error distribution (detect unhealthy pods) */
function buildPodHealthQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| if(msg matches "*ERROR*" or msg matches "*Exception*" or msg matches "*FATAL*", 1, 0) as is_error',
    '| count as total_count, sum(is_error) as error_count by deployment, pod',
    '| (100 * error_count / total_count) as error_rate',
    '| order by error_rate desc',
    '| limit 30',
  ].join(' ');
}

/** Slow endpoints (response time > threshold) */
function buildSlowEndpointsQuery(slowThresholdMs: number): string {
  return [
    HTTP_LOG_PARSE,
    '| where !isNull(response_time)',
    '| toDouble(response_time) as response_time_ms',
    `| where response_time_ms > ${slowThresholdMs}`,
    '| count as slow_count, avg(response_time_ms) as avg_response_time, max(response_time_ms) as max_response_time, pct(response_time_ms, 95) as p95_response_time by deployment, api_endpoint',
    '| order by slow_count desc',
    '| limit 15',
  ].join(' ');
}

/** Error timeline correlation — errors by 5-min window with sample messages */
function buildErrorTimelineQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| where msg matches "*ERROR*" or msg matches "*Exception*" or msg matches "*FATAL*"',
    '| timeslice 5m',
    '| count by _timeslice, deployment',
    '| order by _timeslice asc',
  ].join(' ');
}

/** Recent deployment/restart detection */
function buildRestartDetectionQuery(): string {
  return [
    JSON_LOG_PARSE,
    '| where msg matches "*Starting*" or msg matches "*Listening*" or msg matches "*started*" or msg matches "*initialized*" or msg matches "*Boot*" or msg matches "*restart*"',
    '| count by deployment, pod, _messageTime',
    '| sort _messageTime desc',
    '| limit 30',
  ].join(' ');
}

// ──────────────────────────────────────────────────────────
// Root Cause Analysis Engine
// ──────────────────────────────────────────────────────────

function analyzeRootCauses(
  errorPatterns: ErrorPattern[],
  failingEndpoints: FailingEndpoint[],
  podHealth: PodHealth[],
  slowEndpoints: FailingEndpoint[],
  errorSpikes: ErrorSpike[],
): RootCause[] {
  const rootCauses: RootCause[] = [];

  // ── Check for pod-specific failures ──
  const unhealthyPods = podHealth.filter((p) => parseFloat(p.errorRate) > 50);
  if (unhealthyPods.length > 0 && unhealthyPods.length < podHealth.length) {
    rootCauses.push({
      category: 'Pod-Specific Failure',
      description: `${unhealthyPods.length} out of ${podHealth.length} pods have >50% error rate. This suggests a pod-level issue (bad node, resource starvation, stuck process) rather than an application-wide bug.`,
      evidence: unhealthyPods.map((p) => `Pod ${p.pod}: ${p.errorRate}% error rate (${p.errorCount} errors / ${p.totalCount} total)`),
      confidence: 'high',
    });
  } else if (unhealthyPods.length === podHealth.length && podHealth.length > 0) {
    rootCauses.push({
      category: 'Application-Wide Failure',
      description: 'ALL pods have high error rates. This indicates an application-level issue (bad deployment, downstream dependency failure, configuration error).',
      evidence: unhealthyPods.map((p) => `Pod ${p.pod}: ${p.errorRate}% error rate`),
      confidence: 'high',
    });
  }

  // ── Check for timeout/connection cascading ──
  const timeoutPatterns = errorPatterns.filter(
    (p) =>
      p.message.toLowerCase().includes('timeout') ||
      p.message.toLowerCase().includes('timed out') ||
      p.message.toLowerCase().includes('econnrefused') ||
      p.message.toLowerCase().includes('econnreset'),
  );
  if (timeoutPatterns.length > 0) {
    const totalTimeouts = timeoutPatterns.reduce((acc, p) => acc + p.count, 0);
    rootCauses.push({
      category: 'Downstream Dependency Timeout',
      description: `${totalTimeouts} timeout/connection errors detected. A downstream service (database, API, cache) may be slow or unavailable, causing cascading failures.`,
      evidence: timeoutPatterns.map((p) => `"${p.message.substring(0, 150)}" — ${p.count} occurrences`),
      confidence: totalTimeouts > 50 ? 'high' : 'medium',
    });
  }

  // ── Check for database issues ──
  const dbPatterns = errorPatterns.filter(
    (p) =>
      p.message.toLowerCase().includes('database') ||
      p.message.toLowerCase().includes('sql') ||
      p.message.toLowerCase().includes('postgres') ||
      p.message.toLowerCase().includes('mysql') ||
      p.message.toLowerCase().includes('mongo') ||
      p.message.toLowerCase().includes('redis') ||
      p.message.toLowerCase().includes('connection pool'),
  );
  if (dbPatterns.length > 0) {
    rootCauses.push({
      category: 'Database/Storage Issue',
      description: 'Database-related errors detected. Possible connection pool exhaustion, query timeouts, or database unavailability.',
      evidence: dbPatterns.map((p) => `"${p.message.substring(0, 150)}" — ${p.count} occurrences`),
      confidence: 'high',
    });
  }

  // ── Check for memory/resource issues ──
  const memoryPatterns = errorPatterns.filter(
    (p) =>
      p.message.toLowerCase().includes('oom') ||
      p.message.toLowerCase().includes('out of memory') ||
      p.message.toLowerCase().includes('heap') ||
      p.message.toLowerCase().includes('memory') ||
      p.message.toLowerCase().includes('gc overhead'),
  );
  if (memoryPatterns.length > 0) {
    rootCauses.push({
      category: 'Memory/Resource Exhaustion',
      description: 'Memory-related errors suggest the application is running out of resources. Pods may be getting OOMKilled.',
      evidence: memoryPatterns.map((p) => `"${p.message.substring(0, 150)}" — ${p.count} occurrences`),
      confidence: 'high',
    });
  }

  // ── Check for auth issues ──
  const authPatterns = errorPatterns.filter(
    (p) =>
      p.message.toLowerCase().includes('unauthorized') ||
      p.message.toLowerCase().includes('forbidden') ||
      p.message.toLowerCase().includes('401') ||
      p.message.toLowerCase().includes('403') ||
      p.message.toLowerCase().includes('token expired') ||
      p.message.toLowerCase().includes('jwt'),
  );
  const auth4xxEndpoints = failingEndpoints.filter(
    (e) => e.statusCode === '401' || e.statusCode === '403',
  );
  if (authPatterns.length > 0 || auth4xxEndpoints.length > 0) {
    rootCauses.push({
      category: 'Authentication/Authorization Failure',
      description: 'Auth errors detected. Possible expired tokens, misconfigured credentials, or permission changes.',
      evidence: [
        ...authPatterns.map((p) => `"${p.message.substring(0, 150)}" — ${p.count} occurrences`),
        ...auth4xxEndpoints.map((e) => `${e.endpoint} returning ${e.statusCode} — ${e.count} times`),
      ],
      confidence: auth4xxEndpoints.length > 5 ? 'high' : 'medium',
    });
  }

  // ── Check for endpoint-specific failures ──
  const server5xxEndpoints = failingEndpoints.filter(
    (e) => e.statusCode.startsWith('5'),
  );
  if (server5xxEndpoints.length > 0) {
    const singleEndpointDominates =
      server5xxEndpoints.length === 1 ||
      (server5xxEndpoints.length > 1 &&
        server5xxEndpoints[0].count > server5xxEndpoints[1].count * 5);

    if (singleEndpointDominates) {
      rootCauses.push({
        category: 'Single Endpoint Failure',
        description: `Endpoint "${server5xxEndpoints[0].endpoint}" is responsible for the majority of 5xx errors. This is likely a bug in that specific handler.`,
        evidence: server5xxEndpoints.slice(0, 3).map(
          (e) => `${e.endpoint} → ${e.statusCode} — ${e.count} errors (avg ${e.avgResponseTime || 'N/A'}ms)`,
        ),
        confidence: 'high',
      });
    } else {
      rootCauses.push({
        category: 'Widespread 5xx Errors',
        description: `${server5xxEndpoints.length} endpoints returning 5xx errors. This suggests a systemic issue rather than a single bug.`,
        evidence: server5xxEndpoints.slice(0, 5).map(
          (e) => `${e.endpoint} → ${e.statusCode} — ${e.count} errors`,
        ),
        confidence: 'medium',
      });
    }
  }

  // ── Check for performance degradation ──
  if (slowEndpoints.length > 0) {
    const totalSlowRequests = slowEndpoints.reduce((acc, e) => acc + e.count, 0);
    rootCauses.push({
      category: 'Performance Degradation',
      description: `${totalSlowRequests} slow requests across ${slowEndpoints.length} endpoints. This may indicate resource contention, N+1 queries, or downstream latency.`,
      evidence: slowEndpoints.slice(0, 5).map(
        (e) => `${e.endpoint} — ${e.count} slow requests (avg ${e.avgResponseTime || 'N/A'}ms)`,
      ),
      confidence: slowEndpoints.length > 3 ? 'high' : 'medium',
    });
  }

  // ── Check for sudden spike (possible deployment issue) ──
  if (errorSpikes.length > 0) {
    const sortedSpikes = [...errorSpikes].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    );
    const firstSpike = sortedSpikes[0];
    const isRecent =
      sortedSpikes.length > 0 &&
      new Date(sortedSpikes[sortedSpikes.length - 1].time).getTime() >
        Date.now() - 30 * 60 * 1000;

    if (isRecent) {
      rootCauses.push({
        category: 'Recent Error Spike (Possible Bad Deployment)',
        description: `Error spike is ongoing or very recent. If a deployment happened around ${firstSpike?.time || 'the spike start'}, consider rolling back.`,
        evidence: sortedSpikes.slice(-3).map((s) => `${s.time}: ${s.count} errors`),
        confidence: 'medium',
      });
    }
  }

  // If no root causes identified
  if (rootCauses.length === 0 && errorPatterns.length > 0) {
    rootCauses.push({
      category: 'Unclassified Errors',
      description: 'Errors detected but no clear root cause pattern. Manual investigation recommended.',
      evidence: errorPatterns.slice(0, 3).map((p) => `"${p.message.substring(0, 150)}" — ${p.count} occurrences`),
      confidence: 'low',
    });
  }

  return rootCauses;
}

// ──────────────────────────────────────────────────────────
// Recommendation Engine
// ──────────────────────────────────────────────────────────

function generateRecommendations(rootCauses: RootCause[], analysis: {
  errorSpikes: ErrorSpike[];
  failingEndpoints: FailingEndpoint[];
  podHealth: PodHealth[];
  slowEndpoints: FailingEndpoint[];
}): Recommendation[] {
  const recommendations: Recommendation[] = [];

  for (const cause of rootCauses) {
    switch (cause.category) {
      case 'Pod-Specific Failure':
        recommendations.push({
          priority: 'critical',
          icon: '🔄',
          action: 'Restart or replace unhealthy pods',
          reason: `${cause.evidence.length} pods with high error rates. Run: kubectl delete pod <pod-name> -n <namespace> to restart.`,
        });
        recommendations.push({
          priority: 'high',
          icon: '🔍',
          action: 'Check node health for pods with high error rates',
          reason: 'Pod-specific failures often indicate node-level resource issues (CPU throttling, disk pressure).',
        });
        break;

      case 'Application-Wide Failure':
        recommendations.push({
          priority: 'critical',
          icon: '⏪',
          action: 'Consider rolling back the last deployment',
          reason: 'All pods affected suggests a code or config change caused the issue.',
        });
        recommendations.push({
          priority: 'critical',
          icon: '🔗',
          action: 'Check downstream dependencies (databases, APIs, caches)',
          reason: 'Application-wide failures often cascade from downstream outages.',
        });
        break;

      case 'Downstream Dependency Timeout':
        recommendations.push({
          priority: 'critical',
          icon: '🔗',
          action: 'Check health of downstream services and databases',
          reason: cause.description,
        });
        recommendations.push({
          priority: 'high',
          icon: '⚙️',
          action: 'Review circuit breaker and retry configurations',
          reason: 'Timeouts without circuit breakers cause cascading failures and thread/connection pool exhaustion.',
        });
        recommendations.push({
          priority: 'medium',
          icon: '⏱️',
          action: 'Consider increasing timeout thresholds if downstream is slow but healthy',
          reason: 'If the downstream service is under load but not failing, a slightly higher timeout may help.',
        });
        break;

      case 'Database/Storage Issue':
        recommendations.push({
          priority: 'critical',
          icon: '🗄️',
          action: 'Check database connectivity and connection pool metrics',
          reason: cause.description,
        });
        recommendations.push({
          priority: 'high',
          icon: '📊',
          action: 'Review slow query logs and database CPU/memory utilization',
          reason: 'Connection pool exhaustion is usually caused by slow queries holding connections.',
        });
        break;

      case 'Memory/Resource Exhaustion':
        recommendations.push({
          priority: 'critical',
          icon: '💾',
          action: 'Increase pod memory limits or investigate memory leaks',
          reason: cause.description,
        });
        recommendations.push({
          priority: 'high',
          icon: '📈',
          action: 'Check pod restart counts (kubectl get pods) for OOMKilled events',
          reason: 'Frequent OOMKills indicate the memory limit is too low or the app has a leak.',
        });
        break;

      case 'Authentication/Authorization Failure':
        recommendations.push({
          priority: 'high',
          icon: '🔐',
          action: 'Verify API tokens, secrets, and service account credentials',
          reason: cause.description,
        });
        recommendations.push({
          priority: 'medium',
          icon: '🔑',
          action: 'Check if tokens/certificates have recently expired or been rotated',
          reason: 'Auth failures often correlate with certificate or secret rotation.',
        });
        break;

      case 'Single Endpoint Failure':
        recommendations.push({
          priority: 'high',
          icon: '🐛',
          action: `Investigate the failing endpoint: ${cause.evidence[0]?.split(' → ')[0] || 'unknown'}`,
          reason: 'A single endpoint with most errors usually indicates a bug in that handler.',
        });
        break;

      case 'Widespread 5xx Errors':
        recommendations.push({
          priority: 'critical',
          icon: '🚨',
          action: 'Check for shared middleware, auth layer, or proxy issues',
          reason: 'Multiple endpoints failing simultaneously suggests a shared component is broken.',
        });
        break;

      case 'Performance Degradation':
        recommendations.push({
          priority: 'high',
          icon: '🐌',
          action: 'Profile slow endpoints for N+1 queries, missing indexes, or large payload serialization',
          reason: cause.description,
        });
        recommendations.push({
          priority: 'medium',
          icon: '📊',
          action: 'Check CPU and memory utilization of pods',
          reason: 'Slow responses across multiple endpoints may indicate resource starvation.',
        });
        break;

      case 'Recent Error Spike (Possible Bad Deployment)':
        recommendations.push({
          priority: 'critical',
          icon: '⏪',
          action: 'Check recent deployments and consider rolling back if errors correlate with a deploy',
          reason: cause.description,
        });
        break;
    }
  }

  // Always add general recommendations
  if (analysis.errorSpikes.length > 0) {
    recommendations.push({
      priority: 'medium',
      icon: '🔔',
      action: 'Set up Sumo Logic alerts for error rate thresholds to catch issues earlier',
      reason: `${analysis.errorSpikes.length} error spike windows detected.`,
    });
  }

  // Deduplicate by action
  const seen = new Set<string>();
  return recommendations.filter((r) => {
    if (seen.has(r.action)) return false;
    seen.add(r.action);
    return true;
  });
}

// ──────────────────────────────────────────────────────────
// Helper: extract data from search results
// ──────────────────────────────────────────────────────────

function extractData(result: SearchResult): Array<Record<string, string | undefined>> {
  const data = result.records?.length ? result.records : result.messages || [];
  return data.map((r) => r.map || {});
}

// ──────────────────────────────────────────────────────────
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerDetectIssuesTool(server: McpServer): void {
  server.tool(
    'detect_issues',
    'Detect issues, anomalies, and error patterns in application logs with root cause analysis and actionable recommendations. Uses cluster → partition → sourceCategory fallback.',
    {
      application: z.string().describe('Application namespace (e.g., okrs, logbook, roadmaps)'),
      deployment: z
        .string()
        .optional()
        .describe('Deployment name (e.g., okrs-api, okrs-worker). Omit to detect issues across ALL deployments in the namespace'),
      region: z
        .string()
        .optional()
        .describe('Specific region (e.g., aps2-prod) or omit for all prod regions'),
      from: z.string().optional().default('-24h').describe('Start time (e.g., -1h, -24h, -7d)'),
      to: z.string().optional().default('now').describe('End time'),
      errorThreshold: z
        .number()
        .optional()
        .default(10)
        .describe('Error count threshold per 5-min window to qualify as a spike'),
      slowThresholdMs: z
        .number()
        .optional()
        .default(5000)
        .describe('Response time threshold in ms to qualify as slow'),
    },
    async ({ application, deployment, region, from, to, errorThreshold, slowThresholdMs }) => {
      const deploy = deployment || '';  // empty = all deployments in namespace
      const ns = application;
      const targetRegions = region
        ? [region]
        : getProdRegions().filter((r) => getConfiguredRegions().includes(r));

      const allIssues: Record<string, IssueAnalysis | { error: string }> = {};

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

          const searchOpts = { from: from || '-24h', to: to || 'now' };
          let lastQuerySource = 'unknown';

          // ── 1. Error Spikes ──
          let errorSpikes: ErrorSpike[] = [];
          try {
            const { result, querySource } = await searchWithFallback(
              client, partition, cluster, ns, deploy,
              buildErrorSpikesQuery(errorThreshold), searchOpts,
            );
            lastQuerySource = querySource;
            errorSpikes = extractData(result).map((r) => ({
              time: r._timeslice || '',
              count: parseInt(r._count || '0'),
              deployment: r.deployment || 'unknown',
              severity: parseInt(r._count || '0') > errorThreshold * 10 ? 'critical' : 
                        parseInt(r._count || '0') > errorThreshold * 5 ? 'high' : 'medium',
            }));
          } catch (e) {
            console.error(`[DetectIssues] Error spikes query failed: ${(e as Error).message}`);
          }

          // ── 2. Error Patterns ──
          let topErrorPatterns: ErrorPattern[] = [];
          try {
            const { result, querySource } = await searchWithFallback(
              client, partition, cluster, ns, deploy,
              buildErrorPatternsQuery(), searchOpts,
            );
            lastQuerySource = querySource;
            topErrorPatterns = extractData(result).map((r) => ({
              message: r.error_line || r.msg || '',
              count: parseInt(r._count || '0'),
              deployment: r.deployment || 'unknown',
            }));
          } catch (e) {
            console.error(`[DetectIssues] Error patterns query failed: ${(e as Error).message}`);
          }

          // ── 3. Failing Endpoints (HTTP 4xx/5xx) ──
          let failingEndpoints: FailingEndpoint[] = [];
          try {
            const { result } = await searchWithFallback(
              client, partition, cluster, ns, deploy,
              buildFailingEndpointsQuery(), searchOpts,
            );
            failingEndpoints = extractData(result).map((r) => ({
              endpoint: r.api_endpoint || '',
              statusCode: r.status_code || '',
              count: parseInt(r.error_count || '0'),
              avgResponseTime: r.avg_response_time || undefined,
              deployment: r.deployment || 'unknown',
            }));
          } catch (e) {
            console.error(`[DetectIssues] Failing endpoints query failed: ${(e as Error).message}`);
          }

          // ── 4. Pod Health ──
          let podHealth: PodHealth[] = [];
          try {
            const { result } = await searchWithFallback(
              client, partition, cluster, ns, deploy,
              buildPodHealthQuery(), searchOpts,
            );
            podHealth = extractData(result).map((r) => ({
              pod: r.pod || '',
              deployment: r.deployment || 'unknown',
              errorCount: parseInt(r.error_count || '0'),
              totalCount: parseInt(r.total_count || '0'),
              errorRate: r.error_rate ? `${parseFloat(r.error_rate).toFixed(2)}%` : '0%',
            }));
          } catch (e) {
            console.error(`[DetectIssues] Pod health query failed: ${(e as Error).message}`);
          }

          // ── 5. Slow Endpoints ──
          let slowEndpoints: FailingEndpoint[] = [];
          try {
            const { result } = await searchWithFallback(
              client, partition, cluster, ns, deploy,
              buildSlowEndpointsQuery(slowThresholdMs), searchOpts,
            );
            slowEndpoints = extractData(result).map((r) => ({
              endpoint: r.api_endpoint || '',
              statusCode: 'slow',
              count: parseInt(r.slow_count || '0'),
              avgResponseTime: r.avg_response_time || undefined,
              deployment: r.deployment || 'unknown',
            }));
          } catch (e) {
            console.error(`[DetectIssues] Slow endpoints query failed: ${(e as Error).message}`);
          }

          // ── 6. Root Cause Analysis ──
          const rootCauses = analyzeRootCauses(
            topErrorPatterns,
            failingEndpoints,
            podHealth,
            slowEndpoints,
            errorSpikes,
          );

          // ── 7. Recommendations ──
          const recommendations = generateRecommendations(rootCauses, {
            errorSpikes,
            failingEndpoints,
            podHealth,
            slowEndpoints,
          });

          // ── Determine severity ──
          const hasIssues =
            errorSpikes.length > 0 ||
            topErrorPatterns.length > 0 ||
            failingEndpoints.length > 0 ||
            slowEndpoints.length > 0;

          let severity: IssueAnalysis['severity'] = 'healthy';
          if (rootCauses.some((r) => r.confidence === 'high') && errorSpikes.length > 10) {
            severity = 'critical';
          } else if (rootCauses.some((r) => r.confidence === 'high') || errorSpikes.length > 5) {
            severity = 'high';
          } else if (rootCauses.length > 2 || errorSpikes.length > 2) {
            severity = 'medium';
          } else if (hasIssues) {
            severity = 'low';
          }

          // ── Collect unique deployments found ──
          const deploymentsFound = new Set<string>();
          errorSpikes.forEach(e => e.deployment && deploymentsFound.add(e.deployment));
          topErrorPatterns.forEach(e => e.deployment && deploymentsFound.add(e.deployment));
          failingEndpoints.forEach(e => e.deployment && deploymentsFound.add(e.deployment));
          podHealth.forEach(e => e.deployment && deploymentsFound.add(e.deployment));
          slowEndpoints.forEach(e => e.deployment && deploymentsFound.add(e.deployment));
          deploymentsFound.delete('unknown');

          allIssues[reg] = {
            hasIssues,
            severity,
            deploymentsAffected: Array.from(deploymentsFound),
            errorSpikes,
            topErrorPatterns,
            failingEndpoints,
            podHealth,
            slowEndpoints,
            rootCauses,
            recommendations,
            querySource: lastQuerySource,
          } as any;
        } catch (error) {
          allIssues[reg] = { error: (error as Error).message };
        }
      }

      // ── Global Summary ──
      const issueAnalyses = Object.values(allIssues).filter(
        (i): i is IssueAnalysis => 'hasIssues' in i,
      );

      const allRootCauses = issueAnalyses.flatMap((i) => i.rootCauses);
      const allRecommendations = issueAnalyses.flatMap((i) => i.recommendations);

      // Deduplicate recommendations across regions
      const seenActions = new Set<string>();
      const uniqueRecommendations = allRecommendations.filter((r) => {
        if (seenActions.has(r.action)) return false;
        seenActions.add(r.action);
        return true;
      });

      const globalSummary = {
        totalRegionsAnalyzed: targetRegions.length,
        regionsWithIssues: issueAnalyses.filter((i) => i.hasIssues).length,
        overallSeverity: issueAnalyses.some((i) => i.severity === 'critical')
          ? 'critical'
          : issueAnalyses.some((i) => i.severity === 'high')
            ? 'high'
            : issueAnalyses.some((i) => i.severity === 'medium')
              ? 'medium'
              : issueAnalyses.some((i) => i.severity === 'low')
                ? 'low'
                : 'healthy',
        criticalRegions: Object.entries(allIssues)
          .filter(([_, i]) => 'severity' in i && i.severity === 'critical')
          .map(([r]) => r),
        healthyRegions: Object.entries(allIssues)
          .filter(([_, i]) => 'severity' in i && i.severity === 'healthy')
          .map(([r]) => r),
        rootCauseSummary: allRootCauses.map((r) => ({
          category: r.category,
          confidence: r.confidence,
          description: r.description,
        })),
        topRecommendations: uniqueRecommendations
          .sort((a, b) => {
            const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
          })
          .slice(0, 10),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                application: ns,
                deployment: deploy,
                timeRange: { from, to },
                errorThreshold,
                slowThresholdMs,
                globalSummary,
                regionDetails: allIssues,
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
