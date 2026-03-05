import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListRegionsTool } from './listRegions.js';
import { registerSearchSumologicTool } from './searchSumologic.js';
import { registerSearchByClusterTool } from './searchByCluster.js';
import { registerSearchAllProdRegionsTool } from './searchAllProdRegions.js';
import { registerSummarizeLogsTool } from './summarizeLogs.js';
import { registerGetPerformanceMetricsTool } from './getPerformanceMetrics.js';
import { registerGetK8sMetricsTool } from './getK8sMetrics.js';
import { registerDetectIssuesTool } from './detectIssues.js';
import { registerGenerateReportTool } from './generateReport.js';
import { registerGetEndpointMetricsTool } from './getEndpointMetrics.js';

export function registerAllTools(server: McpServer): void {
  registerListRegionsTool(server);
  registerSearchSumologicTool(server);
  registerSearchByClusterTool(server);
  registerSearchAllProdRegionsTool(server);
  registerSummarizeLogsTool(server);
  registerGetPerformanceMetricsTool(server);
  registerGetK8sMetricsTool(server);
  registerDetectIssuesTool(server);
  registerGenerateReportTool(server);
  registerGetEndpointMetricsTool(server);
}