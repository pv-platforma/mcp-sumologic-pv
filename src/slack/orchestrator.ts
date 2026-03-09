import { getAIClient, AIClient } from './aiClient.js';
import type { ParsedCommand } from './parser.js';
import type { KnownBlock } from '@slack/web-api';
import { header, divider, section, context } from './formatters/blocks.js';

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
 * Key fix: We pass `tool_ids` in the API request so Open WebUI activates
 * MCP tools on the server side (same behavior as the web UI).
 *
 * To avoid 504 gateway timeouts (60s nginx limit on Falcon AI):
 * - Single-region queries are sent directly (~34-47s, within limit)
 * - All-region queries are split into parallel per-region queries
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
      return {
        blocks: [
          header('❌ Error'),
          divider(),
          section(`Something went wrong: \`${message}\``),
          context(['💡 Try again or check the logs']),
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
      'usw2-prod': '🇺🇸 US West',
      'euc1-prod': '🇪🇺 EU Central',
      'aps2-prod': '🇦🇺 AP Southeast',
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
   * Convert AI text response into Slack Block Kit blocks
   */
  private formatForSlack(
    command: ParsedCommand,
    aiText: string,
  ): { blocks: KnownBlock[]; text: string } {
    const blocks: KnownBlock[] = [];
    const target = command.deployment || command.namespace || 'unknown';
    const regionLabel =
      !command.region || command.region === 'all' ? 'All Regions' : command.region;

    // Header
    const typeEmoji: Record<string, string> = {
      list_logs: '📋',
      performance: '📊',
      throughput: '🌍',
      detect_issues: '🔍',
      summarize_logs: '📈',
      help: '❓',
      unknown: '📌',
    };

    blocks.push(header(`${typeEmoji[command.type] || '📌'} ${target} — ${regionLabel}`));
    blocks.push(divider());

    // Parse the AI markdown response into Slack blocks
    const contentBlocks = this.parseMarkdownToBlocks(aiText);
    blocks.push(...contentBlocks);

    // Footer
    blocks.push(divider());
    blocks.push(
      context([
        `🕐 ${new Date().toISOString()} | Last ${command.timeRange} | via Falcon AI + MCP Tools`,
      ]),
    );

    return {
      blocks,
      text: aiText.substring(0, 200) + (aiText.length > 200 ? '...' : ''),
    };
  }

  /**
   * Parse markdown text from AI into Slack blocks.
   * Handles headers, tables, lists, code blocks.
   */
  private parseMarkdownToBlocks(markdown: string): KnownBlock[] {
    const blocks: KnownBlock[] = [];
    const lines = markdown.split('\n');
    let currentText = '';
    let inCodeBlock = false;
    let codeContent = '';

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

    for (const line of lines) {
      // Code block toggle
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          flushCode();
          inCodeBlock = false;
        } else {
          flushText();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += line + '\n';
        continue;
      }

      // Headers
      if (line.startsWith('### ')) {
        flushText();
        blocks.push(section(`*${line.replace('### ', '').trim()}*`));
        continue;
      }
      if (line.startsWith('## ')) {
        flushText();
        blocks.push(divider());
        blocks.push(section(`*${line.replace('## ', '').trim()}*`));
        continue;
      }
      if (line.startsWith('# ')) {
        flushText();
        blocks.push(header(line.replace('# ', '').trim()));
        continue;
      }

      // Horizontal rule → divider
      if (line.trim() === '---' || line.trim() === '***') {
        flushText();
        blocks.push(divider());
        continue;
      }

      // Table rows → fields or text
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        if (line.includes('---')) continue; // skip separator

        const cells = line
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c);

        if (cells.length === 2) {
          currentText += `*${cells[0]}:* ${cells[1]}\n`;
        } else if (cells.length > 2) {
          currentText += cells.join(' | ') + '\n';
        }
        continue;
      }

      // Regular text
      currentText += line + '\n';
    }

    // Flush remaining
    if (inCodeBlock) flushCode();
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
