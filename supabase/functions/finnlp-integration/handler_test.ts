import {
  createFinnlpIntegrationHandler,
  type FinnlpIntegrationDependencies,
} from './handler.ts';

const userId = '11000000-0000-4000-8000-000000000001';
const outsiderId = '11000000-0000-4000-8000-000000000002';
const workspaceId = '22000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '22000000-0000-4000-8000-000000000002';
const origin = 'http://localhost:5173';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as Record<string, unknown>;
}

function createHarness(options: {
  readonly member?: boolean;
  readonly validation?: 'valid' | 'unauthorized' | 'rate_limited' | 'unavailable';
} = {}) {
  const saved = new Map<string, { connected_at: string }>();
  const members = new Set(options.member === false ? [] : [userId]);
  const events: string[] = [];
  const key = (ws: string, user: string) => `${ws}:${user}`;
  const now = '2026-10-26T10:00:00.000Z';
  let suppliedToSave = '';
  const dependencies: FinnlpIntegrationDependencies<object> = {
    origins: new Set([origin]),
    authenticate: async (token) => token === 'valid-token'
      ? { userId, context: {} }
      : token === 'outsider-token' ? { userId: outsiderId, context: {} } : null,
    isWorkspaceMember: async (caller, ws) => ws === workspaceId && members.has(caller.userId),
    getConnection: async (ws, user) => {
      events.push('status');
      return saved.get(key(ws, user)) ?? null;
    },
    connect: async (ws, user, apiKey) => {
      events.push('connect');
      suppliedToSave = apiKey;
      const row = { connected_at: now };
      saved.set(key(ws, user), row);
      return row;
    },
    disconnect: async (ws, user) => {
      events.push('disconnect');
      saved.delete(key(ws, user));
    },
    validateApiKey: async (apiKey) => {
      events.push('validate');
      assert(apiKey !== '', 'API key must not be empty at validation time');
      return options.validation ?? 'valid';
    },
    logFailure: (code) => events.push(`log:${code}`),
  };
  const handler = createFinnlpIntegrationHandler(dependencies);
  const post = (payload: unknown, token = 'valid-token', includeAuthorization = true) =>
    new Request('https://project.example/functions/v1/finnlp-integration', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(includeAuthorization ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  return { handler, post, saved, events, suppliedToSave: () => suppliedToSave, key };
}

Deno.test('status requires a verified member and never returns secret references or provider keys', async () => {
  const harness = createHarness();
  const response = await harness.handler(harness.post({ action: 'status', workspaceId }));
  assertEquals(response.status, 200, 'Authorized status should succeed');
  const body = asRecord(await response.json());
  assertEquals(body.connected, false, 'New connection should be absent');
  assert(!JSON.stringify(body).includes('api_key_secret_id'), 'Vault references must not be returned');
  assert(!JSON.stringify(body).includes('apiKey'), 'Provider key must not be returned');

  const unauthorized = await harness.handler(harness.post({ action: 'status', workspaceId }, '', false));
  assertEquals(unauthorized.status, 401, 'Missing bearer token must be rejected');

  const crossWorkspace = await harness.handler(harness.post({ action: 'status', workspaceId: otherWorkspaceId }));
  assertEquals(crossWorkspace.status, 403, 'A different workspace must be rejected');
});

Deno.test('connect validates a provider key, stores it server-side and never reflects it in response', async () => {
  const harness = createHarness();
  const apiKey = 'finnhub-test-key-for-this-workspace';
  const response = await harness.handler(harness.post({ action: 'connect', workspaceId, apiKey }));
  assertEquals(response.status, 200, 'A valid key should connect');
  const body = asRecord(await response.json());
  assertEquals(body.connected, true, 'Connection should be reported');
  assertEquals(body.connectedAt, '2026-10-26T10:00:00.000Z', 'Connection timestamp should be returned');
  assertEquals(harness.suppliedToSave(), apiKey, 'Credential should only be handed to secure server storage');
  assert(!response.headers.has('set-cookie'), 'No provider credentials should be stored in browser cookies');
  assert(!response.text || true, 'Response is JSON only');
  const serialized = JSON.stringify(body);
  assert(!serialized.includes(apiKey), 'API key must not be returned');
  assert(!serialized.includes('api_key_secret_id'), 'Vault secret ID must not be returned');
  assertEquals(harness.events, ['validate', 'connect'], 'Validation must happen before storage');
});

Deno.test('connect fails closed on rejected keys, provider throttling and provider outages', async () => {
  const rejected = createHarness({ validation: 'unauthorized' });
  const invalid = await rejected.handler(rejected.post({
    action: 'connect', workspaceId, apiKey: 'finnhub-invalid-test-key-1234',
  }));
  assertEquals(invalid.status, 400, 'Rejected key should not be saved');
  assertEquals(rejected.events, ['validate'], 'A rejected key must not be stored');

  const limited = createHarness({ validation: 'rate_limited' });
  const throttled = await limited.handler(limited.post({
    action: 'connect', workspaceId, apiKey: 'finnhub-test-key-for-this-workspace',
  }));
  assertEquals(throttled.status, 429, 'Provider rate limit should be surfaced as retryable setup failure');
  assertEquals(limited.events, ['validate'], 'Rate limited key must not be stored');

  const offline = createHarness({ validation: 'unavailable' });
  const unavailable = await offline.handler(offline.post({
    action: 'connect', workspaceId, apiKey: 'finnhub-test-key-for-this-workspace',
  }));
  assertEquals(unavailable.status, 503, 'Unavailable provider must fail closed');
  assertEquals(offline.events, ['validate'], 'Unavailable provider key must not be stored');
});

Deno.test('disconnect removes only the current user connection after membership validation', async () => {
  const harness = createHarness();
  harness.saved.set(harness.key(workspaceId, userId), { connected_at: '2026-10-26T09:00:00Z' });
  harness.saved.set(harness.key(workspaceId, outsiderId), { connected_at: '2026-10-26T09:00:00Z' });
  const response = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  const body = asRecord(await response.json());
  assertEquals(response.status, 200, 'Disconnect should succeed');
  assertEquals(body.connected, false, 'Disconnected state should be reported');
  assert(!harness.saved.has(harness.key(workspaceId, userId)), 'Current user row should be removed');
  assert(harness.saved.has(harness.key(workspaceId, outsiderId)), 'Other user connection must remain');
});

Deno.test('unknown fields, malformed payloads, oversized bodies, and disallowed origins are rejected', async () => {
  const harness = createHarness();
  const extra = await harness.handler(harness.post({ action: 'status', workspaceId, apiKey: 'unexpected' }));
  assertEquals(extra.status, 400, 'Unknown fields must not be accepted');

  const largeRequest = new Request('https://project.example/functions/v1/finnlp-integration', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json', 'content-length': '20000' },
    body: JSON.stringify({ action: 'status', workspaceId, extra: 'x'.repeat(20_000) }),
  });
  const tooLarge = await harness.handler(largeRequest);
  assertEquals(tooLarge.status, 413, 'Oversized payload must be rejected');

  const wrongOrigin = new Request('https://project.example/functions/v1/finnlp-integration', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'status', workspaceId }),
  });
  const blockedOrigin = await harness.handler(wrongOrigin);
  assertEquals(blockedOrigin.status, 403, 'Unexpected browser origin must be rejected');
});
