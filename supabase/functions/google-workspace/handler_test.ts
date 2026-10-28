import {
  createGoogleWorkspaceHandler,
  type GoogleOAuthState,
  type GoogleWorkspaceConnection,
  type GoogleWorkspaceEnvironment,
} from './handler.ts';
import { GOOGLE_GMAIL_SCOPES, GOOGLE_REQUIRED_SCOPES } from './provider.ts';

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
  readonly deleteSecretFails?: boolean;
  readonly deleteConnectionFails?: boolean;
} = {}) {
  const secrets = new Map<string, string>();
  const states = new Map<string, GoogleOAuthState>();
  const connections = new Map<string, GoogleWorkspaceConnection>();
  const loggedFailures: string[] = [];
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
    deleteSecret: async (id: string) => {
      if (options.deleteSecretFails) throw new Error('secret store unavailable');
      secrets.delete(id);
    },
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
      if (options.deleteConnectionFails) throw new Error('database unavailable');
      const key = `${id}:${member}`;
      const value = connections.get(key) ?? null;
      connections.delete(key);
      return value;
    },
    fetcher: options.fetcher ?? (async () => Response.json({})) as typeof fetch,
    now: () => now,
    logFailure: (code: string) => { loggedFailures.push(code); },
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
  return { handler, post, secrets, states, connections, addConnection, setTime, now: () => now, workspaceId, userId, outsiderId, key, loggedFailures };
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

Deno.test('selected Drive text preview requires membership and returns bounded content without tokens', async () => {
  const requests: string[] = [];
  const harness = createHarness({
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'short-lived-access-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=`)) {
        return Response.json({
          id: fileId,
          name: 'Selected notes',
          mimeType: 'application/vnd.google-apps.document',
          capabilities: { canDownload: true },
        });
      }
      if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${fileId}/export?`)) {
        return new Response('Invoice total: 125.00', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      throw new Error('Unexpected external request.');
    },
  });
  await harness.addConnection();
  const response = await harness.handler(harness.post({ action: 'preview_file', workspaceId, fileId }));
  const body = asRecord(await response.json());
  const preview = asRecord(body.preview);
  assertEquals(response.status, 200);
  assertEquals(body.connected, true);
  assertEquals(preview.id, fileId);
  assertEquals(preview.name, 'Selected notes');
  assertEquals(preview.content, 'Invoice total: 125.00');
  assert(!JSON.stringify(body).includes('refresh-token'), 'Refresh token must not be returned to the browser.');
  assertEquals(requests.filter((url) => url.includes('/export?')).length, 1);
});

Deno.test('Drive preview rejects malformed IDs and does not call the provider for them', async () => {
  let externalCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      externalCalls += 1;
      return Response.json({});
    },
  });
  const response = await harness.handler(harness.post({
    action: 'preview_file',
    workspaceId,
    fileId: '../other-user-file',
  }));
  assertEquals(response.status, 400);
  assertEquals(externalCalls, 0);
});

Deno.test('Gmail authorization is explicit, separate from Drive, and recorded in single-use state', async () => {
  const harness = createHarness({
    fetcher: async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'short-lived-gmail-token',
          refresh_token: 'gmail-refresh-token',
          scope: GOOGLE_GMAIL_SCOPES.join(' '),
        });
      }
      if (String(input) === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ sub: 'google-subject', email: 'person@example.test', email_verified: true });
      }
      throw new Error('Unexpected external request.');
    },
  });
  const started = await harness.handler(harness.post({ action: 'connect_gmail', workspaceId }));
  assertEquals(started.status, 200);
  const body = asRecord(await started.json());
  const authorizationUrl = new URL(String(body.authorizationUrl));
  assertEquals(authorizationUrl.searchParams.get('scope'), GOOGLE_GMAIL_SCOPES.join(' '));
  assert(!(authorizationUrl.searchParams.get('scope') ?? '').includes(GOOGLE_REQUIRED_SCOPES[3]),
    'Gmail-only authorization must not ask for Drive scope.');
  const state = [...harness.states.values()][0];
  assertEquals(state.requested_scope_set, 'gmail');

  const callback = await harness.handler(new Request(
    `https://project.example/functions/v1/google-workspace?state=${authorizationUrl.searchParams.get('state')}&code=gmail-code`,
  ));
  assertEquals(new URL(callback.headers.get('location') ?? '').searchParams.get('google_connection'), 'gmail_connected');
  const connection = harness.connections.get(harness.key());
  assertEquals(connection?.granted_scopes, [...GOOGLE_GMAIL_SCOPES]);
});

Deno.test('incremental Gmail consent preserves the existing Drive refresh token when Google omits a new one', async () => {
  const harness = createHarness({
    fetcher: async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'short-lived-combined-token',
          scope: [...GOOGLE_REQUIRED_SCOPES, 'https://www.googleapis.com/auth/gmail.readonly'].join(' '),
        });
      }
      if (String(input) === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ sub: 'google-subject', email: 'person@example.test', email_verified: true });
      }
      throw new Error('Unexpected external request.');
    },
  });
  await harness.addConnection();
  const prior = harness.connections.get(harness.key());
  if (!prior) throw new Error('Fixture Drive connection missing.');
  const priorSecretId = prior.refresh_secret_id;
  const priorSecret = harness.secrets.get(priorSecretId);

  const started = await harness.handler(harness.post({ action: 'connect_gmail', workspaceId }));
  const startedBody = asRecord(await started.json());
  const authorizationUrl = new URL(String(startedBody.authorizationUrl));
  const callback = await harness.handler(new Request(
    `https://project.example/functions/v1/google-workspace?state=${authorizationUrl.searchParams.get('state')}&code=gmail-code`,
  ));
  assertEquals(new URL(callback.headers.get('location') ?? '').searchParams.get('google_connection'), 'gmail_connected');

  const updated = harness.connections.get(harness.key());
  assertEquals(updated?.refresh_secret_id, priorSecretId);
  assertEquals(harness.secrets.get(priorSecretId), priorSecret);
  assert(updated?.granted_scopes.includes('https://www.googleapis.com/auth/drive.file') ?? false, 'Incremental Gmail consent must preserve Drive access.');
  assert(updated?.granted_scopes.includes('https://www.googleapis.com/auth/gmail.readonly') ?? false, 'Incremental consent must add Gmail read-only access.');
});

Deno.test('Drive-only connection cannot read Gmail without explicit Gmail consent', async () => {
  let externalCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      externalCalls += 1;
      return Response.json({ access_token: 'token' });
    },
  });
  await harness.addConnection();
  const response = await harness.handler(harness.post({ action: 'list_gmail', workspaceId }));
  assertEquals(response.status, 409);
  const body = asRecord(await response.json());
  assertEquals(asRecord(body.error).code, 'GOOGLE_GMAIL_RECONNECT_REQUIRED');
  assertEquals(externalCalls, 0);
});

Deno.test('Gmail list and preview require a Gmail grant and never expose refresh tokens', async () => {
  const requests: string[] = [];
  const harness = createHarness({
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'short-lived-gmail-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        return Response.json({ messages: [{ id: 'msg-1', threadId: 'thread-1' }] });
      }
      if (url.includes('/messages/msg-1?') && url.includes('format=metadata')) {
        return Response.json({
          id: 'msg-1', threadId: 'thread-1', snippet: 'Invoice snippet', internalDate: '1792742400000', labelIds: ['INBOX'],
          payload: { headers: [
            { name: 'From', value: 'vendor@example.test' },
            { name: 'Subject', value: 'October invoice' },
            { name: 'Date', value: 'Thu, 23 Oct 2026 10:00:00 +0000' },
          ] },
        });
      }
      if (url.includes('/messages/msg-1?') && url.includes('format=full')) {
        return Response.json({
          id: 'msg-1', threadId: 'thread-1', snippet: 'Invoice snippet', internalDate: '1792742400000', labelIds: ['INBOX'],
          payload: { mimeType: 'text/plain', headers: [
            { name: 'From', value: 'vendor@example.test' },
            { name: 'Subject', value: 'October invoice' },
          ], body: { data: 'SW52b2ljZSB0b3RhbDogMTI1LjAw' } },
        });
      }
      throw new Error('Unexpected external request.');
    },
  });
  await harness.addConnection();
  const existing = harness.connections.get(harness.key());
  if (!existing) throw new Error('Fixture connection missing.');
  harness.connections.set(harness.key(), { ...existing, granted_scopes: [...GOOGLE_GMAIL_SCOPES] });

  const listed = await harness.handler(harness.post({ action: 'list_gmail', workspaceId, pageSize: 10 }));
  const listBody = asRecord(await listed.json());
  assertEquals(listed.status, 200);
  assertEquals((listBody.messages as Array<Record<string, unknown>>)[0].subject, 'October invoice');
  assert(!JSON.stringify(listBody).includes('refresh-token'), 'Refresh token must not reach the browser.');

  const previewed = await harness.handler(harness.post({ action: 'preview_gmail_message', workspaceId, messageId: 'msg-1' }));
  const previewBody = asRecord(await previewed.json());
  const preview = asRecord(previewBody.preview);
  assertEquals(previewed.status, 200);
  assertEquals(preview.subject, 'October invoice');
  assertEquals(preview.content, 'Invoice total: 125.00');
  assertEquals(preview.contentSource, 'text/plain');
  assert(!JSON.stringify(previewBody).includes('refresh-token'), 'Refresh token must never be returned.');
  assert(requests.every((url) => !url.includes('/send') && !url.includes('/modify') && !url.includes('/trash')),
    'Read-only Gmail flow must not call mutation endpoints.');
});

Deno.test('Gmail preview rejects malformed IDs before external requests', async () => {
  let externalCalls = 0;
  const harness = createHarness({ fetcher: async () => {
    externalCalls += 1;
    return Response.json({});
  } });
  const response = await harness.handler(harness.post({ action: 'preview_gmail_message', workspaceId, messageId: '../other-user' }));
  assertEquals(response.status, 400);
  assertEquals(externalCalls, 0);
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


Deno.test('Google disconnect deletes the current member connection and Vault secret and is idempotent', async () => {
  const harness = createHarness();
  await harness.addConnection();

  const disconnected = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  assertEquals(disconnected.status, 200);
  assertEquals(await disconnected.json(), { connected: false, credentialCleanupPending: false });
  assertEquals(harness.connections.has(harness.key()), false);
  assertEquals(harness.secrets.has('c5000000-0000-4000-8000-000000000001'), false);

  const repeated = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  assertEquals(repeated.status, 200);
  assertEquals(await repeated.json(), { connected: false, credentialCleanupPending: false });
  assertEquals(harness.connections.size, 0);
});

Deno.test('Google disconnect rejects non-members before changing connection or secret state', async () => {
  const harness = createHarness({ member: false });
  await harness.addConnection();

  const response = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  assertEquals(response.status, 403);
  assertEquals(harness.connections.has(harness.key()), true);
  assertEquals(harness.secrets.get('c5000000-0000-4000-8000-000000000001'), 'refresh-token');
});

Deno.test('Google disconnect reports pending secret cleanup without exposing provider secret details', async () => {
  const harness = createHarness({ deleteSecretFails: true });
  await harness.addConnection();

  const response = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { connected: false, credentialCleanupPending: true });
  assertEquals(harness.connections.has(harness.key()), false);
  assertEquals(harness.secrets.get('c5000000-0000-4000-8000-000000000001'), 'refresh-token');
  assertEquals(harness.loggedFailures, ['GOOGLE_SECRET_CLEANUP_FAILED']);
  assert(!JSON.stringify(body).includes('refresh-token'), 'the response must never expose the refresh token');
});

Deno.test('Google disconnect database failures return a sanitized retryable response without deleting the secret', async () => {
  const harness = createHarness({ deleteConnectionFails: true });
  await harness.addConnection();

  const response = await harness.handler(harness.post({ action: 'disconnect', workspaceId }));
  assertEquals(response.status, 503);
  const body = asRecord(await response.json());
  assertEquals(asRecord(body.error).code, 'GOOGLE_DISCONNECT_FAILED');
  assert(!JSON.stringify(body).includes('database unavailable'), 'database error details must not be returned to the caller');
  assertEquals(harness.connections.has(harness.key()), true);
  assertEquals(harness.secrets.get('c5000000-0000-4000-8000-000000000001'), 'refresh-token');
  assertEquals(harness.loggedFailures, ['GOOGLE_DISCONNECT_FAILED']);
});
