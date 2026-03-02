import queryString from 'query-string';
import requestPromise from 'request-promise-native';
import type { IClientOptions, Client, IPaginationOptions } from './types.js';

// Re-export types from types.js
export type { Client, IClientOptions, IPaginationOptions, IMessages, IMessage, ISearchJob, ISearchJobStatus } from './types.js';

const defaultPaginationOptions: IPaginationOptions = {
  offset: 0,
  limit: 100,
};

export function client(options: IClientOptions): Client {
  const { endpoint, sumoApiId, sumoApiKey } = options;

  const request = requestPromise.defaults({
    baseUrl: endpoint,
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
    request,
    createSearchJob: (query: string, from: string, to: string) =>
      request.post('/search/jobs', {
        body: { query, from, to },
      }),
    getSearchJobStatus: (searchJobId: string) =>
      request.get(`/search/jobs/${searchJobId}`),
    getSearchJobMessages: (searchJobId: string, params?: Partial<IPaginationOptions>) => {
      const paginationOptions: IPaginationOptions = {
        ...defaultPaginationOptions,
        ...params,
      };
      return request.get(
        `/search/jobs/${searchJobId}/messages?${queryString.stringify(paginationOptions)}`
      );
    },
    getSearchJobRecords: (searchJobId: string, params?: Partial<IPaginationOptions>) => {
      const paginationOptions: IPaginationOptions = {
        ...defaultPaginationOptions,
        ...params,
      };
      return request.get(
        `/search/jobs/${searchJobId}/records?${queryString.stringify(paginationOptions)}`
      );
    },
    deleteSearchJob: (searchJobId: string) =>
      request.delete(`/search/jobs/${searchJobId}`),
  };
}