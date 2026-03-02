import requestPromise from 'request-promise-native';

export interface MetricsClientOptions {
  endpoint: string;
  sumoApiId: string;
  sumoApiKey: string;
}

export interface MetricsQuery {
  query: string;
  startTime: string;
  endTime: string;
  quantization?: number; // in milliseconds
  rollup?: 'avg' | 'sum' | 'min' | 'max' | 'count';
}

export interface MetricsResult {
  response: Array<{
    rowId: string;
    results: Array<{
      metric: {
        dimensions: Array<{ key: string; value: string }>;
        [key: string]: unknown;
      };
      datapoints: {
        timestamp: number[];
        value: number[];
      };
    }>;
  }>;
  queryInfo?: unknown;
}

export function createMetricsClient(options: MetricsClientOptions) {
  const { endpoint, sumoApiId, sumoApiKey } = options;

  // Metrics API uses a different base URL pattern
  // e.g., https://api.us2.sumologic.com/api/v1/metrics/results
  const baseUrl = endpoint.replace('/v1', '/v1/metrics');

  const request = requestPromise.defaults({
    baseUrl: endpoint.replace('/api/v1', ''),
    auth: {
      user: sumoApiId,
      pass: sumoApiKey,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    json: true,
  });

  return {
    async queryMetrics(params: MetricsQuery): Promise<MetricsResult> {
      const body = {
        query: [
          {
            query: params.query,
            rowId: 'A',
          },
        ],
        startTime: new Date(params.startTime).getTime(),
        endTime: new Date(params.endTime).getTime(),
        quantization: params.quantization || 60000, // default 1 minute
        rollup: params.rollup || 'avg',
      };

      return request.post('/api/v1/metrics/results', { body });
    },
  };
}

export type MetricsClient = ReturnType<typeof createMetricsClient>;