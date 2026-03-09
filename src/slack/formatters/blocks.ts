import type { SectionBlock, HeaderBlock, DividerBlock, ContextBlock, RichTextBlock, ActionsBlock } from '@slack/web-api';

/**
 * Slack Block Kit primitives for building rich, demo-worthy messages
 */

export function header(text: string): HeaderBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text: text.substring(0, 150), emoji: true },
  };
}

export function divider(): DividerBlock {
  return { type: 'divider' };
}

export function section(text: string): SectionBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: text.substring(0, 3000) },
  };
}

export function sectionWithFields(fields: string[]): SectionBlock {
  return {
    type: 'section',
    fields: fields.slice(0, 10).map((f) => ({ type: 'mrkdwn' as const, text: f.substring(0, 2000) })),
  };
}

export function sectionWithAccessory(text: string, accessory: any): SectionBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: text.substring(0, 3000) },
    accessory,
  };
}

export function context(elements: string[]): ContextBlock {
  return {
    type: 'context',
    elements: elements.slice(0, 10).map((e) => ({ type: 'mrkdwn' as const, text: e.substring(0, 2000) })),
  };
}

// ──────────────────────────────────────────────────────────
// Status & formatting helpers
// ──────────────────────────────────────────────────────────

export function statusEmoji(status: string): string {
  const lower = status.toLowerCase();
  if (lower.includes('healthy') || lower.includes('good') || lower.includes('success')) return '🟢';
  if (lower.includes('warning') || lower.includes('degraded') || lower.includes('medium')) return '🟡';
  if (lower.includes('critical') || lower.includes('error') || lower.includes('unhealthy') || lower.includes('high')) return '🔴';
  return '⚪';
}

export function severityBar(level: string): string {
  const l = level.toLowerCase();
  if (l === 'critical' || l === 'high') return '🔴🔴🔴';
  if (l === 'medium' || l === 'warning') return '🟡🟡';
  if (l === 'low') return '🟢';
  return '⚪';
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(0);
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1_000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

export function progressBar(value: number, max: number, length: number = 10): string {
  const ratio = Math.min(value / (max || 1), 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

export function trendArrow(values: number[]): string {
  if (values.length < 2) return '➡️';
  const first = values[0];
  const last = values[values.length - 1];
  const diff = last - first;
  const pct = first > 0 ? (diff / first) * 100 : 0;
  if (pct > 20) return '📈 ↑ increasing';
  if (pct < -20) return '📉 ↓ decreasing';
  return '➡️ → stable';
}

// ──────────────────────────────────────────────────────────
// Rich composite blocks for demo-worthy output
// ──────────────────────────────────────────────────────────

/** Summary card — top of a response */
export function summaryCard(
  emoji: string,
  title: string,
  subtitle: string,
  fields: { label: string; value: string }[],
): any[] {
  const blocks: any[] = [
    header(`${emoji} ${title}`),
    context([subtitle]),
    divider(),
  ];

  // Two fields per row
  for (let i = 0; i < fields.length; i += 2) {
    const pair = fields.slice(i, i + 2);
    blocks.push(
      sectionWithFields(pair.map((f) => `*${f.label}*\n${f.value}`)),
    );
  }

  return blocks;
}

/** Metric row — label + value with optional spark */
export function metricRow(label: string, value: string, spark?: string): string {
  return spark ? `*${label}:*  ${value}  ${spark}` : `*${label}:*  ${value}`;
}

/** Alert box */
export function alertBox(severity: 'critical' | 'warning' | 'info', message: string): any {
  const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  return section(`${emoji} ${message}`);
}

/** Region header with flag */
export function regionHeader(region: string): any {
  const flags: Record<string, string> = {
    'usw2-prod': '🇺🇸 US West (usw2-prod)',
    'euc1-prod': '🇪🇺 EU Central (euc1-prod)',
    'aps2-prod': '🇦🇺 AP Southeast (aps2-prod)',
  };
  return section(`*${flags[region] || region}*`);
}
