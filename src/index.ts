import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { registerAllTools } from "./tools/index.js";
import { randomUUID } from "node:crypto";

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-sumologic",
    version: "2.0.0",
    description:
      "MCP server for searching Sumo Logic logs, detecting issues, generating reports, and querying Kubernetes metrics",
  });

  registerAllTools(server);
  return server;
}

// Determine transport mode based on environment
const TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (TRANSPORT === "sse") {
  const app = express();

  // IMPORTANT: Do NOT apply express.json() globally.
  // StreamableHTTPServerTransport needs to read the raw request stream itself.
  // Only apply JSON parsing to the legacy SSE /messages endpoint.

  // Store transports for both SSE and Streamable HTTP
  const sseTransports: Record<string, SSEServerTransport> = {};
  const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

  // Health check
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      server: "mcp-sumologic",
      transport: "sse+streamable",
      activeSseSessions: Object.keys(sseTransports).length,
      activeStreamableSessions: Object.keys(streamableTransports).length,
      uptime: process.uptime(),
    });
  });

  // ============================================
  // Legacy SSE Transport (2024-11-05 spec)
  // ============================================
  app.get("/sse", async (req, res) => {
    console.log(`[SSE] New connection from ${req.ip}`);
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);
    sseTransports[transport.sessionId] = transport;
    console.log(`[SSE] Session created: ${transport.sessionId}`);

    res.on("close", () => {
      console.log(`[SSE] Session closed: ${transport.sessionId}`);
      delete sseTransports[transport.sessionId];
    });

    await server.connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string;
    console.log(`[SSE POST] Message for session: ${sessionId}`);
    const transport = sseTransports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      console.error(`[SSE POST] No transport for session: ${sessionId}`);
      res.status(400).json({ error: "No transport found for sessionId" });
    }
  });

  // ============================================
  // Streamable HTTP Transport (2025-03-26 spec)
  // ============================================
  app.post("/mcp", async (req, res) => {
    console.log(`[Streamable] POST /mcp from ${req.ip}`);
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session
    if (sessionId && streamableTransports[sessionId]) {
      const transport = streamableTransports[sessionId];
      await transport.handleRequest(req, res);
      return;
    }

    // New session — create server + transport
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        console.log(`[Streamable] Session created: ${newSessionId}`);
        streamableTransports[newSessionId] = transport;
      },
    });

    transport.onclose = () => {
      const sid = Object.keys(streamableTransports).find(
        (key) => streamableTransports[key] === transport
      );
      if (sid) {
        console.log(`[Streamable] Session closed: ${sid}`);
        delete streamableTransports[sid];
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  // Streamable HTTP GET for server-to-client notifications
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    console.log(`[Streamable] GET /mcp session: ${sessionId}`);
    const transport = streamableTransports[sessionId];
    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: "No session found" });
    }
  });

  // Streamable HTTP DELETE for session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    console.log(`[Streamable] DELETE /mcp session: ${sessionId}`);
    const transport = streamableTransports[sessionId];
    if (transport) {
      await transport.handleRequest(req, res);
      delete streamableTransports[sessionId];
    } else {
      res.status(400).json({ error: "No session found" });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP Sumo Logic server running on http://0.0.0.0:${PORT}`);
    console.log(`  SSE endpoint (legacy):     http://0.0.0.0:${PORT}/sse`);
    console.log(`  Streamable HTTP endpoint:  http://0.0.0.0:${PORT}/mcp`);
    console.log(`  Health check:              http://0.0.0.0:${PORT}/health`);
  });

  // ============================================
  // Start Slack Bot alongside MCP server (if configured)
  // The Slack bot uses Socket Mode (outbound WebSocket) — no extra port needed.
  // It coexists with the MCP HTTP server in the same process.
  // ============================================
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    import('./slack/index.js').then(async ({ startSlackBot }) => {
      try {
        // Discover MCP tools before starting the bot
        const { getAIClient } = await import('./slack/aiClient.js');
        const aiClient = getAIClient();
        const aiHealthy = await aiClient.healthCheck();
        if (aiHealthy) {
          console.log(`✅ Falcon AI (${process.env.OPENWEBUI_URL}) is reachable`);
          try {
            const toolIds = await aiClient.discoverMcpTools();
            console.log(`✅ MCP Tools discovered: ${toolIds.length} tool(s)`);
            toolIds.forEach((id) => console.log(`   🔧 ${id}`));
          } catch {
            console.log('   ⚠️ Could not discover MCP tools');
          }
        }

        await startSlackBot();
      } catch (error) {
        console.error('❌ Slack bot failed to start:', error);
        // Don't crash the MCP server if Slack bot fails
      }
    });
  } else {
    console.log('ℹ️  Slack bot not started (SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set)');
  }
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("MCP Sumo Logic server running on stdio");
  });
}