import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FinnlpNewsProviderError,
  type FinnlpCompanyNewsInput,
  type FinnlpCompanyNewsProvider,
  type FinnlpNewsArticle,
} from '../../../src/tools/finnlpCompanyNews.ts';

const FINNHUB_COMPANY_NEWS_ENDPOINT = 'https://finnhub.io/api/v1/company-news';
const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;
const CONNECTIVITY_CHECK_MAX_BYTES = 32_768;
const PROVIDER_TIMEOUT_MS = 8_000;

type JsonFetchResult = {
  readonly status: number;
  readonly payload: unknown;
};

export interface FinnhubProviderOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export class SupabaseFinnlpCompanyNewsProvider implements FinnlpCompanyNewsProvider {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly serviceClient: SupabaseClient,
    options: FinnhubProviderOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  async fetchCompanyNews(
    context: Parameters<FinnlpCompanyNewsProvider['fetchCompanyNews']>[0],
    input: FinnlpCompanyNewsInput,
  ): Promise<readonly FinnlpNewsArticle[]> {
    const { data: apiKey, error } = await this.serviceClient.rpc('read_finnlp_api_key', {
      p_workspace_id: context.workspaceId,
      p_user_id: context.userId,
    });
    if (error) {
      throw new FinnlpNewsProviderError('UNAVAILABLE');
    }
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new FinnlpNewsProviderError('NOT_CONNECTED');
    }

    const url = companyNewsUrl(apiKey, input);
    const result = await fetchJson(url, this.fetcher, this.timeoutMs, MAX_PROVIDER_RESPONSE_BYTES);
    throwForProviderStatus(result.status);
    if (!Array.isArray(result.payload)) {
      throw new FinnlpNewsProviderError('INVALID_RESPONSE');
    }

    return result.payload
      .filter(isRecord)
      .slice(0, 100)
      .map((row) => ({
        id: typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id).slice(0, 100) : null,
        headline: typeof row.headline === 'string' ? row.headline : '',
        summary: typeof row.summary === 'string' ? row.summary : '',
        source: typeof row.source === 'string' ? row.source : 'Unknown source',
        url: typeof row.url === 'string' ? row.url : null,
        publishedAt: typeof row.datetime === 'number' && Number.isFinite(row.datetime) && row.datetime > 0
          ? new Date(row.datetime * 1000).toISOString()
          : null,
      }));
  }
}

export type FinnhubKeyValidation =
  | { readonly status: 'valid' }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'rate_limited' }
  | { readonly status: 'unavailable' };

export async function validateFinnhubApiKey(
  apiKey: string,
  options: FinnhubProviderOptions = {},
): Promise<FinnhubKeyValidation> {
  if (apiKey.trim().length < 16 || apiKey.trim().length > 512 || /[\r\n\u0000]/.test(apiKey)) {
    return { status: 'unauthorized' };
  }
  const now = options.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const url = companyNewsUrl(apiKey, { ticker: 'AAPL', startDate: today, endDate: today });
  try {
    const result = await fetchJson(
      url,
      options.fetcher ?? fetch,
      options.timeoutMs ?? 5_000,
      CONNECTIVITY_CHECK_MAX_BYTES,
    );
    if (result.status === 401 || result.status === 403) return { status: 'unauthorized' };
    if (result.status === 429) return { status: 'rate_limited' };
    if (result.status < 200 || result.status >= 300) return { status: 'unavailable' };
    return Array.isArray(result.payload)
      ? { status: 'valid' }
      : { status: 'unauthorized' };
  } catch {
    return { status: 'unavailable' };
  }
}

function companyNewsUrl(apiKey: string, input: FinnlpCompanyNewsInput): string {
  const url = new URL(FINNHUB_COMPANY_NEWS_ENDPOINT);
  url.searchParams.set('symbol', input.ticker);
  url.searchParams.set('from', input.startDate);
  url.searchParams.set('to', input.endDate);
  url.searchParams.set('token', apiKey);
  return url.toString();
}

async function fetchJson(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<JsonFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBoundedBody(response, maxBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new FinnlpNewsProviderError('INVALID_RESPONSE');
    }
    return { status: response.status, payload };
  } catch (error) {
    if (error instanceof FinnlpNewsProviderError) throw error;
    if (controller.signal.aborted) throw new FinnlpNewsProviderError('TIMEOUT');
    throw new FinnlpNewsProviderError('UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new FinnlpNewsProviderError('INVALID_RESPONSE');
  }
  if (!response.body) throw new FinnlpNewsProviderError('INVALID_RESPONSE');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FinnlpNewsProviderError('INVALID_RESPONSE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FinnlpNewsProviderError('INVALID_RESPONSE');
  }
}

function throwForProviderStatus(status: number): void {
  if (status === 401 || status === 403) throw new FinnlpNewsProviderError('UNAUTHORIZED');
  if (status === 429) throw new FinnlpNewsProviderError('RATE_LIMITED');
  if (status < 200 || status >= 300) throw new FinnlpNewsProviderError('UNAVAILABLE');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
