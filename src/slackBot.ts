import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

import { startSlackBot } from './slack/index.js';
import { getAIClient } from './slack/aiClient.js';

// ============================================
// VALIDATE ENVIRONMENT VARIABLES
// ============================================

const requiredSlack = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
const missingSlack = requiredSlack.filter((key) => !process.env[key]);

if (missingSlack.length > 0) {
  console.error(`❌ Missing required Slack variables: ${missingSlack.join(', ')}`);
  console.error('   Please set them in your .env file.');
  console.error('');
  console.error('   SLACK_BOT_TOKEN=xoxb-your-bot-token');
  console.error('   SLACK_SIGNING_SECRET=your-signing-secret');
  console.error('   SLACK_APP_TOKEN=xapp-your-app-level-token');
  process.exit(1);
}

if (!process.env.OPENWEBUI_URL || !process.env.OPENWEBUI_API_KEY) {
  console.error('❌ Missing OPENWEBUI_URL or OPENWEBUI_API_KEY');
  console.error('   Go to Falcon AI → Settings → Account → API Keys to generate one.');
  process.exit(1);
}

if (!process.env.OPENWEBUI_MODEL) {
  console.error('❌ Missing OPENWEBUI_MODEL');
  console.error('   Set it to the model ID shown in Open WebUI model selector.');
  process.exit(1);
}

// ============================================
// VERIFY CONNECTIONS & START
// ============================================

async function verifyConnections(): Promise<void> {
  console.log('🔍 Verifying connections...');

  const aiClient = getAIClient();
  const aiHealthy = await aiClient.healthCheck();

  if (aiHealthy) {
    console.log(`✅ Falcon AI (${process.env.OPENWEBUI_URL}) is reachable`);
    try {
      const models = await aiClient.listModels();
      console.log(
        `   Available models: ${models.slice(0, 5).join(', ')}${models.length > 5 ? '...' : ''}`
      );

      if (!models.includes(process.env.OPENWEBUI_MODEL || '')) {
        console.warn(
          `   ⚠️ Model "${process.env.OPENWEBUI_MODEL}" not found in available models.`
        );
        console.warn(`   Available: ${models.join(', ')}`);
      }
    } catch {
      console.log('   ⚠️ Could not list models (API key may have limited permissions)');
    }

    // Discover MCP tools
    try {
      const toolIds = await aiClient.discoverMcpTools();
      if (toolIds.length > 0) {
        console.log(`✅ MCP Tools discovered: ${toolIds.length} tool(s)`);
        toolIds.forEach((id) => console.log(`   🔧 ${id}`));
      } else {
        console.warn('   ⚠️ No MCP tools found — the LLM may not be able to fetch real data.');
        console.warn('   Make sure MCP Sumo Logic server is registered in Falcon AI.');
      }
    } catch {
      console.log('   ⚠️ Could not discover tools');
    }
  } else {
    console.error(`❌ Cannot reach Falcon AI at ${process.env.OPENWEBUI_URL}`);
    console.error('   The bot will start but AI queries will fail.');
  }
}

async function main(): Promise<void> {
  await verifyConnections();
  await startSlackBot();
}

main().catch((error) => {
  console.error('❌ Failed to start Slack bot:', error);
  process.exit(1);
});
