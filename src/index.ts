import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { registerAllTools } from "./tools/index.js";

const server = new McpServer({
  name: "mcp-sumologic",
  version: "1.0.0",
  description:
    "MCP server for searching Sumo Logic logs, detecting issues, generating reports, and querying Kubernetes metrics",
});

// Register all tools
registerAllTools(server);

// Determine transport mode based on environment
const TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (TRANSPORT === "sse") {
  // --- SSE Transport (for remote hosting behind ALB) ---
  const app = express();
  app.use(express.json());

  const transports: Record<string, SSEServerTransport> = {};

  // SSE endpoint — clients connect here to establish a session
  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;

    res.on("close", () => {
      delete transports[transport.sessionId];
    });

    await server.connect(transport);
  });

  // Messages endpoint — clients send messages here
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).json({ error: "No transport found for sessionId" });
    }
  });

  // Health check endpoint for ALB
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      server: "mcp-sumologic",
      transport: "sse",
      activeSessions: Object.keys(transports).length,
      uptime: process.uptime(),
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP Sumo Logic SSE server running on http://0.0.0.0:${PORT}`);
    console.log(`  SSE endpoint:     http://0.0.0.0:${PORT}/sse`);
    console.log(`  Messages endpoint: http://0.0.0.0:${PORT}/messages`);
    console.log(`  Health check:      http://0.0.0.0:${PORT}/health`);
  });
} else {
  // --- Stdio Transport (for local usage with Claude Code / VS Code) ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Sumo Logic server running on stdio");
}