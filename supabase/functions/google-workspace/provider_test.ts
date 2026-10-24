import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  GOOGLE_REQUIRED_SCOPES,
  GOOGLE_GMAIL_SCOPES,
  GOOGLE_GMAIL_READONLY_SCOPE,
  listGoogleDriveFiles,
  listGmailMessages,
  previewGoogleDriveFile,
  previewGmailMessage,
  GoogleProviderError,
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

Deno.test('preview exports a selected Google Doc as bounded plain text', async () => {
  const requests: Array<{ url: string; method: string; auth: string | null }> = [];
  const preview = await previewGoogleDriveFile('access-token', 'doc-123', async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/doc-123?fields=')) {
      return Response.json({
        id: 'doc-123',
        name: 'Invoice notes',
        mimeType: 'application/vnd.google-apps.document',
        trashed: false,
        capabilities: { canDownload: true },
      });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/doc-123/export?')) {
      assertEquals(new URL(url).searchParams.get('mimeType'), 'text/plain');
      return new Response('Invoice total: 125.00', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    throw new Error('Unexpected provider URL.');
  });
  assertEquals(preview, {
    id: 'doc-123',
    name: 'Invoice notes',
    mimeType: 'application/vnd.google-apps.document',
    content: 'Invoice total: 125.00',
  });
  assertEquals(requests.length, 2);
  assert(requests.every((request) => request.method === 'GET' && request.auth === 'Bearer access-token'),
    'Both metadata and export requests must be authenticated GET requests.');
});

Deno.test('preview exports a selected Google Sheet as CSV only after download permission check', async () => {
  let exportCount = 0;
  const preview = await previewGoogleDriveFile('access-token', 'sheet-123', async (input) => {
    const url = String(input);
    if (url.includes('/export?')) {
      exportCount += 1;
      assertEquals(new URL(url).searchParams.get('mimeType'), 'text/csv');
      return new Response('Vendor,Total\\nAcme,120.00', { headers: { 'content-type': 'text/csv; charset=utf-8' } });
    }
    return Response.json({
      id: 'sheet-123',
      name: 'AP sheet',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      capabilities: { canDownload: true },
    });
  });
  assertEquals(preview.content, 'Vendor,Total\\nAcme,120.00');
  assertEquals(exportCount, 1);
});

Deno.test('preview rejects binary files, files without download permission, and wrong response types', async () => {
  const pdfFetcher: typeof fetch = async () => Response.json({
    id: 'pdf-123', name: 'Invoice.pdf', mimeType: 'application/pdf',
    capabilities: { canDownload: true },
  });
  let errorCode = '';
  try { await previewGoogleDriveFile('access-token', 'pdf-123', pdfFetcher); } catch (error) {
    errorCode = error instanceof GoogleProviderError ? error.code : '';
  }
  assertEquals(errorCode, 'GOOGLE_FILE_PREVIEW_UNSUPPORTED');

  const deniedFetcher: typeof fetch = async () => Response.json({
    id: 'doc-123', name: 'Private doc', mimeType: 'application/vnd.google-apps.document',
    capabilities: { canDownload: false },
  });
  errorCode = '';
  try { await previewGoogleDriveFile('access-token', 'doc-123', deniedFetcher); } catch (error) {
    errorCode = error instanceof GoogleProviderError ? error.code : '';
  }
  assertEquals(errorCode, 'GOOGLE_FILE_NOT_DOWNLOADABLE');
});

Deno.test('preview rejects content that exceeds the inline limit', async () => {
  let errorCode = '';
  try {
    await previewGoogleDriveFile('access-token', 'doc-123', async (input) => {
      if (String(input).includes('/export?')) {
        return new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'text/plain' } });
      }
      return Response.json({
        id: 'doc-123', name: 'Large doc', mimeType: 'application/vnd.google-apps.document',
        capabilities: { canDownload: true },
      });
    });
  } catch (error) {
    errorCode = error instanceof GoogleProviderError ? error.code : '';
  }
  assertEquals(errorCode, 'GOOGLE_FILE_PREVIEW_TOO_LARGE');
});

Deno.test('Gmail consent requests the restricted read-only scope in a separate explicit scope set', () => {
  const url = new URL(buildGoogleAuthorizationUrl(config, 'c'.repeat(64), 'd'.repeat(43), 'gmail'));
  assertEquals(url.searchParams.get('scope'), GOOGLE_GMAIL_SCOPES.join(' '));
  assert(url.searchParams.get('scope')?.includes(GOOGLE_GMAIL_READONLY_SCOPE) ?? false, 'Gmail consent must include gmail.readonly.');
  assert(!(url.searchParams.get('scope') ?? '').includes(GOOGLE_REQUIRED_SCOPES[3]), 'Gmail-only consent must not ask for Drive scope.');
});

Deno.test('Gmail list returns only bounded metadata using authenticated GET requests', async () => {
  const requests: Array<{ url: string; method: string; auth: string | null }> = [];
  const result = await listGmailMessages('short-lived-token', 5, null, async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
      const listUrl = new URL(url);
      assertEquals(listUrl.searchParams.get('labelIds'), 'INBOX');
      assertEquals(listUrl.searchParams.get('maxResults'), '5');
      return Response.json({ messages: [{ id: 'msg-1', threadId: 'thread-1' }], nextPageToken: 'next-page' });
    }
    if (url.includes('/messages/msg-1?') && url.includes('format=metadata')) {
      return Response.json({
        id: 'msg-1',
        threadId: 'thread-1',
        snippet: 'Invoice is attached.',
        internalDate: '1792742400000',
        labelIds: ['INBOX', 'UNREAD'],
        payload: { headers: [
          { name: 'From', value: 'vendor@example.test' },
          { name: 'Subject', value: 'October invoice' },
          { name: 'Date', value: 'Thu, 23 Oct 2026 10:00:00 +0000' },
        ] },
      });
    }
    throw new Error('Unexpected Gmail API request.');
  });
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].id, 'msg-1');
  assertEquals(result.messages[0].subject, 'October invoice');
  assertEquals(result.messages[0].from, 'vendor@example.test');
  assertEquals(result.messages[0].snippet, 'Invoice is attached.');
  assertEquals(result.nextPageToken, 'next-page');
  assert(requests.every((entry) => entry.method === 'GET' && entry.auth === 'Bearer short-lived-token'),
    'Gmail API operations must be authenticated GET requests.');
});

Deno.test('Gmail preview returns inline plain text only and ignores attachments', async () => {
  let method = '';
  let requestedUrl = '';
  const preview = await previewGmailMessage('short-lived-token', 'msg-2', async (input, init) => {
    method = init?.method ?? 'GET';
    requestedUrl = String(input);
    return Response.json({
      id: 'msg-2',
      threadId: 'thread-2',
      snippet: 'Plain text snippet.',
      internalDate: '1792742400000',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'accounts@example.test' },
          { name: 'Subject', value: 'Your invoice' },
          { name: 'Date', value: 'Thu, 23 Oct 2026 10:00:00 +0000' },
        ],
        parts: [
          { mimeType: 'text/html', body: { data: 'PGgxPk5vdCBleHRyYWN0ZWQ8L2gxPg' } },
          { mimeType: 'text/plain', body: { data: 'SW52b2ljZSB0b3RhbDogMTI1LjAw' } },
          { mimeType: 'text/plain', filename: 'secret.txt', body: { data: 'QVRUQUNITUVOVCBTRUNSRVQ=' } },
        ],
      },
    });
  });
  assertEquals(method, 'GET');
  assert(requestedUrl.includes('format=full'), 'Preview uses the read-only full-message endpoint.');
  assertEquals(preview.subject, 'Your invoice');
  assertEquals(preview.from, 'accounts@example.test');
  assertEquals(preview.content, 'Invoice total: 125.00');
  assertEquals(preview.contentSource, 'text/plain');
  assert(!preview.content.includes('ATTACHMENT SECRET'), 'Attachment content must not be previewed.');
});

Deno.test('Gmail preview skips text parts explicitly marked as attachments even without filenames', async () => {
  const preview = await previewGmailMessage('short-lived-token', 'msg-5', async () => Response.json({
    id: 'msg-5',
    snippet: 'Safe snippet.',
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          body: { data: 'QVRUQUNITUVOVCBTRUNSRVQ=' },
        },
        { mimeType: 'text/plain', body: { data: 'SW5saW5lIGJvZHk=' } },
      ],
    },
  }));
  assertEquals(preview.content, 'Inline body');
  assertEquals(preview.contentSource, 'text/plain');
  assert(!preview.content.includes('ATTACHMENT SECRET'));
});

Deno.test('Gmail preview falls back to snippet and rejects oversized message bodies', async () => {
  const snippetPreview = await previewGmailMessage('short-lived-token', 'msg-3', async () => Response.json({
    id: 'msg-3', snippet: 'HTML-only snippet', payload: {
      mimeType: 'text/html', body: { data: 'PGgxPkhlbGxvPC9oMT4=' }, headers: [],
    },
  }));
  assertEquals(snippetPreview.content, 'HTML-only snippet');
  assertEquals(snippetPreview.contentSource, 'snippet');

  let errorCode = '';
  try {
    await previewGmailMessage('short-lived-token', 'msg-4', async () => Response.json({
      id: 'msg-4',
      payload: { mimeType: 'text/plain', body: { data: 'eA'.repeat(45_000) }, headers: [] },
    }));
  } catch (error) {
    errorCode = error instanceof GoogleProviderError ? error.code : '';
  }
  assertEquals(errorCode, 'GOOGLE_GMAIL_MESSAGE_PREVIEW_TOO_LARGE');
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
