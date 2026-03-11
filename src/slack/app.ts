import { App, LogLevel } from '@slack/bolt';
import { parseCommand, getHelpBlocks } from './parser.js';
import { getOrchestrator } from './orchestrator.js';
import { getAIClient } from './aiClient.js';
import { conversationManager } from './conversationManager.js';

// App and orchestrator are created lazily after dotenv loads
let app: App;
let orchestrator: ReturnType<typeof getOrchestrator>;

// ============================================
// UNIFIED COMMAND HANDLER
// ============================================

async function handleCommand(
  text: string,
  say: Function,
  threadTs?: string
): Promise<void> {
  const command = parseCommand(text);

  console.log(`[Slack] Parsed command:`, JSON.stringify(command));

  // ── Conversation context for thread follow-ups ──
  const conversation = conversationManager.getConversation(threadTs);
  const threadContext = conversationManager.getContext(threadTs);

  // Help
  if (command.type === 'help') {
    await say({ blocks: getHelpBlocks(), text: 'Help', thread_ts: threadTs });
    return;
  }

  // ── Follow-up detection ──
  // If command is "unknown" but we're in a thread with history,
  // treat it as a follow-up question and let the LLM handle it with context
  if (command.type === 'unknown' && conversation.isFollowUp && conversation.history.length > 0) {
    console.log(`[Slack] Follow-up detected in thread ${threadTs}: "${text}"`);

    try {
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⏳ *Digging deeper...*\n_Analyzing your follow-up with thread context_`,
            },
          },
        ],
        text: 'Analyzing follow-up...',
        thread_ts: threadTs,
      });

      const followUpPrompt = `Context: The user is asking a follow-up about ${threadContext.namespace || 'a Planview service'}${threadContext.region ? ` in region ${threadContext.region}` : ''}.

Their follow-up question: "${text}"

IMPORTANT: Use MCP tools to fetch fresh data if needed. Reference conversation history for context about what was discussed, but ALWAYS fetch real data — never reuse old numbers.${threadContext.namespace ? `\nApplication/Namespace: ${threadContext.namespace}` : ''}${threadContext.region ? `\nRegion: ${threadContext.region}` : ''}`;

      const aiClient = getAIClient();
      const response = await aiClient.query(followUpPrompt, {
        chatId: conversation.chatId,
        history: conversation.history,
        isFollowUp: true,
      });

      // Store in conversation history
      if (threadTs) {
        conversationManager.addUserMessage(threadTs, text);
        conversationManager.addAssistantMessage(threadTs, response.text);
      }

      // Format and send
      const resultBlocks = orchestrator.parseMarkdownToBlocks(response.text);
      await say({
        blocks: resultBlocks.slice(0, 48),
        text: response.text.substring(0, 200),
        thread_ts: threadTs,
      });
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Slack] Follow-up error: ${message}`);
      await say({
        text: `❌ Sorry, I couldn't process your follow-up. Try a specific question like _"show error rate for okrs in APAC"_`,
        thread_ts: threadTs,
      });
      return;
    }
  }

  // Unknown (not a follow-up)
  if (command.type === 'unknown') {
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "🤔 I didn't quite catch that. Here are some things you can ask me:\n\n" +
              '  •  `How is okrs performing in APAC?`\n' +
              '  •  `Show me logbook errors in US`\n' +
              '  •  `Any issues with roadmaps?`\n' +
              '  •  `help` for all commands',
          },
        },
      ],
      text: "I didn't understand that. Try `help`.",
      thread_ts: threadTs,
    });
    return;
  }

  // Missing namespace — but check thread context first
  if (!command.namespace && !command.deployment) {
    // Try inheriting from thread context
    if (threadContext.namespace) {
      command.namespace = threadContext.namespace;
      console.log(`[Slack] Inherited namespace from thread: ${threadContext.namespace}`);
    } else {
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ *Missing application name*\n\n' +
                'Please specify which application to analyze:\n' +
                '  •  `How is okrs performing in APAC?`\n' +
                '  •  `Show logbook errors in EU`\n\n' +
                '_Available: okrs, logbook, roadmaps, spaces, pvgroups, whiteboards_',
            },
          },
        ],
        text: 'Please specify an application name.',
        thread_ts: threadTs,
      });
      return;
    }
  }

  // Send loading message with rich formatting
  const target = command.deployment || command.namespace;
  const regionLabel =
    command.region === 'all' || !command.region ? '🌍 all regions' : command.region;
  const typeLabels: Record<string, string> = {
    performance: '📊 performance metrics',
    error_rate: '🔴 error rates',
    latency: '⏱️ latency metrics',
    list_logs: '📋 log entries',
    summarize_logs: '📈 log summary',
    detect_issues: '🔍 issue detection',
    throughput: '🚀 throughput analysis',
  };
  const actionLabel = typeLabels[command.type] || command.type.replace('_', ' ');

  // For single-region: show a loading message
  // For all-region: the orchestrator will post its own streaming header
  const isAllRegions = !command.region || command.region === 'all';
  const isPerformance = command.type === 'performance';
  // Skip loading message if orchestrator will stream (all regions, or performance breakdown)
  if (!isAllRegions && !isPerformance) {
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⏳ *Analyzing ${actionLabel}* for \`${target}\` in ${regionLabel}...\n_Getting the results via MCP tools (last ${command.timeRange})_`,
          },
        },
      ],
      text: `Analyzing ${target}...`,
      thread_ts: threadTs,
    });
  }

  try {
    // Orchestrator handles ALL streaming — posts each sub-result via say()
    // as it arrives (sequentially), for both single and multi-region queries.
    const wrappedSay = async (msg: any) => say({ ...msg, thread_ts: threadTs });
    await orchestrator.process(command, text, wrappedSay, threadTs);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Slack] Handler error:', message);
    await say({
      text: `❌ Error: ${message}`,
      thread_ts: threadTs,
    });
  }
}

export async function startSlackBot(): Promise<void> {
  // Create the Slack app NOW (after dotenv has loaded env vars)
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: LogLevel.INFO,
  });

  orchestrator = getOrchestrator();

  // Global error handlers
  app.error(async (error) => {
    console.error('[Slack] GLOBAL ERROR:', error);
  });

  // Register event handlers
  // Handle app mentions (@bot message) in channels
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();
    // Use thread_ts if this is a reply in a thread, otherwise use event.ts to start a new thread
    const threadTs = (event as any).thread_ts || event.ts;
    console.log(`\n\n========================================`);
    console.log(`[Slack] app_mention RECEIVED!`);
    console.log(`[Slack] Cleaned: "${text}"`);
    console.log(`[Slack] Channel: ${event.channel}, User: ${event.user}, Thread: ${threadTs}`);
    console.log(`========================================\n`);
    await handleCommand(text, say, threadTs);
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    const msg = message as any;
    console.log(`\n[Slack] message event:`, JSON.stringify({
      type: msg.type,
      subtype: msg.subtype,
      channel_type: msg.channel_type,
      channel: msg.channel,
      bot_id: msg.bot_id,
      user: msg.user,
      text: msg.text?.substring(0, 80),
      thread_ts: msg.thread_ts,
    }));

    // Skip message subtypes (edits, deletes, joins, etc.)
    if (msg.subtype) {
      console.log(`[Slack] Skipping: subtype=${msg.subtype}`);
      return;
    }

    // Skip bot messages (avoid infinite loops)
    if (msg.bot_id) {
      console.log(`[Slack] Skipping: bot message`);
      return;
    }

    // Only respond to DMs, not channel messages (those use @mentions)
    if (msg.channel_type !== 'im') {
      console.log(`[Slack] Skipping: channel_type=${msg.channel_type} (not DM)`);
      return;
    }

    if (!msg.text) return;

    const text = msg.text.trim();
    // Use thread_ts if this is a reply in a thread, otherwise use msg.ts
    const threadTs = msg.thread_ts || msg.ts;
    console.log(`[Slack] DM from ${msg.user} (thread: ${threadTs}): "${text}"`);
    await handleCommand(text, say, threadTs);
  });

  // Handle /platforma slash command
  app.command('/platforma', async ({ command, ack, respond }) => {
    await ack();
    console.log(`[Slack] /platforma: "${command.text}"`);
    const say = async (msg: any) => {
      if (typeof msg === 'string') {
        await respond({ text: msg, response_type: 'in_channel' });
      } else {
        await respond({ ...msg, response_type: 'in_channel' });
      }
    };
    await handleCommand(command.text, say);
  });

  const port = parseInt(process.env.SLACK_PORT || '3001', 10);
  await app.start(port);
  console.log(`⚡️ Opvi is running`);
  console.log(`   🔗 Open WebUI: ${process.env.OPENWEBUI_URL || 'not configured'}`);
  console.log(`   🤖 Model: ${process.env.OPENWEBUI_MODEL || 'not configured'}`);
  console.log(`   📋 Listening for: @mentions, DMs, /platforma`);
}
