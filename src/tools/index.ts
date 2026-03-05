import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListRegionsTool } from './listRegions.js';
import { registerSearchSumologicTool } from './searchSumologic.js';
import { registerSearchByClusterTool } from './searchByCluster.js';
import { registerSearchAllProdRegionsTool } from './searchAllProdRegions.js';
import { registerListLogsTool } from './listLogs.js';
import { registerSummarizeLogsTool } from './summarizeLogs.js';
import { registerGetMetricsTool } from './getMetrics.js';
import { registerGetPerformanceMetricsTool } from './getPerformanceMetrics.js';
import { registerDetectIssuesTool } from './detectIssues.js';

export function registerAllTools(server: McpServer): void {
  registerListRegionsTool(server);
  registerSearchSumologicTool(server);
  registerSearchByClusterTool(server);
  registerSearchAllProdRegionsTool(server);
  registerListLogsTool(server);
  registerSummarizeLogsTool(server);
  registerGetMetricsTool(server);
  registerGetPerformanceMetricsTool(server);
  registerDetectIssuesTool(server);
}