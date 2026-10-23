import {
  createGoogleWorkspaceHandler,
  type GoogleOAuthState,
  type GoogleWorkspaceConnection,
  type GoogleWorkspaceEnvironment,
} from './handler.ts';
import { GOOGLE_REQUIRED_SCOPES } from './provider.ts';

const userId = 'c1000000-0000-4000-8000-000000000001';
const outsiderId = 'c1000000-0000-4000-8000-000000000002';
const workspaceId = 'c2000000-0000-4000-8000-000000000001';
const fileId = 'c3000000-0000-4000-8000-000000000001';
const appOrigin = 'http://localhost:5173';

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(actual: boolean, message: string): void {
  if (!actual) throw new Error(message);
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as Record<string, unknown>;
}

function createHarness(options: {
  readonly member?: boolean;
  readonly fetcher?: typeof fetch;
  readonly environment?: GoogleWorkspaceEnvironment;
} = {}) {
  const secrets = new Map<string, string>();
  const states = new Map<string, GoogleOAuthState>();
  const connections = new Map<string, GoogleWorkspaceConnection>();
  const allowedMembers = new Set(options.member === false ? [] : [userId]);
  let secretCounter = 1;
  let now = Date.parse('2026-10-23T10:00:00.000Z');

  const dependencies = {
    origins: new Set([appOrigin]),
    environment: options.environment ?? {
      FLOWWORK_GOOGLE_CLIENT_ID: 'google-client-id',
      FLOWWORK_GOOGLE_CLIENT_SECRET: 'server-only-client-secret',
      FLOWWORK_GOOGLE_REDIRECT_URI: 'https://project.example/functions/v1/google-workspace',
      FLOWWORK_GOOGLE_APP_REDIRECT_URL: appOrigin + '/',
    },
    authenticate: async (token: string) => token === 'valid-token' ? { userId, context: {} } : null,
    isWorkspaceMember: async (caller: { userId: string }, id: string) => id === workspaceId && allowedMembers.has(caller.userId),
    isCurrentMember: async (id: string, member: string) => id === workspaceId && allowedMembers.has(member),
    storeSecret: async (secret: string) => {
      const id = `c4000000-0000-4000-8000-${String(secretCounter++).padStart(12, '0')}`;
      secrets.set(id, secret);
      return id;
    },
    readSecret: async (id: string) => secrets.get(id) ?? null,
    deleteSecret: async (id: string) => { secrets.delete(id); },
    createOAuthState: async (state: Omit<GoogleOAuthState, 'consumed_at'>) => {
      states.set(state.state_hash, { ...state, consumed_at: null });
    },
    consumeOAuthState: async (hash: string) => {
      const value = states.get(hash);
      if (!value || value.consumed_at) return null;
      const consumed = { ...value, consumed_at: new Date(now).toISOString() };
      states.set(hash, consumed);
      return consumed;
    },
    getConnection: async (id: string, member: string) => connections.get(`${id}:${member}`) ?? null,
    saveConnection: async (value: GoogleWorkspaceConnection) => { connections.set(`${value.workspace_id}:${value.user_id}`, value); },
    deleteConnection: async (id: string, member: string) => {
      const key = `${id}:${member}`;
      const value = connections.get(key) ?? null;
      connections.delete(key);
      return value;
    },
    fetcher: options.fetcher ?? (async () => Response.json({})) as typeof fetch,
    now: () => now,
    logFailure: () => {},
  };
  const handler = createGoogleWorkspaceHandler(dependencies);
  const post = (payload: unknown, token = 'valid-token') => new Request('https://project.example/functions/v1/google-workspace', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: appOrigin, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const key = (id = workspaceId, member = userId) => `${id}:${member}`;
  const setTime = (value: number) => { now = value; };
  const addConnection = async () => {
    const secretId = 'c5000000-0000-4000-8000-000000000001';
    secrets.set(secretId, 'refresh-token');
    connections.set(key(), {
      workspace_id: workspaceId,
      user_id: userId,
      google_subject: 'google-subject',
      google_email: 'person@example.test',
      granted_scopes: [...GOOGLE_REQUIRED_SCOPES],
      refresh_secret_id: secretId,
      connected_at: new Date(now).toISOString(),
    });
  };
  return { handler, post, secrets, states, connections, addConnection, setTime, now: () => now, workspaceId, userId, outsiderId, key };
}

Deno.test('Google connect requires authenticated workspace access and returns state/PKCE authorization URL', async () => {
  const harness = createHarness();
  const response = await harness.handler(harness.post({ action: 'connect', workspaceId }));
  assertEquals(response.status, 200);
  const body = asRecord(await response.json());
  const authUrl = new URL(String(body.authorizationUrl));
  const state = authUrl.searchParams.get('state') ?? '';
  assert(/^[0-9a-f]{64}$/.test(state), 'State should be a 256-bit hex token.');
  assertEquals(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(authUrl.searchParams.get('scope'), GOOGLE_REQUIRED_SCOPES.join(' '));
  assertEquals(harness.states.size, 1);
  assertEquals(harness.secrets.size, 1);
  assert(!JSON.stringify(body).includes('server-only-client-secret'), 'Client secret must never be returned.');
});

Deno.test('Google callback exchanges a single-use code and stores refresh token outside app tables', async () => {
  const observed: { verifier?: string } = {};
  const harness = createHarness({
    fetcher: async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String(init?.body));
        observed.verifier = body.get('code_verifier') ?? undefined;
        return Response.json({
          access_token: 'short-lived-access-token',
          refresh_token: 'long-lived-refresh-token',
          scope: GOOGLE_REQUIRED_SCOPES.join(' '),
        });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ sub: 'google-subject', email: 'person@example.test', email_verified: true });
      }
      throw new Error('Unexpected external request.');
    },
  });
  const started = await harness.handler(harness.post({ action: 'connect', workspaceId }));
  const authUrl = new URL(String(asRecord(await started.json()).authorizationUrl));
  const callback = new Request(`https://project.example/functions/v1/google-workspace?state=${authUrl.searchParams.get('state')}&code=one-time-code`);
  const response = await harness.handler(callback);
  const redirect = new URL(response.headers.get('location') ?? '');
  assertEquals(response.status, 303);
  assertEquals(redirect.searchParams.get('google_connection'), 'connected');
  assert(observed.verifier !== undefined && observed.verifier.length >= 43, 'PKCE verifier should be presented only to Google token exchange.');
  assertEquals(harness.states.size, 1);
  assertEquals(harness.secrets.size, 1);
  const connection = await harness.connections.get(harness.key());
  assertEquals(connection?.google_email, 'person@example.test');
  assertEquals(harness.secrets.get(connection?.refresh_secret_id ?? ''), 'long-lived-refresh-token');
  const replay = await harness.handler(callback);
  assertEquals(new URL(replay.headers.get('location') ?? '').searchParams.get('google_connection'), 'expired');
});

Deno.test('Drive list refreshes the secret server-side and returns only safe file metadata', async () => {
  const requests: Array<{ url: string; method: string; auth: string | null }> = [];
  const harness = createHarness({
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'short-lived-access-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return Response.json({
          files: [{
            id: fileId, name: 'invoice.pdf', mimeType: 'application/pdf',
            modifiedTime: '2026-10-22T10:00:00Z',
            webViewLink: 'https://drive.google.com/file/d/c3000000-0000-4000-8000-000000000001/view',
          }],
          nextPageToken: 'next-page',
        });
      }
      throw new Error('Unexpected external request.');
    },
  });
  await harness.addConnection();
  const response = await harness.handler(harness.post({ action: 'list_files', workspaceId, pageSize: 10 }));
  const body = asRecord(await response.json());
  assertEquals(response.status, 200);
  assertEquals(body.connected, true);
  assertEquals((body.files as Array<Record<string, unknown>>)[0].name, 'invoice.pdf');
  assertEquals(body.nextPageToken, 'next-page');
  const drive = requests.find((entry) => entry.url.startsWith('https://www.googleapis.com/drive/v3/files?'));
  assertEquals(drive?.method, 'GET');
  assertEquals(drive?.auth, 'Bearer short-lived-access-token');
  assert(!JSON.stringify(body).includes('refresh-token'), 'Refresh token must never be returned to the browser.');
});

Deno.test('non-members cannot start OAuth and wrong-origin calls are rejected', async () => {
  const harness = createHarness({ member: false });
  const response = await harness.handler(harness.post({ action: 'connect', workspaceId }));
  assertEquals(response.status, 403);
  const wrongOrigin = new Request('https://project.example/functions/v1/google-workspace', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'connect', workspaceId }),
  });
  assertEquals((await harness.handler(wrongOrigin)).status, 403);
  assertEquals(harness.states.size, 0);
});
