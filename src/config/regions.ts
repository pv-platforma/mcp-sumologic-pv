export interface SumoRegionConfig {
  endpoint: string;
  apiId: string;
  apiKey: string;
  clusters: string[];
  environments: string[];
  displayName: string;
  partition: string;
}

export interface RegionMapping {
  [region: string]: SumoRegionConfig;
}

// Function to get regions config (reads env vars at call time, not module load time)
export function getSumoRegions(): RegionMapping {
  return {
    // 'usw2-dev': {
    //   endpoint: process.env.SUMO_ENDPOINT_USW2_DEV || 'https://api.us2.sumologic.com/api/v1',
    //   apiId: process.env.SUMO_API_ID_USW2_DEV || '',
    //   apiKey: process.env.SUMO_API_KEY_USW2_DEV || '',
    //   clusters: ['fd-platform-usw2-dev-cluster'],
    //   environments: ['dev'],
    //   displayName: 'US West 2 - Development',
    //   partition: 'fd_platform_usw2_dev_debug_null',
    // },
    // 'usw2-qa': {
    //   endpoint: process.env.SUMO_ENDPOINT_USW2_QA || 'https://api.us2.sumologic.com/api/v1',
    //   apiId: process.env.SUMO_API_ID_USW2_QA || '',
    //   apiKey: process.env.SUMO_API_KEY_USW2_QA || '',
    //   clusters: ['fd-platform-usw2-qa'],
    //   environments: ['qa'],
    //   displayName: 'US West 2 - QA',
    //   partition: 'fd_platform_usw2_qa_debug_null',
    // },
    // 'usw2-staging': {
    //   endpoint: process.env.SUMO_ENDPOINT_USW2_STAGING || 'https://api.us2.sumologic.com/api/v1',
    //   apiId: process.env.SUMO_API_ID_USW2_STAGING || '',
    //   apiKey: process.env.SUMO_API_KEY_USW2_STAGING || '',
    //   clusters: ['fd-platform-usw2-staging'],
    //   environments: ['staging'],
    //   displayName: 'US West 2 - Staging',
    //   partition: 'fd_platform_usw2_staging_debug_null',
    // },
    'usw2-prod': {
      endpoint: process.env.SUMO_ENDPOINT_USW2_PROD || 'https://api.us2.sumologic.com/api/v1',
      apiId: process.env.SUMO_API_ID_USW2_PROD || '',
      apiKey: process.env.SUMO_API_KEY_USW2_PROD || '',
      clusters: ['fd-platform-usw2-prod', 'fd-platform-usw2-argocd'],
      environments: ['prod'],
      displayName: 'US West 2 - Production',
      partition: 'fd_platform_usw2_prod_debug_null',
    },
    'euc1-prod': {
      endpoint: process.env.SUMO_ENDPOINT_EUC1_PROD || 'https://api.eu.sumologic.com/api/v1',
      apiId: process.env.SUMO_API_ID_EUC1_PROD || '',
      apiKey: process.env.SUMO_API_KEY_EUC1_PROD || '',
      clusters: ['fd-platform-euc1-prod'],
      environments: ['prod'],
      displayName: 'EU Central 1 - Production',
      partition: 'fd_platform_euc1_prod_debug_null',
    },
    'aps2-prod': {
      endpoint: process.env.SUMO_ENDPOINT_APS2_PROD || 'https://api.au.sumologic.com/api/v1',
      apiId: process.env.SUMO_API_ID_APS2_PROD || '',
      apiKey: process.env.SUMO_API_KEY_APS2_PROD || '',
      clusters: ['fd-platform-aps2-prod'],
      environments: ['prod'],
      displayName: 'AP Southeast 2 - Production',
      partition: 'fd_platform_aps2_prod_debug_null',
    },
  };
}

// For backward compatibility - lazy loaded
export const SUMO_REGIONS: RegionMapping = new Proxy({} as RegionMapping, {
  get(_, prop: string) {
    return getSumoRegions()[prop];
  },
  ownKeys() {
    return Object.keys(getSumoRegions());
  },
  getOwnPropertyDescriptor(_, prop: string) {
    const regions = getSumoRegions();
    if (prop in regions) {
      return { enumerable: true, configurable: true, value: regions[prop] };
    }
    return undefined;
  },
});

export function getRegionConfig(region: string): SumoRegionConfig | undefined {
  return getSumoRegions()[region];
}

export function findRegionByCluster(clusterName: string): string | undefined {
  const regions = getSumoRegions();
  for (const [region, config] of Object.entries(regions)) {
    if (config.clusters.some(c => clusterName.includes(c) || c.includes(clusterName))) {
      return region;
    }
  }
  return undefined;
}

export function getAvailableRegions(): string[] {
  return Object.keys(getSumoRegions());
}

export function getProdRegions(): string[] {
  const regions = getSumoRegions();
  return Object.entries(regions)
    .filter(([_, config]) => config.environments.includes('prod'))
    .map(([region]) => region);
}

export function getConfiguredRegions(): string[] {
  const regions = getSumoRegions();
  return Object.entries(regions)
    .filter(([_, config]) => config.apiId && config.apiKey)
    .map(([region]) => region);
}

/**
 * Get the partition/index name for a region
 */
export function getPartition(region: string): string {
  const regionConfig = getSumoRegions()[region];
  if (!regionConfig) {
    throw new Error(`Unknown region: ${region}`);
  }
  return regionConfig.partition;
}

/**
 * Get the primary cluster name for a region
 */
export function getClusterName(region: string): string {
  const regionConfig = getSumoRegions()[region];
  return regionConfig?.clusters[0] || `fd-platform-${region}`;
}