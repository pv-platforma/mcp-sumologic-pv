import type { RequestAPI, RequiredUriUrl, Options } from 'request';
import type {
  RequestPromise,
  RequestPromiseOptions,
} from 'request-promise-native';

export interface IClientOptions {
  endpoint: string;
  sumoApiId: string;
  sumoApiKey: string;
}

export interface IPaginationOptions {
  offset: number;
  limit: number;
}

export interface ISearchJob {
  id: string;
  link: {
    rel: string;
    href: string;
  };
}

export interface ISearchJobStatus {
  state: string;
  messageCount: number;
  histogramBuckets: Array<{
    length: number;
    count: number;
    startTimestamp: number;
  }>;
  pendingErrors: string[];
  pendingWarnings: string[];
  recordCount: number;
}

export interface IMessage {
  map: {
    _raw?: string;
    _messagetime?: string;
    _sourceHost?: string;
    _sourceCategory?: string;
    _count?: string;
    _loglevel?: string;
    [key: string]: string | undefined;
  };
}

export interface IMessages {
  fields: Array<{
    name: string;
    fieldType: string;
    keyField: boolean;
  }>;
  messages: IMessage[];
}

export interface IRecord {
  map: {
    [key: string]: string;
  };
}

export interface IRecords {
  fields: Array<{
    name: string;
    fieldType: string;
    keyField: boolean;
  }>;
  records: IRecord[];
}

export type RequestClient = RequestAPI<
  RequestPromise,
  RequestPromiseOptions,
  RequiredUriUrl
>;

export interface Client {
  request: RequestClient;
  createSearchJob: (query: string, from: string, to: string) => RequestPromise<ISearchJob>;
  getSearchJobStatus: (searchJobId: string) => RequestPromise<ISearchJobStatus>;
  getSearchJobMessages: (
    searchJobId: string,
    params?: Partial<IPaginationOptions>
  ) => RequestPromise<IMessages>;
  getSearchJobRecords: (
    searchJobId: string,
    params?: Partial<IPaginationOptions>
  ) => RequestPromise<IRecords>;
  deleteSearchJob: (searchJobId: string) => RequestPromise<void>;
}