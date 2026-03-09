/**
 * AI Client that connects to Open WebUI (Falcon AI).
 *
 * The MCP Sumo Logic server is registered as a tool in Open WebUI.
 * We pass `tool_ids` in the API request so Open WebUI executes MCP tools
 * server-side (just like the web UI does), returning REAL data.
 *
 * Flow: Slack → AI Client → Open WebUI API → LLM → MCP Tools → Sumo Logic → real data
 */

export interface AIClientConfig {
  /** Base URL of Open WebUI (e.g., https://falconai.planview-dev.io) */
  baseUrl: string;
  /** API key from Open WebUI (Settings → Account → API Keys) */
  apiKey: string;
  /** Model ID as shown in Open WebUI */
  model: string;
  /** Max tokens for response */
  maxTokens?: number;
}

export interface AIResponse {
  text: string;
}

const SYSTEM_PROMPT = `You are Opvi, a Planview observability and monitoring bot running in Slack. You have access to MCP tools that query Sumo Logic for real-time observability data.

When the user asks about application performance, logs, issues, or metrics:
1. Use the appropriate MCP tool to fetch REAL data from Sumo Logic.
2. Analyze the real data returned by the tools.
3. Present a clear, structured analysis.

CRITICAL RULES:
- ALWAYS use MCP tools to fetch data. NEVER make up or hallucinate numbers.
- If a tool returns no data or an error, report that honestly.
- Never invent metrics, endpoints, user IDs, or counts.
- Every number in your response MUST come from actual tool results.

Available MCP tools and when to use them:
- get_performance_metrics: For performance, latency, throughput, error rates, error rate trends, latency trends, user activity
- list_logs: For showing actual log entries
- summarize_logs: For log level distribution, top errors, log volume per deployment
- detect_issues: For finding anomalies, error spikes, slow endpoints with per-deployment breakdown
- get_metrics: For CPU/memory/infrastructure metrics across all deployments in a namespace
- search_sumologic: For custom Sumo Logic queries

Region mapping:
- "APAC" / "apac" / "sydney" = aps2-prod
- "US" / "us" / "us-west" = usw2-prod
- "EU" / "eu" / "europe" = euc1-prod

OUTPUT FORMAT (Slack Markdown):
Structure your responses with clear sections using Markdown headers and formatting:

## Overall Health
Start with a one-line health verdict: 🟢 Healthy / 🟡 Degraded / 🔴 Critical

## Key Metrics
Present critical numbers in a clear 2-column format:
| Metric | Value |
|---|---|
| Total Requests | 12,345 |
| Error Rate | 2.1% |

## Details
Use bullet points for insights:
- *Slowest endpoint:* \`GET /api/v1/objectives\` — P95: 3,200ms
- *Top error:* 503 Service Unavailable (45 occurrences)

## Trend Analysis
When trend data is available, describe whether metrics are increasing, decreasing, or stable.

## Recommendations
Numbered actionable items:
1. Investigate the \`/objectives\` endpoint latency spike
2. Check database connection pool for the hasura deployment

Formatting rules:
- Use *bold* for labels and important values
- Use \`code\` for technical values (endpoints, deployments, IDs)
- Use bullet points (- ) for lists
- Use numbered lists (1. ) for recommendations
- Include emojis for quick scanning: 🟢 🟡 🔴 ⚠️ 📈 📉
- Use tables (| col1 | col2 |) for structured data
- Be concise — no filler text
- Always mention the region, namespace, deployments found, and time range`;

export class AIClient {
  private config: AIClientConfig;
  /** Cached MCP tool IDs to pass to Open WebUI */
  private mcpToolIds: string[] | null = null;

  constructor(config: AIClientConfig) {
    this.config = config;
  }

  /**
   * Get the MCP Sumo Logic tool IDs to pass to Open WebUI.
   *
   * Priority:
   * 1. If OPENWEBUI_TOOL_IDS env var is set, use those (comma-separated)
   * 2. Otherwise, auto-discover from Open WebUI API and filter for Sumo Logic / MCP tools only
   */
  async discoverMcpTools(): Promise<string[]> {
    if (this.mcpToolIds) return this.mcpToolIds;

    // Option 1: Explicit tool IDs from env (recommended)
    const envToolIds = process.env.OPENWEBUI_TOOL_IDS;
    if (envToolIds) {
      this.mcpToolIds = envToolIds.split(',').map((id) => id.trim()).filter(Boolean);
      console.log(`[AIClient] Using configured tool IDs: ${this.mcpToolIds.join(', ')}`);
      return this.mcpToolIds;
    }

    // Option 2: Auto-discover from Open WebUI API
    const toolEndpoints = [
      '/api/v1/tools/',
      '/api/v1/tools/list',
      '/api/tools/',
      '/api/tools/list',
    ];

    for (const endpoint of toolEndpoints) {
      try {
        const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
          },
        });

        if (!response.ok) continue;

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) continue;

        const tools = (await response.json()) as Array<{
          id: string;
          name: string;
          meta?: { description?: string };
        }>;

        if (!Array.isArray(tools)) continue;

        console.log(`[AIClient] Found ${tools.length} tools via ${endpoint}`);

        // ONLY pick Sumo Logic / MCP / Opvi related tools — NOT all tools
        const sumoTools = tools.filter(
          (t) =>
            t.id.includes('mcp') ||
            t.id.includes('sumologic') ||
            t.id.includes('sumo') ||
            t.id.includes('opvi') ||
            t.name?.toLowerCase().includes('sumo') ||
            t.name?.toLowerCase().includes('mcp-sumologic') ||
            t.name?.toLowerCase().includes('opvi'),
        );

        if (sumoTools.length > 0) {
          this.mcpToolIds = sumoTools.map((t) => t.id);
          console.log(`[AIClient] Found Sumo Logic tools: ${this.mcpToolIds.join(', ')}`);
        } else {
          console.log(
            `[AIClient] No Sumo Logic tools found. Available tools: ${tools.map((t) => `${t.id} (${t.name})`).join(', ')}`,
          );
          console.log(`[AIClient] Set OPENWEBUI_TOOL_IDS in .env after registering the MCP server.`);
          this.mcpToolIds = [];
        }

        return this.mcpToolIds;
      } catch {
        continue;
      }
    }

    console.warn('[AIClient] Could not discover tools from any endpoint.');
    console.warn('[AIClient] Set OPENWEBUI_TOOL_IDS=<tool-id> in .env after registering MCP server.');
    this.mcpToolIds = [];
    return [];
  }

  /**
   * Send a query to Open WebUI WITH tool_ids so MCP tools are executed server-side.
   *
   * IMPORTANT: Each query should target a SINGLE region to stay within the 60s
   * gateway timeout. The orchestrator handles multi-region by splitting queries.
   */
  async query(userMessage: string): Promise<AIResponse> {
    const url = `${this.config.baseUrl}/api/chat/completions`;

    // Discover MCP tools first
    const toolIds = await this.discoverMcpTools();

    console.log(`[AIClient] Sending to Open WebUI with ${toolIds.length} tool(s): "${userMessage.substring(0, 100)}..."`);
    const startTime = Date.now();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        // Pass tool_ids so Open WebUI activates MCP tools server-side
        ...(toolIds.length > 0 && { tool_ids: toolIds }),
        max_tokens: this.config.maxTokens || 4096,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Open WebUI API error: ${response.status} — ${errorBody}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content || '';
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AIClient] Received response: ${text.length} chars in ${elapsed}s`);

    if (text.length < 100) {
      console.log(`[AIClient] Full response: ${text}`);
    }

    return { text };
  }

  /**
   * Health check — verify Open WebUI is reachable and API key is valid
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models in Open WebUI
   */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.config.baseUrl}/api/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!response.ok) throw new Error('Failed to list models');

    const data = (await response.json()) as {
      data?: Array<{ id: string }>;
    };
    return data.data?.map((m) => m.id) || [];
  }
}

// Singleton
let aiClientInstance: AIClient | null = null;

export function getAIClient(): AIClient {
  if (!aiClientInstance) {
    aiClientInstance = new AIClient({
      baseUrl: process.env.OPENWEBUI_URL || 'https://falconai.planview-dev.io',
      apiKey: process.env.OPENWEBUI_API_KEY || '',
      model: process.env.OPENWEBUI_MODEL || '',
      maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4096', 10),
    });
  }
  return aiClientInstance;
}
