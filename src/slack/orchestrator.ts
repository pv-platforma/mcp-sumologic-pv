import { getAIClient, AIClient } from './aiClient.js';
import type { ParsedCommand } from './parser.js';
import type { KnownBlock } from '@slack/web-api';
import { header, divider, section, sectionWithFields, context } from './formatters/blocks.js';

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
 */

export class Orchestrator {
  private aiClient: AIClient;

  constructor() {
    this.aiClient = getAIClient();
  }

  /**
   * Main entry point — process a command end-to-end
   */
  async process(
    command: ParsedCommand,
    originalText: string,
  ): Promise<{ blocks: KnownBlock[]; text: string }> {
    try {
      // If region is "all" or unspecified, query each region separately and combine
      // This avoids 504 gateway timeouts (all-region queries take 60+ seconds)
      if (!command.region || command.region === 'all') {
        return await this.processAllRegions(command, originalText);
      }

      // Single region query — fits within 60s gateway timeout
      const enrichedPrompt = this.enrichQuery(command, originalText);
      console.log(`[Orchestrator] Sending to Falcon AI for ${command.region}...`);
      const response = await this.aiClient.query(enrichedPrompt);
      return this.formatForSlack(command, response.text);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] Error:', message);

      const isTimeout = message.includes('504') || message.includes('timeout') || message.includes('ETIMEDOUT');

      return {
        blocks: [
          header('❌ Request Failed'),
          divider(),
          section(
            isTimeout
              ? `⏱️ *Gateway Timeout*\nThe query took too long to complete. This usually happens with complex all-region queries.\n\n*Try:*\n  •  Specify a single region: _"okrs performance in APAC"_\n  •  Use a shorter time range: _"last 1 hour"_\n  •  Request specific metrics: _"error rate for okrs in US"_`
              : `Something went wrong:\n\`\`\`${message.substring(0, 500)}\`\`\``,
          ),
          divider(),
          context(['💡 If the issue persists, check Docker logs or try again']),
        ],
        text: `Error: ${message}`,
      };
    }
  }

  /**
   * Query each production region individually and combine results.
   * This avoids the 60s gateway timeout that all-region queries hit.
   */
  private async processAllRegions(
    command: ParsedCommand,
    originalText: string,
  ): Promise<{ blocks: KnownBlock[]; text: string }> {
    const regions = ['usw2-prod', 'euc1-prod', 'aps2-prod'];
    const regionLabels: Record<string, string> = {
      'usw2-prod': 'US',
      'euc1-prod': 'EU',
      'aps2-prod': 'AP',
    };

    const results: string[] = [];
    const errors: string[] = [];

    // Query regions in parallel (each should finish within 60s)
    const promises = regions.map(async (region) => {
      const regionCommand = { ...command, region };
      const enrichedPrompt = this.enrichQuery(regionCommand, originalText);
      console.log(`[Orchestrator] Querying ${region}...`);

      try {
        const response = await this.aiClient.query(enrichedPrompt);
        return { region, text: response.text, error: null };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Orchestrator] ${region} failed: ${msg}`);
        return { region, text: '', error: msg };
      }
    });

    const regionResults = await Promise.all(promises);

    for (const r of regionResults) {
      const label = regionLabels[r.region] || r.region;
      if (r.error) {
        errors.push(`${label}: ⚠️ ${r.error}`);
      } else if (r.text) {
        results.push(`## ${label} (${r.region})\n\n${r.text}`);
      }
    }

    // Combine all region results
    let combinedText = results.join('\n\n---\n\n');
    if (errors.length > 0) {
      combinedText += `\n\n**Errors:**\n${errors.join('\n')}`;
    }

    if (!combinedText) {
      combinedText = 'No data returned from any region.';
    }

    // Override region label for formatting
    const allCommand = { ...command, region: 'all' as string };
    return this.formatForSlack(allCommand, combinedText);
  }

  /**
   * Enrich the user query with explicit context so the LLM
   * knows exactly which MCP tool parameters to use.
   */
  private enrichQuery(command: ParsedCommand, originalText: string): string {
    const parts: string[] = [originalText];
    const hints: string[] = [];

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

    // Map command type to specific MCP tool hint
    const toolHints: Record<string, string> = {
      performance: 'Use the get_performance_metrics tool with metricType "all"',
      list_logs: 'Use the list_logs tool to fetch actual log entries',
      summarize_logs: 'Use the summarize_logs tool for log distribution and top errors',
      detect_issues: 'Use the detect_issues tool to find anomalies and error spikes',
      throughput: 'Use the get_performance_metrics tool with metricType "throughput"',
    };

    if (toolHints[command.type]) {
      hints.push(toolHints[command.type]);
    }

    if (hints.length > 0) {
      parts.push(`\n[Context for tool parameters: ${hints.join(', ')}]`);
    }

    return parts.join('');
  }

  /**
   * Convert AI text response into beautiful Slack Block Kit blocks
   */
  private formatForSlack(
    command: ParsedCommand,
    aiText: string,
  ): { blocks: KnownBlock[]; text: string } {
    const blocks: KnownBlock[] = [];
    const target = command.deployment || command.namespace || 'unknown';
    const regionLabel =
      !command.region || command.region === 'all' ? '🌍 All Regions' : this.regionFlag(command.region);

    // Type-specific header with emoji and title
    const typeConfig: Record<string, { emoji: string; label: string }> = {
      list_logs:      { emoji: '📋', label: 'Log Entries' },
      performance:    { emoji: '📊', label: 'Performance Report' },
      throughput:     { emoji: '🚀', label: 'Throughput Analysis' },
      detect_issues:  { emoji: '🔍', label: 'Issue Detection' },
      summarize_logs: { emoji: '📈', label: 'Log Summary' },
      help:           { emoji: '❓', label: 'Help' },
      unknown:        { emoji: '🤖', label: 'Analysis' },
    };

    const cfg = typeConfig[command.type] || typeConfig.unknown;

    // ── Top header bar ──
    blocks.push(header(`${cfg.emoji} ${cfg.label} — ${target}`));
    blocks.push(
      context([
        `${regionLabel}  •  Last \`${command.timeRange}\`  •  ${new Date().toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`,
      ]),
    );
    blocks.push(divider());

    // ── Parse the AI markdown response into Slack blocks ──
    const contentBlocks = this.parseMarkdownToBlocks(aiText);
    blocks.push(...contentBlocks);

    // ── Footer ──
    blocks.push(divider());
    blocks.push(
      context([
        ` *Opvi* — powered by Falcon AI + MCP Tools `,
      ]),
    );

    // Slack has a 50-block limit per message
    const trimmedBlocks = blocks.slice(0, 49);

    return {
      blocks: trimmedBlocks,
      text: aiText.substring(0, 300) + (aiText.length > 300 ? '...' : ''),
    };
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
  private parseMarkdownToBlocks(markdown: string): KnownBlock[] {
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
