export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;
export const GOOGLE_REQUIRED_SCOPES = [...GOOGLE_IDENTITY_SCOPES, GOOGLE_DRIVE_FILE_SCOPE] as const;
export const GOOGLE_GMAIL_SCOPES = [...GOOGLE_IDENTITY_SCOPES, GOOGLE_GMAIL_READONLY_SCOPE] as const;
export type GoogleScopeSet = 'drive' | 'gmail';

export interface GoogleGmailMessageSummary {
  readonly id: string;
  readonly threadId: string | null;
  readonly subject: string;
  readonly from: string;
  readonly date: string | null;
  readonly snippet: string;
  readonly labelIds: readonly string[];
}

export interface GoogleGmailMessagePreview extends GoogleGmailMessageSummary {
  readonly content: string;
  readonly contentSource: 'text/plain' | 'snippet';
}

export interface GoogleOAuthConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface GoogleTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly grantedScopes: readonly string[];
}

export interface GoogleUserProfile {
  readonly subject: string;
  readonly email: string;
}

export interface GoogleDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string | null;
  readonly webViewLink: string | null;
  readonly canPreview: boolean;
}

export interface GoogleDriveFilePreview {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly content: string;
}

const MAX_DRIVE_PREVIEW_BYTES = 256 * 1024;

function previewExportMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
    case 'application/vnd.google-apps.presentation':
      return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    case 'text/plain':
    case 'text/csv':
    case 'text/tab-separated-values':
    case 'text/markdown':
      return mimeType;
    default:
      return null;
  }
}

export class GoogleProviderError extends Error {
  constructor(readonly code: string) {
    super('Google provider request failed.');
    this.name = 'GoogleProviderError';
  }
}

export function buildGoogleAuthorizationUrl(
  config: GoogleOAuthConfiguration,
  state: string,
  codeChallenge: string,
  scopeSet: GoogleScopeSet = 'drive',
): string {
  if (!isValidOAuthConfiguration(config) ||
    !/^[0-9a-f]{64}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new GoogleProviderError('GOOGLE_CONFIGURATION_INVALID');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  const scopes = scopeSet === 'gmail' ? GOOGLE_GMAIL_SCOPES : GOOGLE_REQUIRED_SCOPES;
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(
  config: GoogleOAuthConfiguration,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
  scopeSet: GoogleScopeSet = 'drive',
): Promise<GoogleTokenResponse> {
  if (!isValidOAuthConfiguration(config) ||
    !code.trim() || code.length > 4096 ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    throw new GoogleProviderError('GOOGLE_CONFIGURATION_INVALID');
  }
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  const value = await readBoundedJson(response, 32_768);
  if (!response.ok) {
    throw new GoogleProviderError(isRecord(value) && value.error === 'invalid_grant'
      ? 'GOOGLE_AUTHORIZATION_CODE_REJECTED'
      : 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }
  return normalizeTokenResponse(value, scopeSet);
}

export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfiguration,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!isValidOAuthConfiguration(config) || !refreshToken.trim() || refreshToken.length > 8192) {
    throw new GoogleProviderError('GOOGLE_CONFIGURATION_INVALID');
  }
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const value = await readBoundedJson(response, 32_768);
  if (!response.ok) {
    throw new GoogleProviderError(isRecord(value) && value.error === 'invalid_grant'
      ? 'GOOGLE_REFRESH_TOKEN_REVOKED'
      : 'GOOGLE_TOKEN_REFRESH_FAILED');
  }
  if (!isRecord(value) || typeof value.access_token !== 'string' ||
    !value.access_token.trim() || value.access_token.length > 8192) {
    throw new GoogleProviderError('GOOGLE_TOKEN_RESPONSE_INVALID');
  }
  return value.access_token;
}

export async function fetchGoogleUserProfile(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleUserProfile> {
  if (!accessToken.trim() || accessToken.length > 8192) {
    throw new GoogleProviderError('GOOGLE_TOKEN_RESPONSE_INVALID');
  }
  const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const value = await readBoundedJson(response, 16_384);
  if (!response.ok || !isRecord(value) ||
    typeof value.sub !== 'string' || !value.sub.trim() || value.sub.length > 255 ||
    typeof value.email !== 'string' || !value.email.trim() || value.email.length > 320 ||
    value.email_verified !== true) {
    throw new GoogleProviderError('GOOGLE_PROFILE_UNAVAILABLE');
  }
  return { subject: value.sub, email: value.email };
}

export async function listGoogleDriveFiles(
  accessToken: string,
  pageSize = 20,
  pageToken?: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly files: readonly GoogleDriveFile[]; readonly nextPageToken: string | null }> {
  if (!accessToken.trim() || accessToken.length > 8192 ||
    !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
    (pageToken !== undefined && pageToken !== null &&
      (pageToken.length > 2048 || hasControlCharacter(pageToken)))) {
    throw new GoogleProviderError('GOOGLE_DRIVE_REQUEST_INVALID');
  }
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('q', 'trashed = false');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink,capabilities(canDownload)),nextPageToken');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const response = await fetcher(url.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const value = await readBoundedJson(response, 262_144);
  if (!response.ok) throw new GoogleProviderError('GOOGLE_DRIVE_LIST_FAILED');
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new GoogleProviderError('GOOGLE_DRIVE_RESPONSE_INVALID');
  }
  const files = value.files.slice(0, pageSize).flatMap((candidate): GoogleDriveFile[] => {
    if (!isRecord(candidate) ||
      typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 512 ||
      typeof candidate.name !== 'string' || candidate.name.length > 1000 ||
      typeof candidate.mimeType !== 'string' || candidate.mimeType.length > 255) {
      return [];
    }
    const modifiedTime = typeof candidate.modifiedTime === 'string' &&
      candidate.modifiedTime.length <= 50 ? candidate.modifiedTime : null;
    const webViewLink = typeof candidate.webViewLink === 'string' && isSafeGoogleFileUrl(candidate.webViewLink)
      ? candidate.webViewLink
      : null;
    return [{
      id: candidate.id,
      name: candidate.name,
      mimeType: candidate.mimeType,
      modifiedTime,
      webViewLink,
      canPreview: isRecord(candidate.capabilities) &&
        candidate.capabilities.canDownload === true &&
        previewExportMimeType(candidate.mimeType) !== null,
    }];
  });
  const nextPageToken = typeof value.nextPageToken === 'string' &&
    value.nextPageToken.length <= 2048 ? value.nextPageToken : null;
  return { files, nextPageToken };
}

/**
 * Fetches a user-selected, read-only text preview from Google Drive.
 * Native Docs and Slides are exported as plain text; Sheets exports the first sheet as CSV.
 * Binary files are deliberately excluded. Preview content is bounded and never persisted here.
 */
export async function previewGoogleDriveFile(
  accessToken: string,
  fileId: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleDriveFilePreview> {
  if (!accessToken.trim() || accessToken.length > 8192 ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(fileId)) {
    throw new GoogleProviderError('GOOGLE_DRIVE_REQUEST_INVALID');
  }

  const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  metadataUrl.searchParams.set('fields', 'id,name,mimeType,trashed,capabilities(canDownload)');
  const metadataResponse = await fetcher(metadataUrl.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const metadata = await readBoundedJson(metadataResponse, 16_384);
  if (!metadataResponse.ok) throw new GoogleProviderError('GOOGLE_DRIVE_PREVIEW_FAILED');
  if (!isRecord(metadata) || metadata.id !== fileId ||
    typeof metadata.name !== 'string' || metadata.name.length > 1000 ||
    typeof metadata.mimeType !== 'string' || metadata.trashed === true) {
    throw new GoogleProviderError('GOOGLE_DRIVE_RESPONSE_INVALID');
  }
  if (!isRecord(metadata.capabilities) || metadata.capabilities.canDownload !== true) {
    throw new GoogleProviderError('GOOGLE_FILE_NOT_DOWNLOADABLE');
  }

  const exportMimeType = previewExportMimeType(metadata.mimeType);
  if (!exportMimeType) throw new GoogleProviderError('GOOGLE_FILE_PREVIEW_UNSUPPORTED');

  const nativeWorkspaceFile = metadata.mimeType.startsWith('application/vnd.google-apps.');
  const contentUrl = nativeWorkspaceFile
    ? new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`)
    : new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  if (nativeWorkspaceFile) contentUrl.searchParams.set('mimeType', exportMimeType);
  else contentUrl.searchParams.set('alt', 'media');

  const contentResponse = await fetcher(contentUrl.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: exportMimeType },
    signal: AbortSignal.timeout(20_000),
  });
  if (!contentResponse.ok) {
    throw new GoogleProviderError('GOOGLE_DRIVE_PREVIEW_FAILED');
  }
  const responseType = contentResponse.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (responseType !== exportMimeType) {
    throw new GoogleProviderError('GOOGLE_DRIVE_PREVIEW_TYPE_MISMATCH');
  }
  const text = await readBoundedText(contentResponse, MAX_DRIVE_PREVIEW_BYTES);
  return {
    id: fileId,
    name: metadata.name,
    mimeType: metadata.mimeType,
    content: text,
  };
}

const MAX_GMAIL_LIST_RESULTS = 20;
const MAX_GMAIL_PREVIEW_BYTES = 64 * 1024;
const MAX_GMAIL_API_RESPONSE_BYTES = 1024 * 1024;

export async function listGmailMessages(
  accessToken: string,
  pageSize = 10,
  pageToken?: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly messages: readonly GoogleGmailMessageSummary[]; readonly nextPageToken: string | null }> {
  if (!accessToken.trim() || accessToken.length > 8192 ||
    !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_GMAIL_LIST_RESULTS ||
    (pageToken != null && (pageToken.length > 2048 || hasControlCharacter(pageToken)))) {
    throw new GoogleProviderError('GOOGLE_GMAIL_REQUEST_INVALID');
  }
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('labelIds', 'INBOX');
  url.searchParams.set('maxResults', String(pageSize));
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const response = await fetcher(url.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const value = await readBoundedJson(response, 128 * 1024);
  if (!response.ok) throw new GoogleProviderError('GOOGLE_GMAIL_LIST_FAILED');
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');
  }

  const ids = value.messages.slice(0, pageSize).flatMap((item): string[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !isSafeGoogleMessageId(item.id)) return [];
    return [item.id];
  });

  const messages = await Promise.all(ids.map(async (id) => {
    const metadataUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    metadataUrl.searchParams.set('format', 'metadata');
    for (const header of ['From', 'Subject', 'Date']) metadataUrl.searchParams.append('metadataHeaders', header);
    const metadataResponse = await fetcher(metadataUrl.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const metadata = await readBoundedJson(metadataResponse, 64 * 1024);
    if (!metadataResponse.ok) throw new GoogleProviderError('GOOGLE_GMAIL_LIST_FAILED');
    if (!isRecord(metadata) || metadata.id !== id) throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');
    const headers = getMessageHeaders(metadata);
    const internalDate = typeof metadata.internalDate === 'string' && /^\d{1,16}$/.test(metadata.internalDate)
      ? Number(metadata.internalDate)
      : NaN;
    return {
      id,
      threadId: typeof metadata.threadId === 'string' && metadata.threadId.length <= 512 ? metadata.threadId : null,
      subject: clipText(headerValue(headers, 'subject'), 500) || '(No subject)',
      from: clipText(headerValue(headers, 'from'), 500) || '(Unknown sender)',
      date: Number.isSafeInteger(internalDate) && internalDate > 0
        ? new Date(internalDate).toISOString()
        : null,
      snippet: clipText(typeof metadata.snippet === 'string' ? metadata.snippet : '', 1200),
      labelIds: Array.isArray(metadata.labelIds)
        ? metadata.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 25).map((label) => clipText(label, 80))
        : [],
    } satisfies GoogleGmailMessageSummary;
  }));

  return {
    messages,
    nextPageToken: typeof value.nextPageToken === 'string' && value.nextPageToken.length <= 2048
      ? value.nextPageToken
      : null,
  };
}

export async function previewGmailMessage(
  accessToken: string,
  messageId: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleGmailMessagePreview> {
  if (!accessToken.trim() || accessToken.length > 8192 || !isSafeGoogleMessageId(messageId)) {
    throw new GoogleProviderError('GOOGLE_GMAIL_REQUEST_INVALID');
  }
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  const response = await fetcher(url.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new GoogleProviderError('GOOGLE_GMAIL_MESSAGE_NOT_FOUND');
  const value = await readBoundedJson(response, MAX_GMAIL_API_RESPONSE_BYTES);
  if (!response.ok) throw new GoogleProviderError('GOOGLE_GMAIL_PREVIEW_FAILED');
  if (!isRecord(value) || value.id !== messageId) throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');

  const headers = getMessageHeaders(value);
  const snippet = clipText(typeof value.snippet === 'string' ? value.snippet : '', 4000);
  const encodedBody = findInlinePlainTextBody(value.payload);
  let content = snippet;
  let contentSource: GoogleGmailMessagePreview['contentSource'] = 'snippet';
  if (encodedBody) {
    content = decodeGmailText(encodedBody);
    contentSource = 'text/plain';
  }
  const internalDate = typeof value.internalDate === 'string' && /^\d{1,16}$/.test(value.internalDate)
    ? Number(value.internalDate)
    : NaN;
  return {
    id: messageId,
    threadId: typeof value.threadId === 'string' && value.threadId.length <= 512 ? value.threadId : null,
    subject: clipText(headerValue(headers, 'subject'), 500) || '(No subject)',
    from: clipText(headerValue(headers, 'from'), 500) || '(Unknown sender)',
    date: Number.isSafeInteger(internalDate) && internalDate > 0
      ? new Date(internalDate).toISOString()
      : null,
    snippet,
    labelIds: Array.isArray(value.labelIds)
      ? value.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 25).map((label) => clipText(label, 80))
      : [],
    content,
    contentSource,
  };
}

function isSafeGoogleMessageId(value: string): boolean {
  return value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

function getMessageHeaders(value: Record<string, unknown>): Record<string, string> {
  const payload = value.payload;
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return {};
  const headers: Record<string, string> = {};
  for (const item of payload.headers) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    const name = item.name.toLowerCase();
    if (['from', 'subject', 'date'].includes(name) && !headers[name]) {
      headers[name] = clipText(item.value, 1000);
    }
  }
  return headers;
}

function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name] ?? '';
}

function findInlinePlainTextBody(payload: unknown): string | null {
  let visited = 0;
  const walk = (value: unknown, depth: number): string | null => {
    if (!isRecord(value) || depth > 16 || ++visited > 256) return null;
    const filename = typeof value.filename === 'string' ? value.filename : '';
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType.toLowerCase() : '';
    const headers = Array.isArray(value.headers) ? value.headers : [];
    const disposition = headers.find((header) =>
      isRecord(header) && typeof header.name === 'string' &&
      header.name.toLowerCase() === 'content-disposition'
    );
    const isAttachment = isRecord(disposition) && typeof disposition.value === 'string' &&
      /^\\s*attachment\\b/i.test(disposition.value);
    if (filename.trim() || isAttachment) return null;
    const body = isRecord(value.body) ? value.body : null;
    if (mimeType === 'text/plain' && body &&
      typeof body.data === 'string' && body.data.length > 0) {
      return body.data;
    }
    if (!Array.isArray(value.parts)) return null;
    for (const part of value.parts) {
      const found = walk(part, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload, 0);
}

function decodeGmailText(encoded: string): string {
  if (encoded.length > Math.ceil(MAX_GMAIL_PREVIEW_BYTES * 4 / 3) + 8) {
    throw new GoogleProviderError('GOOGLE_GMAIL_MESSAGE_PREVIEW_TOO_LARGE');
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');
  }
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');
  }
  if (binary.length > MAX_GMAIL_PREVIEW_BYTES) {
    throw new GoogleProviderError('GOOGLE_GMAIL_MESSAGE_PREVIEW_TOO_LARGE');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GoogleProviderError('GOOGLE_GMAIL_RESPONSE_INVALID');
  }
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new GoogleProviderError('GOOGLE_PROVIDER_RESPONSE_EMPTY');
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
        throw new GoogleProviderError('GOOGLE_FILE_PREVIEW_TOO_LARGE');
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
    throw new GoogleProviderError('GOOGLE_DRIVE_PREVIEW_TYPE_MISMATCH');
  }
}

export function parseGrantedScopes(value: unknown): string[] {
  return typeof value === 'string'
    ? [...new Set(value.trim().split(/\s+/).filter(Boolean))]
    : [];
}

export function hasRequiredGoogleScopes(scopes: readonly string[]): boolean {
  return GOOGLE_REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

export function hasGmailReadOnlyScope(scopes: readonly string[]): boolean {
  return GOOGLE_IDENTITY_SCOPES.every((scope) => scopes.includes(scope)) &&
    scopes.includes(GOOGLE_GMAIL_READONLY_SCOPE);
}

export function hasScopesForSet(scopes: readonly string[], scopeSet: GoogleScopeSet): boolean {
  return scopeSet === 'gmail' ? hasGmailReadOnlyScope(scopes) : hasRequiredGoogleScopes(scopes);
}

function normalizeTokenResponse(value: unknown, scopeSet: GoogleScopeSet): GoogleTokenResponse {
  if (!isRecord(value) ||
    typeof value.access_token !== 'string' || !value.access_token.trim() || value.access_token.length > 8192) {
    throw new GoogleProviderError('GOOGLE_TOKEN_RESPONSE_INVALID');
  }
  const scopes = parseGrantedScopes(value.scope);
  if (!hasScopesForSet(scopes, scopeSet)) {
    throw new GoogleProviderError(scopeSet === 'gmail' ? 'GOOGLE_GMAIL_SCOPE_MISSING' : 'GOOGLE_REQUIRED_SCOPE_MISSING');
  }
  const refreshToken = typeof value.refresh_token === 'string' &&
    value.refresh_token.trim() && value.refresh_token.length <= 8192
    ? value.refresh_token
    : null;
  return {
    accessToken: value.access_token,
    refreshToken,
    grantedScopes: scopes,
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new GoogleProviderError('GOOGLE_PROVIDER_RESPONSE_EMPTY');
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
        throw new GoogleProviderError('GOOGLE_PROVIDER_RESPONSE_TOO_LARGE');
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GoogleProviderError('GOOGLE_PROVIDER_RESPONSE_INVALID');
  }
  return value;
}

function isValidOAuthConfiguration(config: GoogleOAuthConfiguration): boolean {
  if (!config.clientId.trim() || !config.clientSecret.trim() ||
    config.clientId.length > 512 || config.clientSecret.length > 4096) return false;
  try {
    const url = new URL(config.redirectUri);
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (localhost && url.protocol === 'http:'));
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isSafeGoogleFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com', 'forms.google.com'].includes(url.hostname) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
