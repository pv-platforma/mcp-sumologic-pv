import { client } from './client.js';
import type { Client } from './types.js';
import { getRegionConfig, getConfiguredRegions } from '../../config/regions.js';

const clientCache: Map<string, Client> = new Map();

export function getClient(region: string): Client {
  if (clientCache.has(region)) {
    return clientCache.get(region)!;
  }

  const config = getRegionConfig(region);
  if (!config) {
    throw new Error(
      `Unknown region: ${region}. Available regions: ${getConfiguredRegions().join(', ')}`
    );
  }

  if (!config.apiId || !config.apiKey) {
    throw new Error(
      `Region ${region} is not configured. Please set SUMO_API_ID_${region.toUpperCase().replace('-', '_')} and SUMO_API_KEY_${region.toUpperCase().replace('-', '_')} environment variables.`
    );
  }

  const sumoClient = client({
    endpoint: config.endpoint,
    sumoApiId: config.apiId,
    sumoApiKey: config.apiKey,
  });

  clientCache.set(region, sumoClient);
  return sumoClient;
}

export function clearClientCache(): void {
  clientCache.clear();
}

export function getClientsForRegions(regions: string[]): Map<string, Client> {
  const clients = new Map<string, Client>();

  for (const region of regions) {
    try {
      clients.set(region, getClient(region));
    } catch (e) {
      console.error(`Failed to create client for region ${region}:`, e);
    }
  }

  return clients;
}