import { createMetricsClient, type MetricsClient } from './metricsClient.js';
import { getRegionConfig, getConfiguredRegions } from '../../config/regions.js';

const metricsClientCache: Map<string, MetricsClient> = new Map();

export function getMetricsClient(region: string): MetricsClient {
  if (metricsClientCache.has(region)) {
    return metricsClientCache.get(region)!;
  }

  const config = getRegionConfig(region);
  if (!config) {
    throw new Error(
      `Unknown region: ${region}. Available regions: ${getConfiguredRegions().join(', ')}`
    );
  }

  if (!config.apiId || !config.apiKey) {
    throw new Error(
      `Region ${region} is not configured. Please set API credentials.`
    );
  }

  const metricsClient = createMetricsClient({
    endpoint: config.endpoint,
    sumoApiId: config.apiId,
    sumoApiKey: config.apiKey,
  });

  metricsClientCache.set(region, metricsClient);
  return metricsClient;
}