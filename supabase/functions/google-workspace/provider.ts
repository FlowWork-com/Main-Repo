export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_REQUIRED_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  GOOGLE_DRIVE_FILE_SCOPE,
] as const;

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
  url.searchParams.set('scope', GOOGLE_REQUIRED_SCOPES.join(' '));
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
  return normalizeTokenResponse(value);
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
      (pageToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(pageToken)))) {
    throw new GoogleProviderError('GOOGLE_DRIVE_REQUEST_INVALID');
  }
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('q', 'trashed = false');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken');
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
    }];
  });
  const nextPageToken = typeof value.nextPageToken === 'string' &&
    value.nextPageToken.length <= 2048 ? value.nextPageToken : null;
  return { files, nextPageToken };
}

export function parseGrantedScopes(value: unknown): string[] {
  return typeof value === 'string'
    ? [...new Set(value.trim().split(/\s+/).filter(Boolean))]
    : [];
}

export function hasRequiredGoogleScopes(scopes: readonly string[]): boolean {
  return GOOGLE_REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

function normalizeTokenResponse(value: unknown): GoogleTokenResponse {
  if (!isRecord(value) ||
    typeof value.access_token !== 'string' || !value.access_token.trim() || value.access_token.length > 8192) {
    throw new GoogleProviderError('GOOGLE_TOKEN_RESPONSE_INVALID');
  }
  const scopes = parseGrantedScopes(value.scope);
  if (!hasRequiredGoogleScopes(scopes)) {
    throw new GoogleProviderError('GOOGLE_REQUIRED_SCOPE_MISSING');
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

function isSafeGoogleFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'drive.google.com' || url.hostname.endsWith('.google.com')) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
