import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  GOOGLE_REQUIRED_SCOPES,
  listGoogleDriveFiles,
  refreshGoogleAccessToken,
} from './provider.ts';

const config = {
  clientId: 'google-client-id.apps.googleusercontent.com',
  clientSecret: 'server-only-client-secret',
  redirectUri: 'https://project.example/functions/v1/google-workspace',
};

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(actual: boolean, message: string): void {
  if (!actual) throw new Error(message);
}
function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) throw new Error(`Expected value to include ${expected}`);
}

Deno.test('Google authorization requests the minimum read-only integration scopes with state and PKCE', () => {
  const url = new URL(buildGoogleAuthorizationUrl(config, 'a'.repeat(64), 'b'.repeat(43)));
  assertEquals(url.origin, 'https://accounts.google.com');
  assertEquals(url.searchParams.get('state'), 'a'.repeat(64));
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('code_challenge'), 'b'.repeat(43));
  assertEquals(url.searchParams.get('access_type'), 'offline');
  assertEquals(url.searchParams.get('scope'), GOOGLE_REQUIRED_SCOPES.join(' '));
  assert(!url.searchParams.has('client_secret'), 'Client secret must never be present in the authorization URL.');
  assert(!url.searchParams.get('scope')!.includes('drive.readonly'), 'Do not request broad read-only Drive scope.');
  assert(!url.searchParams.get('scope')!.includes('gmail'), 'This phase must not request Gmail access.');
});

Deno.test('authorization-code exchange sends PKCE verifier only to Google token endpoint', async () => {
  let requestUrl = '';
  let requestBody = new URLSearchParams();
  const token = await exchangeGoogleAuthorizationCode(config, 'one-time-code', 'c'.repeat(43), async (input, init) => {
    requestUrl = String(input);
    requestBody = new URLSearchParams(String(init?.body));
    return Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: GOOGLE_REQUIRED_SCOPES.join(' '),
    });
  });
  assertEquals(requestUrl, 'https://oauth2.googleapis.com/token');
  assertEquals(requestBody.get('code_verifier'), 'c'.repeat(43));
  assertEquals(requestBody.get('client_secret'), 'server-only-client-secret');
  assertEquals(token.refreshToken, 'refresh-token');
  assertEquals(token.grantedScopes, [...GOOGLE_REQUIRED_SCOPES]);
});

Deno.test('authorization exchange rejects missing scopes and does not reveal provider body', async () => {
  let message = '';
  try {
    await exchangeGoogleAuthorizationCode(config, 'one-time-code', 'c'.repeat(43), async () =>
      Response.json({ access_token: 'access-token', scope: 'openid email profile' }));
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertStringIncludes(message, 'Google provider request failed.');
  assert(!message.includes('access-token'), 'Provider response must not appear in thrown errors.');
});

Deno.test('Drive listing uses GET, limits output to file metadata, and rejects unsafe web links', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = await listGoogleDriveFiles('access-token', 2, 'page-token', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({
      files: [
        { id: 'drive-1', name: 'Invoice.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-22T00:00:00Z', webViewLink: 'https://drive.google.com/file/d/drive-1/view' },
        { id: 'drive-2', name: 'Suspicious link', mimeType: 'text/plain', webViewLink: 'https://attacker.google.com/not-drive' },
      ],
      nextPageToken: 'next-page',
    });
  });
  const url = new URL(requestUrl);
  assertEquals(requestInit?.method, 'GET');
  assertEquals(requestInit?.redirect, 'error');
  assertEquals(url.searchParams.get('pageSize'), '2');
  assertEquals(url.searchParams.get('pageToken'), 'page-token');
  assertEquals(url.searchParams.get('q'), 'trashed = false');
  assertEquals(result.files.length, 2);
  assertEquals(result.files[0].webViewLink, 'https://drive.google.com/file/d/drive-1/view');
  assertEquals(result.files[1].webViewLink, null);
  assertEquals(result.nextPageToken, 'next-page');
});

Deno.test('refresh token errors are sanitized', async () => {
  let message = '';
  try {
    await refreshGoogleAccessToken(config, 'refresh-token', async () =>
      Response.json({ error: 'invalid_grant', error_description: 'sensitive provider detail' }, { status: 400 }));
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertStringIncludes(message, 'Google provider request failed.');
  assert(!message.includes('sensitive provider detail'), 'Provider details must not be returned.');
});
