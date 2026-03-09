/**
 * Parses natural language Slack messages into structured commands
 * for the MCP tools.
 */

export type CommandType =
  | 'list_logs'
  | 'performance'
  | 'throughput'
  | 'detect_issues'
  | 'summarize_logs'
  | 'help'
  | 'unknown';

export interface ParsedCommand {
  type: CommandType;
  namespace?: string;
  deployment?: string;
  region?: string;
  timeRange?: string;
  timeRangeMs?: number;
}

const REGION_ALIASES: Record<string, string> = {
  apac: 'aps2-prod',
  ap: 'aps2-prod',
  asia: 'aps2-prod',
  australia: 'aps2-prod',
  aps2: 'aps2-prod',
  'aps2-prod': 'aps2-prod',
  us: 'usw2-prod',
  usa: 'usw2-prod',
  'us west': 'usw2-prod',
  usw2: 'usw2-prod',
  'usw2-prod': 'usw2-prod',
  eu: 'euc1-prod',
  europe: 'euc1-prod',
  euc1: 'euc1-prod',
  'euc1-prod': 'euc1-prod',
  all: 'all',
  'all regions': 'all',
};

const KNOWN_NAMESPACES = [
  'okrs',
  'logbook',
  'roadmaps',
  'spaces',
  'pvgroups',
  'whiteboards',
  'planviewme',
  'comments',
];

// Aliases: common variations → canonical namespace
const NAMESPACE_ALIASES: Record<string, string> = {
  okr: 'okrs',
  'okr-api': 'okrs',
  'okrs-api': 'okrs',
  roadmap: 'roadmaps',
  'road map': 'roadmaps',
  'road maps': 'roadmaps',
  space: 'spaces',
  whiteboard: 'whiteboards',
  comment: 'comments',
  logbooks: 'logbook',
  'log book': 'logbook',
  'log books': 'logbook',
  pvgroup: 'pvgroups',
  'pv group': 'pvgroups',
  'pv groups': 'pvgroups',
};

const KNOWN_DEPLOYMENT_SUFFIXES = [
  'api',
  'odata',
  'hasura',
  'odata-hasura',
];

export function parseCommand(text: string): ParsedCommand {
  const lower = text.toLowerCase().trim();

  // Help
  if (
    lower === 'help' ||
    lower.includes('what can you do') ||
    lower.includes('how to use')
  ) {
    return { type: 'help' };
  }

  // Detect command type
  let type: CommandType = 'unknown';

  if (
    lower.includes('throughput') &&
    (lower.includes('all region') || lower.includes('across') || lower.includes('every region'))
  ) {
    type = 'throughput';
  } else if (
    lower.includes('perform') ||
    lower.includes('how is') ||
    lower.includes("how's") ||
    lower.includes('health') ||
    lower.includes('status') ||
    lower.includes('metrics')
  ) {
    type = 'performance';
  } else if (
    lower.includes('list log') ||
    lower.includes('show log') ||
    lower.includes('get log') ||
    lower.includes('tail log') ||
    lower.includes('recent log')
  ) {
    type = 'list_logs';
  } else if (
    lower.includes('issue') ||
    lower.includes('problem') ||
    lower.includes('error') ||
    lower.includes('anomal')
  ) {
    type = 'detect_issues';
  } else if (
    lower.includes('summar') ||
    lower.includes('overview') ||
    lower.includes('top error')
  ) {
    type = 'summarize_logs';
  } else if (lower.includes('log')) {
    type = 'list_logs';
  }

  // Extract namespace — check aliases first (longest match wins), then exact names
  let namespace: string | undefined;

  // Sort aliases by length descending so "okrs-api" matches before "okr"
  const sortedAliases = Object.entries(NAMESPACE_ALIASES).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [alias, canonical] of sortedAliases) {
    if (lower.includes(alias)) {
      namespace = canonical;
      break;
    }
  }

  // If no alias matched, try exact namespace names
  if (!namespace) {
    for (const ns of KNOWN_NAMESPACES) {
      if (lower.includes(ns)) {
        namespace = ns;
        break;
      }
    }
  }

  // Extract deployment (e.g. okrs-api, okrs-odata, dovetail-standalone)
  let deployment: string | undefined;
  const deploymentRegex = new RegExp(
    `(\\w+-(?:${KNOWN_DEPLOYMENT_SUFFIXES.join('|')}))`,
    'i'
  );
  const deploymentMatch = lower.match(deploymentRegex);
  if (deploymentMatch) {
    deployment = deploymentMatch[1];
  } else if (lower.includes('hasura')) {
    deployment = 'hasura';
  } else if (lower.includes('dovetail')) {
    deployment = 'dovetail-standalone';
  }

  // Extract region
  let region: string | undefined;
  for (const [alias, regionId] of Object.entries(REGION_ALIASES)) {
    if (lower.includes(alias)) {
      region = regionId;
      break;
    }
  }

  // Extract time range
  let timeRange: string | undefined;
  let timeRangeMs: number | undefined;

  const minuteMatch = lower.match(/last\s+(\d+)\s*min(ute)?s?/i);
  const hourMatch = lower.match(/last\s+(\d+)\s*h(ou)?rs?/i);
  const dayMatch = lower.match(/last\s+(\d+)\s*d(ay)?s?/i);

  if (minuteMatch) {
    const mins = parseInt(minuteMatch[1], 10);
    timeRangeMs = mins * 60 * 1000;
    timeRange = `-${mins}m`;
  } else if (hourMatch) {
    const hours = parseInt(hourMatch[1], 10);
    timeRangeMs = hours * 60 * 60 * 1000;
    timeRange = `-${hours}h`;
  } else if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    timeRangeMs = days * 24 * 60 * 60 * 1000;
    timeRange = `-${days}d`;
  }

  // Default time range
  if (!timeRange) {
    if (type === 'list_logs') {
      timeRangeMs = 60 * 60 * 1000;
      timeRange = '-1h';
    } else {
      timeRangeMs = 24 * 60 * 60 * 1000;
      timeRange = '-24h';
    }
  }

  // If we have a deployment but no namespace, infer it
  if (deployment && !namespace) {
    const parts = deployment.split('-');
    if (parts.length > 1 && KNOWN_NAMESPACES.includes(parts[0])) {
      namespace = parts[0];
    }
  }

  return {
    type: type === 'unknown' && namespace ? 'performance' : type,
    namespace,
    deployment,
    region,
    timeRange,
    timeRangeMs,
  };
}

export function getHelpBlocks(): any[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Opvi — Planview Observability Bot', emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Real-time insights from real time data, powered by Falcon AI + MCP Tools',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*📊 Performance & Metrics*\n' +
          '`How is okrs performing in APAC?`\n' +
          '`Show me error rate trends for logbook in US`\n' +
          '`What is the latency for roadmaps in EU?`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*📋 Log Inspection*\n' +
          '`List okrs errors in APAC for the last 1 hour`\n' +
          '`Show logbook-odata logs in US last 30 minutes`\n' +
          '`Show me recent errors for roadmaps`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*🔍 Issue Detection & Root Cause*\n' +
          '`Any issues with okrs in APAC?`\n' +
          '`Detect problems in logbook across all regions`\n' +
          '`What is failing in roadmaps EU?`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*📈 Log Summaries*\n' +
          '`Summarize okrs logs in US for the last 24 hours`\n' +
          '`Give me a log overview for logbook in APAC`',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*🚀 Throughput & Infra*\n' +
          '`What is the throughput of okrs across all regions?`\n' +
          '`Show CPU and memory metrics for okrs in APAC`',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: '*🌍 Regions*\n`APAC` (aps2-prod)\n`US` (usw2-prod)\n`EU` (euc1-prod)\n`all regions`',
        },
        {
          type: 'mrkdwn',
          text: '*📦 Applications*\nokrs • logbook • roadmaps\nspaces • pvgroups\nwhiteboards • comments',
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: '*⏰ Time Ranges*\n`last 1 hour` • `last 6 hours`\n`last 24 hours` • `last 7 days`',
        },
        {
          type: 'mrkdwn',
          text: '*🔧 Deployments*\nokrs-api • hasura\nokrs-odata • odata-hasura',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '💡 *Tip:* Just ask naturally! Opvi understands questions like _"How is okrs doing?"_ or _"Any problems in logbook?"_',
        },
      ],
    },
  ];
}
