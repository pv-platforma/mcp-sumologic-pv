import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { 
  SUMO_REGIONS, 
  getAvailableRegions, 
  getProdRegions, 
  getConfiguredRegions 
} from '../config/regions.js';

export function registerListRegionsTool(server: McpServer): void {
  server.tool(
    'list_regions',
    'List all available Sumo Logic regions and their configuration status',
    {},
    async () => {
      const availableRegions = getAvailableRegions();
      const configuredRegions = getConfiguredRegions();
      const prodRegions = getProdRegions();

      const regionDetails = availableRegions.map(region => ({
        region,
        displayName: SUMO_REGIONS[region].displayName,
        clusters: SUMO_REGIONS[region].clusters,
        environments: SUMO_REGIONS[region].environments,
        isConfigured: configuredRegions.includes(region),
        isProd: prodRegions.includes(region),
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            availableRegions: regionDetails,
            configuredRegions,
            prodRegions: prodRegions.filter(r => configuredRegions.includes(r)),
          }, null, 2),
        }],
      };
    }
  );
}