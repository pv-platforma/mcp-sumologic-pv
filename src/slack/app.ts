import { App, LogLevel } from '@slack/bolt';
import { parseCommand, getHelpBlocks } from './parser.js';
import { getOrchestrator } from './orchestrator.js';

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

  // Help
  if (command.type === 'help') {
    await say({ blocks: getHelpBlocks(), text: 'Help', thread_ts: threadTs });
    return;
  }

  // Unknown
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

  // Missing namespace
  if (!command.namespace && !command.deployment) {
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

  // Send loading message with rich formatting
  const target = command.deployment || command.namespace;
  const regionLabel =
    command.region === 'all' || !command.region ? '🌍 all regions' : command.region;
  const typeLabels: Record<string, string> = {
    performance: '📊 performance metrics',
    list_logs: '📋 log entries',
    summarize_logs: '📈 log summary',
    detect_issues: '🔍 issue detection',
    throughput: '🚀 throughput analysis',
  };
  const actionLabel = typeLabels[command.type] || command.type.replace('_', ' ');
  await say({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ *Analyzing ${actionLabel}* for \`${target}\` in ${regionLabel}...\n_Querying Sumo Logic via MCP tools (last ${command.timeRange})_`,
        },
      },
    ],
    text: `Analyzing ${target}...`,
    thread_ts: threadTs,
  });

  try {
    // Orchestrator: Slack → Open WebUI → LLM → MCP Tools → Sumo Logic
    const result = await orchestrator.process(command, text);

    await say({
      blocks: result.blocks,
      text: result.text,
      thread_ts: threadTs,
    });
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
    console.log(`\n\n========================================`);
    console.log(`[Slack] app_mention RECEIVED!`);
    console.log(`[Slack] Raw text: "${event.text}"`);
    console.log(`[Slack] Cleaned: "${text}"`);
    console.log(`[Slack] Channel: ${event.channel}, User: ${event.user}`);
    console.log(`========================================\n`);
    await handleCommand(text, say, event.ts);
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
    console.log(`[Slack] DM from ${msg.user}: "${text}"`);
    await handleCommand(text, say);
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
