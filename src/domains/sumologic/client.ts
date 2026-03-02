import type { Client } from '../../lib/sumologic/types.js';

interface SearchOptions {
  from?: string;
  to?: string;
}

export interface SearchResult {
  messages: Array<{
    map: {
      _raw?: string;
      _messagetime?: string;
      _receipttime?: string;
      _sourceHost?: string;
      _sourceCategory?: string;
      _count?: string;
      _loglevel?: string;
      [key: string]: string | undefined;
    };
  }>;
  records: Array<{
    map: {
      [key: string]: string;
    };
  }>;
  messageCount: number;
  recordCount: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert time parameter to ISO 8601 format WITHOUT timezone suffix.
 * 
 * Sumo Logic Search Job API rejects timestamps ending with "Z" or ".000Z".
 * It accepts: "2026-03-01T08:00:00" (no Z, no milliseconds suffix)
 * 
 * Handles:
 *   - "now"           → current UTC time without Z
 *   - "-15m", "-1h", "-7d" → resolved relative to now, without Z
 *   - ISO strings     → stripped of Z/.000Z suffix
 */
function toSumoTimestamp(timeStr: string): string {
  if (!timeStr || timeStr.toLowerCase() === 'now') {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '');
  }

  // Relative time: -15m, -1h, -24h, -7d
  const relativeMatch = timeStr.match(/^-(\d+)([mhd])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    const now = Date.now();

    let offsetMs: number;
    switch (unit) {
      case 'm': offsetMs = value * 60 * 1000; break;
      case 'h': offsetMs = value * 60 * 60 * 1000; break;
      case 'd': offsetMs = value * 24 * 60 * 60 * 1000; break;
      default:  offsetMs = value * 60 * 60 * 1000;
    }

    return new Date(now - offsetMs).toISOString().replace(/\.\d{3}Z$/, '');
  }

  // Already an ISO string or other format — strip Z suffix if present
  return timeStr.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

export async function search(
  client: Client,
  query: string,
  options?: SearchOptions
): Promise<SearchResult> {
  const from = toSumoTimestamp(options?.from || '-15m');
  const to = toSumoTimestamp(options?.to || 'now');

  console.error(`[SumoLogic] Search: from=${from} to=${to} query=${query.substring(0, 120)}...`);

  const job = await client.createSearchJob(query, from, to);
  const searchJobId = job.id;

  let status = await client.getSearchJobStatus(searchJobId);
  let attempts = 0;
  const maxAttempts = 120;

  while (
    (status.state === 'GATHERING RESULTS' || status.state === 'NOT STARTED') &&
    attempts < maxAttempts
  ) {
    await delay(1000);
    status = await client.getSearchJobStatus(searchJobId);
    attempts++;
  }

  if (status.state === 'DONE GATHERING RESULTS') {
    const result: SearchResult = {
      messages: [],
      records: [],
      messageCount: status.messageCount,
      recordCount: status.recordCount,
    };

    if (status.messageCount > 0) {
      try {
        const messagesResponse = await client.getSearchJobMessages(searchJobId, {
          offset: 0,
          limit: Math.min(status.messageCount, 100),
        });
        result.messages = messagesResponse.messages || [];
      } catch (e) {
        console.error('Messages not available:', (e as Error).message);
      }
    }

    if (status.recordCount > 0) {
      try {
        const recordsResponse = await client.getSearchJobRecords(searchJobId, {
          offset: 0,
          limit: Math.min(status.recordCount, 100),
        });
        result.records = recordsResponse.records || [];
      } catch (e) {
        console.error('Records not available:', (e as Error).message);
      }
    }

    try { await client.deleteSearchJob(searchJobId); } catch { /* ignore */ }
    return result;
  }

  try { await client.deleteSearchJob(searchJobId); } catch { /* ignore */ }
  throw new Error(
    `Search job ended with state: ${status.state} after ${attempts}s. Errors: ${(status.pendingErrors || []).join('; ')}`
  );
}