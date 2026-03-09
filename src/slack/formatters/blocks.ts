import type { SectionBlock, HeaderBlock, DividerBlock, ContextBlock } from '@slack/web-api';

/**
 * Slack Block Kit primitives for building rich messages
 */

export function header(text: string): HeaderBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  };
}

export function divider(): DividerBlock {
  return { type: 'divider' };
}

export function section(text: string): SectionBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

export function sectionWithFields(fields: string[]): SectionBlock {
  return {
    type: 'section',
    fields: fields.map((f) => ({ type: 'mrkdwn' as const, text: f })),
  };
}

export function context(elements: string[]): ContextBlock {
  return {
    type: 'context',
    elements: elements.map((e) => ({ type: 'mrkdwn' as const, text: e })),
  };
}

export function statusEmoji(status: string): string {
  const lower = status.toLowerCase();
  if (lower.includes('healthy') || lower.includes('good') || lower.includes('success')) return '🟢';
  if (lower.includes('warning') || lower.includes('degraded')) return '🟡';
  if (lower.includes('critical') || lower.includes('error') || lower.includes('unhealthy')) return '🔴';
  return '⚪';
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(0);
}

export function formatDuration(seconds: number): string {
  if (seconds < 0.001) return `${(seconds * 1_000_000).toFixed(0)}µs`;
  if (seconds < 1) return `${(seconds * 1_000).toFixed(0)}ms`;
  return `${seconds.toFixed(2)}s`;
}

export function progressBar(value: number, max: number, length: number = 10): string {
  const filled = Math.round((value / max) * length);
  const empty = length - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}
