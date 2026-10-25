import {
  FinnlpNewsProviderError,
} from '../../../src/tools/finnlpCompanyNews.ts';
import type { ToolExecutionContext } from '../../../src/tools/contracts.ts';
import {
  SupabaseFinnlpCompanyNewsProvider,
  validateFinnhubApiKey,
} from './finnlpProvider.ts';

const workspaceId = '22000000-0000-4000-8000-000000000001';
const userId = '11000000-0000-4000-8000-000000000001';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    userId,
    workspaceId,
    taskId: '33000000-0000-4000-8000-000000000001',
    executionId: '44000000-0000-4000-8000-000000000001',
    toolId: 'finnlp-company-news',
    toolVersion: '1.0.0',
    requestId: '55000000-0000-4000-8000-000000000001',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function clientWithKey(key: string | null, error: unknown = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: key, error };
    },
  };
  return { client: client as never, calls };
}

Deno.test('provider calls only the fixed HTTPS company-news endpoint and normalizes response data', async () => {
  const observedRequests: Array<{ url: string; method: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    observedRequests.push({ url: String(input), method: String(init?.method) });
    return Response.json([{
      id: 123,
      headline: 'Headline',
      summary: 'Summary',
      source: 'Reuters',
      url: 'https://news.example.test/article',
      datetime: 1790812800,
    }]);
  };
  const { client, calls } = clientWithKey('server-only-api-key');
  const provider = new SupabaseFinnlpCompanyNewsProvider(client, { fetcher: fakeFetch });
  const articles = await provider.fetchCompanyNews(context(), {
    ticker: 'AAPL',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
  });
  const observedUrl = new URL(observedRequests[0].url);
  assertEquals(observedUrl.origin, 'https://finnhub.io', 'Provider must not accept arbitrary hosts');
  assertEquals(observedUrl.pathname, '/api/v1/company-news', 'Provider must use only company-news');
  assertEquals(observedUrl.searchParams.get('symbol'), 'AAPL', 'Ticker must be passed');
  assertEquals(observedUrl.searchParams.get('token'), 'server-only-api-key', 'Secret stays in provider request');
  assertEquals(observedRequests[0].method, 'GET', 'Provider must be read-only');
  assertEquals(articles[0].headline, 'Headline', 'Article headline must be mapped');
  assertEquals(articles[0].publishedAt, new Date(1790812800 * 1000).toISOString(), 'Timestamp must be normalized');
  assertEquals(calls[0], {
    name: 'read_finnlp_api_key',
    args: { p_workspace_id: workspaceId, p_user_id: userId },
  }, 'Secret is selected using the verified actor/workspace pair');
});

Deno.test('provider requires a stored workspace key and fails closed on secret lookup errors', async () => {
  const absent = new SupabaseFinnlpCompanyNewsProvider(clientWithKey(null).client, {
    fetcher: async () => { throw new Error('must not fetch without a key'); },
  });
  let absentError: unknown;
  try {
    await absent.fetchCompanyNews(context(), { ticker: 'AAPL', startDate: '2026-10-01', endDate: '2026-10-03' });
  } catch (error) { absentError = error; }
  assert(absentError instanceof FinnlpNewsProviderError && absentError.kind === 'NOT_CONNECTED', 'Missing key must not reach Finnhub');

  const broken = new SupabaseFinnlpCompanyNewsProvider(clientWithKey(null, new Error('db details')).client, {
    fetcher: async () => { throw new Error('must not fetch after database error'); },
  });
  let brokenError: unknown;
  try {
    await broken.fetchCompanyNews(context(), { ticker: 'AAPL', startDate: '2026-10-01', endDate: '2026-10-03' });
  } catch (error) { brokenError = error; }
  assert(brokenError instanceof FinnlpNewsProviderError && brokenError.kind === 'UNAVAILABLE', 'Database details must be normalized');
});

Deno.test('provider maps unauthorized and rate-limited API responses without leaking payloads', async () => {
  for (const item of [
    { status: 401, expected: 'UNAUTHORIZED' },
    { status: 429, expected: 'RATE_LIMITED' },
  ] as const) {
    const provider = new SupabaseFinnlpCompanyNewsProvider(clientWithKey('a-secret-token-value').client, {
      fetcher: async () => Response.json({ error: 'token=a-secret-token-value' }, { status: item.status }),
    });
    let observed: unknown;
    try {
      await provider.fetchCompanyNews(context(), { ticker: 'AAPL', startDate: '2026-10-01', endDate: '2026-10-03' });
    } catch (error) { observed = error; }
    assert(
      observed instanceof FinnlpNewsProviderError && observed.kind === item.expected,
      `Status ${item.status} must map to ${item.expected}`,
    );
    assert(!String(observed).includes('a-secret-token-value'), 'Credential must not appear in errors');
  }
});

Deno.test('provider timeout cancels the underlying request', async () => {
  const provider = new SupabaseFinnlpCompanyNewsProvider(clientWithKey('a-secret-token-value').client, {
    timeoutMs: 5,
    fetcher: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  let observed: unknown;
  try {
    await provider.fetchCompanyNews(context(), { ticker: 'AAPL', startDate: '2026-10-01', endDate: '2026-10-03' });
  } catch (error) { observed = error; }
  assert(observed instanceof FinnlpNewsProviderError && observed.kind === 'TIMEOUT', 'Deadline must be enforced');
});

Deno.test('connection check uses company-news with a fixed symbol/date and distinguishes API rejection', async () => {
  const requestedUrls: string[] = [];
  const now = () => new Date('2026-10-26T14:00:00.000Z');
  const valid = await validateFinnhubApiKey('valid-finnhub-api-key-123', {
    now,
    fetcher: async (input, init) => {
      requestedUrls.push(String(input));
      assertEquals(init?.method, 'GET', 'Credential validation must be read-only');
      return Response.json([]);
    },
  });
  assertEquals(valid.status, 'valid', 'A successful empty news response is still valid');
  const url = new URL(requestedUrls[0]);
  assertEquals(url.origin, 'https://finnhub.io', 'Credential validator uses only trusted endpoint');
  assertEquals(url.pathname, '/api/v1/company-news', 'Credential validator must not query other endpoints');
  assertEquals(url.searchParams.get('symbol'), 'AAPL', 'Credential validation uses fixed symbol');
  assertEquals(url.searchParams.get('from'), '2026-10-26', 'Credential validation uses today only');

  const rejected = await validateFinnhubApiKey('invalid-finnhub-api-key-123', {
    now,
    fetcher: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  });
  assertEquals(rejected.status, 'unauthorized', 'Unauthorized keys must be rejected');
  const limited = await validateFinnhubApiKey('valid-finnhub-api-key-123', {
    now,
    fetcher: async () => Response.json({ error: 'rate limited' }, { status: 429 }),
  });
  assertEquals(limited.status, 'rate_limited', 'Provider rate limits must not be mistaken for a bad key');
  const huge = await validateFinnhubApiKey('x'.repeat(1_048_577), { now });
  assertEquals(huge.status, 'unauthorized', 'Oversized values must not be sent');
});
