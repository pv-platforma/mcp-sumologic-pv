import { getAIClient, AIClient } from './aiClient.js';
import type { ParsedCommand } from './parser.js';
import type { KnownBlock } from '@slack/web-api';
import { header, divider, section, sectionWithFields, context } from './formatters/blocks.js';
import { conversationManager } from './conversationManager.js';

/**
 * Orchestrator — connects Slack to Falcon AI (Open WebUI) which calls MCP tools.
 *
 * Architecture (Option A):
 *   Slack → Parser → Orchestrator → Falcon AI API (with tool_ids)
 *                                       ↓
 *                                  LLM calls MCP tools server-side
 *                                       ↓
 *                                  MCP Server → Sumo Logic (REAL DATA)
 *                                       ↓
 *                                  LLM formats response
 *                                       ↓
 *                                  Slack Block Kit message
 *
 * STREAMING: Results are posted to Slack SEQUENTIALLY as each query
 * completes — never batched at the end. This keeps the connection alive
 * and avoids ALB/gateway 504 timeouts.
 *
 * For "performance" (metricType=all), we break it into sub-queries:
 *   error_rate → latency → throughput → endpoint_performance
 * Each sub-query is a separate Falcon AI call, streamed individually.
 */

export type SayFn = (msg: { blocks?: KnownBlock[]; text: string; thread_ts?: string }) => Promise<any>;

/**
 * Sub-metrics that make up a full "performance" report.
 * Each becomes a SEPARATE Falcon AI call → SEPARATE MCP tool call.
 * This avoids the MCP tool running all 11 Sumo queries in one call (timeout).
 *
 * Order matters: most critical insights first.
 */
const PERFORMANCE_SUB_METRICS = [
  { metricType: 'error_rate',               emoji: '🔴', label: 'Error Rates' },
  { metricType: 'latency',                 emoji: '⏱️', label: 'Latency' },
  { metricType: 'throughput',              emoji: '🚀', label: 'Throughput' },
  { metricType: 'endpoint_performance',    emoji: '🔗', label: 'Endpoint Performance' },
  { metricType: 'success_failure_totals',  emoji: '📊', label: 'Success / Failure Totals' },
  { metricType: 'unique_users',            emoji: '👥', label: 'Unique Users' },
] as const;

/** Type → config map */
const TYPE_CONFIG: Record<string, { emoji: string; label: string }> = {
  list_logs:                { emoji: '📋', label: 'Log Entries' },
  performance:              { emoji: '📊', label: 'Performance Report' },
  error_rate:               { emoji: '🔴', label: 'Error Rate Analysis' },
  latency:                  { emoji: '⏱️', label: 'Latency Analysis' },
  throughput:               { emoji: '🚀', label: 'Throughput Analysis' },
  endpoint_performance:     { emoji: '🔗', label: 'Endpoint Performance' },
  success_failure_totals:   { emoji: '📊', label: 'Success / Failure Totals' },
  unique_users:             { emoji: '👥', label: 'Unique Users' },
  detect_issues:            { emoji: '🔍', label: 'Issue Detection' },
  summarize_logs:           { emoji: '📈', label: 'Log Summary' },
  help:                     { emoji: '❓', label: 'Help' },
  unknown:                  { emoji: '🤖', label: 'Analysis' },
};

export class Orchestrator {
  private aiClient: AIClient;

  constructor() {
    this.aiClient = getAIClient();
  }

  /**
   * Main entry point — process a command end-to-end.
   * ALL queries are streamed sequentially via `say()`.
   */
  async process(
    command: ParsedCommand,
    originalText: string,
    say?: SayFn,
    threadTs?: string,
  ): Promise<{ blocks: KnownBlock[]; text: string }> {
    try {
      // ── Conversation context ──
      const conversation = conversationManager.getConversation(threadTs);
      const threadContext = conversationManager.getContext(threadTs);

      // Inherit namespace/region from thread if not specified
      if (!command.namespace && threadContext.namespace) {
        command.namespace = threadContext.namespace;
        console.log(`[Orchestrator] Inherited namespace from thread: ${threadContext.namespace}`);
      }
      if ((!command.region || command.region === 'all') && threadContext.region) {
        command.region = threadContext.region;
        console.log(`[Orchestrator] Inherited region from thread: ${threadContext.region}`);
      }

      // Store context for future follow-ups
      if (threadTs) {
        conversationManager.setContext(threadTs, command.namespace, command.region);
        conversationManager.addUserMessage(threadTs, originalText);
      }

      const regions = this.getRegions(command);
      const target = command.deployment || command.namespace || 'unknown';
      const cfg = TYPE_CONFIG[command.type] || TYPE_CONFIG.unknown;

      // ── Post header ──
      if (say) {
        const regionLabel = regions.length === 1
          ? this.regionFlag(regions[0])
          : '🌍 All Regions';
        await say({
          blocks: [
            header(`${cfg.emoji} ${cfg.label} — ${target}`),
            context([
              `${regionLabel}  •  Last \`${command.timeRange}\`  •  ${new Date().toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`,
            ]),
            divider(),
          ],
          text: `${cfg.label} for ${target}`,
          thread_ts: threadTs,
        });
      }

      // ── Determine sub-queries ──
      // "performance" = run error_rate, latency, throughput, endpoint_performance separately
      // everything else = single query per region
      const subQueries = command.type === 'performance'
        ? PERFORMANCE_SUB_METRICS.map(m => ({
            metricType: m.metricType,
            emoji: m.emoji,
            label: m.label,
          }))
        : [{ metricType: command.type, emoji: cfg.emoji, label: cfg.label }];

      let allText = '';
      let successCount = 0;
      let errorCount = 0;

      // ── For each region → for each sub-query → run & stream ──
      for (const region of regions) {
        const flag = this.regionFlag(region);

        // Show region header if multiple regions
        if (regions.length > 1 && say) {
          await say({
            blocks: [divider(), header(flag)],
            text: flag,
            thread_ts: threadTs,
          });
        }

        for (const sub of subQueries) {
          // Build a focused command for this specific sub-query + region
          const subCommand: ParsedCommand = {
            ...command,
            region,
            type: sub.metricType as ParsedCommand['type'],
          };
          const isSubQuery = subQueries.length > 1;
          const enrichedPrompt = this.enrichQuery(subCommand, originalText, isSubQuery);

          console.log(`[Orchestrator] ${flag} → ${sub.label}...`);

          if (say && subQueries.length > 1) {
            // Show progress indicator for each sub-query
            await say({
              blocks: [
                context([`${sub.emoji} _Fetching ${sub.label.toLowerCase()}..._`]),
              ],
              text: `Fetching ${sub.label}...`,
              thread_ts: threadTs,
            });
          }

          try {
            const response = await this.aiClient.query(enrichedPrompt, {
              history: conversation.history,
              isFollowUp: conversation.isFollowUp,
            });

            if (response.text) {
              successCount++;
              allText += `\n\n## ${flag} — ${sub.label}\n\n${response.text}`;

              // ── Stream this result to Slack immediately ──
              if (say) {
                const resultBlocks = this.parseMarkdownToBlocks(response.text);

                // Add sub-query label if performance breakdown
                const blocks: KnownBlock[] = [];
                if (subQueries.length > 1) {
                  blocks.push(section(`*${sub.emoji} ${sub.label}*`));
                }
                blocks.push(...resultBlocks);

                await say({
                  blocks: blocks.slice(0, 49),
                  text: `${sub.label}: ${response.text.substring(0, 200)}`,
                  thread_ts: threadTs,
                });
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Orchestrator] ${flag} ${sub.label} failed: ${msg}`);
            errorCount++;

            if (say) {
              const isTimeout = msg.includes('504') || msg.includes('timeout');
              await say({
                blocks: [
                  section(`${sub.emoji} ${sub.label}  ⚠️ ${isTimeout ? 'Timed out' : 'Failed'}: _${msg.substring(0, 200)}_`),
                ],
                text: `${sub.label}: Error`,
                thread_ts: threadTs,
              });
            }
          }
        }
      }

      // ── Post footer ──
      const summaryParts: string[] = [];

      if (say) {
        await say({
          blocks: [
            divider(),
            context([
              `${summaryParts.join('  •  ')}  •  *Opvi* — powered by Falcon AI + MCP Tools`,
            ]),
          ],
          text: summaryParts.join(' | '),
          thread_ts: threadTs,
        });
      }

      // ── Store a brief summary in conversation history (NOT all the raw data) ──
      // This keeps thread context lightweight for follow-up questions
      if (threadTs && allText) {
        const briefSummary = `Ran ${command.type} for ${target} in ${regions.map(r => this.regionFlag(r)).join(', ')}. ` +
          `${successCount} succeeded, ${errorCount} failed. ` +
          `Metrics queried: ${subQueries.map(s => s.label).join(', ')}.`;
        conversationManager.addAssistantMessage(threadTs, briefSummary);
      }

      // Return combined text (fallback for non-streaming)
      if (!allText) allText = 'No data returned.';
      return {
        blocks: [section(allText.substring(0, 3000))],
        text: allText.substring(0, 300),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] Error:', message);

      const errorBlocks: KnownBlock[] = [
        header('❌ Request Failed'),
        divider(),
        section(
          message.includes('504') || message.includes('timeout')
            ? `⏱️ *Gateway Timeout*\n\n*Try:*\n  •  Specify a single region: _"okrs error rate in APAC"_\n  •  Use a shorter time range: _"last 1 hour"_\n  •  Request specific metrics: _"latency for okrs in US"_`
            : `Something went wrong:\n\`\`\`${message.substring(0, 500)}\`\`\``,
        ),
        divider(),
        context(['💡 Tip: asking for specific metrics (error rate, latency, throughput) is faster than full performance']),
      ];

      if (say) {
        await say({
          blocks: errorBlocks,
          text: `Error: ${message}`,
          thread_ts: threadTs,
        });
      }

      return { blocks: errorBlocks, text: `Error: ${message}` };
    }
  }

  /** Get the list of regions to query */
  private getRegions(command: ParsedCommand): string[] {
    if (command.region && command.region !== 'all') {
      return [command.region];
    }
    return ['usw2-prod', 'euc1-prod', 'aps2-prod'];
  }

  /**
   * Enrich the user query with explicit context so the LLM
   * knows exactly which MCP tool parameters to use.
   *
   * @param isSubQuery — true when this is one part of a "performance" breakdown.
   *   Sub-queries get a terse prompt: "just the data, no summary/recommendations".
   *   Standalone queries get the full treatment.
   */
  private enrichQuery(command: ParsedCommand, originalText: string, isSubQuery: boolean = false): string {
    const parts: string[] = [];
    const hints: string[] = [];

    // For sub-queries: replace the original prompt with a focused one
    if (isSubQuery) {
      const target = command.deployment || command.namespace || 'unknown';
      parts.push(`Show ${command.type.replace('_', ' ')} for ${target} in ${command.region}.`);
      hints.push(
        'OUTPUT FORMAT: Be concise. Show ONLY the data in a table or bullet points. ' +
        'Do NOT include Overall Health, Recommendations, Summary, or Details sections. ' +
        'Do NOT include introductory text. Just the metric data.'
      );
    } else {
      parts.push(originalText);
    }

    // ALWAYS include region — this is critical to avoid all-region queries
    // that exceed the 60s gateway timeout
    if (command.region && command.region !== 'all') {
      hints.push(`Region: ${command.region} (IMPORTANT: pass this exact region to the tool)`);
    }
    if (command.namespace) {
      hints.push(`Application/Namespace: ${command.namespace}`);
    }
    if (command.deployment) {
      hints.push(`Deployment: ${command.deployment}`);
    }
    if (command.timeRange) {
      hints.push(`Time range: ${command.timeRange}`);
    }

    // Map command type to specific MCP tool hint.
    // IMPORTANT: Never use metricType "all" — it runs 11 Sumo queries in one call and times out.
    // The orchestrator breaks "performance" into individual sub-queries, each with its own metricType.
    const toolHints: Record<string, string> = {
      error_rate: 'Use the get_performance_metrics tool with metricType "error_rate" ONLY. Do NOT run endpoint_performance, throughput, latency, or any other metric.',
      latency: 'Use the get_performance_metrics tool with metricType "latency" ONLY. Do NOT run endpoint_performance, throughput, error_rate, or any other metric.',
      throughput: 'Use the get_performance_metrics tool with metricType "throughput" ONLY. Do NOT run endpoint_performance, latency, error_rate, or any other metric.',
      endpoint_performance: 'Use the get_performance_metrics tool with metricType "endpoint_performance" ONLY. Do NOT run error_rate, latency, throughput, or any other metric.',
      success_failure_totals: 'Use the get_performance_metrics tool with metricType "success_failure_totals" ONLY. Do NOT run any other metric.',
      unique_users: 'Use the get_performance_metrics tool with metricType "unique_users" ONLY. Do NOT run any other metric.',
      user_activity: 'Use the get_performance_metrics tool with metricType "user_activity" ONLY. Do NOT run any other metric.',
      list_logs: 'Use the list_logs tool to fetch actual log entries',
      summarize_logs: 'Use the summarize_logs tool for log distribution and top errors',
      detect_issues: 'Use the detect_issues tool to find anomalies and error spikes',
    };

    if (toolHints[command.type]) {
      hints.push(toolHints[command.type]);
    }

    if (hints.length > 0) {
      parts.push(`\n[Context for tool parameters: ${hints.join(', ')}]`);
    }

    return parts.join('');
  }

  /** Region string → flag label */
  private regionFlag(region: string): string {
    const flags: Record<string, string> = {
      'usw2-prod': '🇺🇸 US West',
      'euc1-prod': '🇪🇺 EU Central',
      'aps2-prod': '🇦🇺 AP Southeast',
    };
    return flags[region] || region;
  }

  /**
   * Parse markdown text from AI into beautiful Slack blocks.
   * Handles headers, tables, bullet lists, bold/italic, code blocks, numbered lists.
   */
  public parseMarkdownToBlocks(markdown: string): KnownBlock[] {
    const blocks: KnownBlock[] = [];
    const lines = markdown.split('\n');
    let currentText = '';
    let inCodeBlock = false;
    let codeContent = '';
    let inTable = false;
    let tableRows: string[][] = [];
    let tableHeader: string[] = [];

    const flushText = () => {
      if (currentText.trim()) {
        const chunks = this.chunkText(currentText.trim(), 2900);
        for (const chunk of chunks) {
          blocks.push(section(chunk));
        }
        currentText = '';
      }
    };

    const flushCode = () => {
      if (codeContent.trim()) {
        const chunks = this.chunkText(codeContent.trim(), 2900);
        for (const chunk of chunks) {
          blocks.push(section(`\`\`\`${chunk}\`\`\``));
        }
        codeContent = '';
      }
    };

    const flushTable = () => {
      if (tableRows.length === 0) return;

      // For 2-column tables, use Slack fields (side by side)
      if (tableHeader.length === 2 && tableRows.length <= 5) {
        const fields = tableRows.map(
          (row) => `*${row[0] || ''}*\n${row[1] || ''}`,
        );
        // Slack allows max 10 fields, 2 per row = 5 visual rows
        for (let i = 0; i < fields.length; i += 2) {
          blocks.push(sectionWithFields(fields.slice(i, i + 2)));
        }
      } else {
        // Multi-column: format as aligned text
        let tableText = '';
        if (tableHeader.length > 0) {
          tableText += `*${tableHeader.join('  |  ')}*\n`;
        }
        for (const row of tableRows.slice(0, 15)) {
          tableText += row.join('  |  ') + '\n';
        }
        if (tableRows.length > 15) {
          tableText += `_...and ${tableRows.length - 15} more rows_\n`;
        }
        if (tableText.trim()) {
          const chunks = this.chunkText(tableText.trim(), 2900);
          for (const chunk of chunks) {
            blocks.push(section(chunk));
          }
        }
      }

      tableRows = [];
      tableHeader = [];
      inTable = false;
    };

    for (const line of lines) {
      // Code block toggle
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          flushCode();
          inCodeBlock = false;
        } else {
          flushText();
          flushTable();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += line + '\n';
        continue;
      }

      // ── Table handling ──
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const cells = line
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c);

        // Skip separator rows (|---|---|)
        if (cells.every((c) => /^[-:]+$/.test(c))) continue;

        if (!inTable) {
          flushText();
          inTable = true;
          tableHeader = cells;
        } else {
          tableRows.push(cells);
        }
        continue;
      } else if (inTable) {
        flushTable();
      }

      // ── Headers ──
      if (line.startsWith('#### ')) {
        flushText();
        blocks.push(section(`*${line.replace('#### ', '').trim()}*`));
        continue;
      }
      if (line.startsWith('### ')) {
        flushText();
        blocks.push(section(`\n*${line.replace('### ', '').trim()}*`));
        continue;
      }
      if (line.startsWith('## ')) {
        flushText();
        blocks.push(divider());
        blocks.push(header(line.replace('## ', '').trim().substring(0, 150)));
        continue;
      }
      if (line.startsWith('# ')) {
        flushText();
        blocks.push(header(line.replace('# ', '').trim().substring(0, 150)));
        continue;
      }

      // ── Horizontal rule → divider ──
      if (line.trim() === '---' || line.trim() === '***' || line.trim() === '===') {
        flushText();
        blocks.push(divider());
        continue;
      }

      // ── Bullet lists — convert to Slack bullet ──
      if (/^\s*[-*]\s/.test(line)) {
        const bullet = line.replace(/^\s*[-*]\s/, '').trim();
        currentText += `  •  ${bullet}\n`;
        continue;
      }

      // ── Numbered lists ──
      if (/^\s*\d+\.\s/.test(line)) {
        const item = line.replace(/^\s*\d+\.\s/, '').trim();
        const num = line.match(/^\s*(\d+)\./)?.[1] || '•';
        currentText += `  ${num}.  ${item}\n`;
        continue;
      }

      // ── Empty lines — flush current block to create visual spacing ──
      if (line.trim() === '') {
        if (currentText.trim()) {
          currentText += '\n';
        }
        continue;
      }

      // ── Regular text ──
      currentText += line + '\n';
    }

    // Flush remaining
    if (inCodeBlock) flushCode();
    flushTable();
    flushText();

    return blocks;
  }

  private chunkText(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1) breakPoint = maxLength;

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trimStart();
    }

    return chunks;
  }
}

// Singleton
let orchestratorInstance: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new Orchestrator();
  }
  return orchestratorInstance;
}
