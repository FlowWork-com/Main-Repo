import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserProfile,
  GoogleProviderError,
  hasRequiredGoogleScopes,
  hasScopesForSet,
  listGoogleDriveFiles,
  listGmailMessages,
  previewGoogleDriveFile,
  previewGmailMessage,
  refreshGoogleAccessToken,
  type GoogleScopeSet,
  type GoogleOAuthConfiguration,
} from './provider.ts';

const MAX_REQUEST_BYTES = 16_384;

export interface GoogleWorkspaceEnvironment {
  readonly FLOWWORK_GOOGLE_CLIENT_ID?: string;
  readonly FLOWWORK_GOOGLE_CLIENT_SECRET?: string;
  readonly FLOWWORK_GOOGLE_REDIRECT_URI?: string;
  readonly FLOWWORK_GOOGLE_APP_REDIRECT_URL?: string;
}

export interface GoogleAuthenticatedCaller<Context> {
  readonly userId: string;
  readonly context: Context;
}

export interface GoogleOAuthState {
  readonly state_hash: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly pkce_verifier_secret_id: string;
  readonly redirect_uri: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly requested_scope_set: GoogleScopeSet;
}

export interface GoogleWorkspaceConnection {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly google_subject: string;
  readonly google_email: string;
  readonly granted_scopes: readonly string[];
  readonly refresh_secret_id: string;
  readonly connected_at: string;
}

export interface GoogleWorkspaceHandlerDependencies<Context> {
  readonly origins: ReadonlySet<string>;
  readonly environment: GoogleWorkspaceEnvironment;
  readonly authenticate: (accessToken: string) => Promise<GoogleAuthenticatedCaller<Context> | null>;
  readonly isWorkspaceMember: (caller: GoogleAuthenticatedCaller<Context>, workspaceId: string) => Promise<boolean>;
  readonly isCurrentMember: (workspaceId: string, userId: string) => Promise<boolean>;
  readonly storeSecret: (secret: string, name: string, description: string) => Promise<string>;
  readonly readSecret: (secretId: string) => Promise<string | null>;
  readonly deleteSecret: (secretId: string) => Promise<void>;
  readonly createOAuthState: (state: Omit<GoogleOAuthState, 'consumed_at'>) => Promise<void>;
  readonly consumeOAuthState: (stateHash: string) => Promise<GoogleOAuthState | null>;
  readonly getConnection: (workspaceId: string, userId: string) => Promise<GoogleWorkspaceConnection | null>;
  readonly saveConnection: (connection: GoogleWorkspaceConnection) => Promise<void>;
  readonly deleteConnection: (workspaceId: string, userId: string) => Promise<GoogleWorkspaceConnection | null>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly logFailure?: (code: string) => void;
}

export function createGoogleWorkspaceHandler<Context>(
  dependencies: GoogleWorkspaceHandlerDependencies<Context>,
): (request: Request) => Promise<Response> {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async (request) => {
    if (request.method === 'GET') {
      return handleOAuthCallback(request);
    }

    const origin = request.headers.get('origin');
    if (origin && !dependencies.origins.has(origin)) {
      return jsonResponse(403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' } });
    }
    const corsHeaders = origin ? createCorsHeaders(origin) : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported.', corsHeaders);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await readPayload(request);
    } catch (error) {
      const failure = error instanceof GoogleWorkspaceRequestError
        ? error
        : new GoogleWorkspaceRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
      return errorResponse(failure.status, failure.code, failure.message, corsHeaders);
    }

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) return errorResponse(401, 'AUTHENTICATION_REQUIRED', 'A valid sign-in is required.', corsHeaders);

    let caller: GoogleAuthenticatedCaller<Context> | null;
    try {
      caller = await dependencies.authenticate(match[1]);
    } catch {
      dependencies.logFailure?.('AUTHENTICATION_UNAVAILABLE');
      return errorResponse(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication is temporarily unavailable.', corsHeaders);
    }
    if (!caller || !isUuid(caller.userId)) {
      return errorResponse(401, 'INVALID_AUTHENTICATION', 'A valid sign-in is required.', corsHeaders);
    }

    const action = payload.action;
    const workspaceId = payload.workspaceId;
    if (typeof action !== 'string' || !['connect', 'connect_gmail', 'status', 'list_files', 'preview_file', 'list_gmail', 'preview_gmail_message', 'disconnect'].includes(action) ||
      !isUuid(workspaceId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'Request fields are invalid.', corsHeaders);
    }
    const permittedKeys = action === 'list_files' || action === 'list_gmail'
      ? new Set(['action', 'workspaceId', 'pageSize', 'pageToken'])
      : action === 'preview_file'
      ? new Set(['action', 'workspaceId', 'fileId'])
      : action === 'preview_gmail_message'
      ? new Set(['action', 'workspaceId', 'messageId'])
      : new Set(['action', 'workspaceId']);
    if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
      return errorResponse(400, 'INVALID_REQUEST', 'Request fields are invalid.', corsHeaders);
    }
    if ((action === 'list_files' || action === 'list_gmail') &&
      ((payload.pageSize !== undefined &&
        (typeof payload.pageSize !== 'number' || !Number.isInteger(payload.pageSize) ||
          payload.pageSize < 1 || payload.pageSize > (action === 'list_gmail' ? 20 : 100))) ||
        (payload.pageToken !== undefined &&
          (typeof payload.pageToken !== 'string' || payload.pageToken.length > 2048)))) {
      return errorResponse(400, 'INVALID_REQUEST', 'Message list options are invalid.', corsHeaders);
    }
    if (action === 'preview_file' &&
      (typeof payload.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(payload.fileId))) {
      return errorResponse(400, 'INVALID_REQUEST', 'A valid Drive file ID is required.', corsHeaders);
    }
    if (action === 'preview_gmail_message' &&
      (typeof payload.messageId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(payload.messageId))) {
      return errorResponse(400, 'INVALID_REQUEST', 'A valid Gmail message ID is required.', corsHeaders);
    }

    try {
      if (!await dependencies.isWorkspaceMember(caller, workspaceId)) {
        return errorResponse(403, 'PERMISSION_DENIED', 'Workspace access is required.', corsHeaders);
      }
    } catch {
      dependencies.logFailure?.('WORKSPACE_MEMBERSHIP_CHECK_FAILED');
      return errorResponse(503, 'WORKSPACE_ACCESS_UNAVAILABLE', 'Workspace access could not be verified.', corsHeaders);
    }

    if (action === 'connect' || action === 'connect_gmail') {
      const config = getConfiguration(dependencies.environment);
      if (!config) {
        return errorResponse(503, 'GOOGLE_NOT_CONFIGURED', 'Google Workspace is not configured on the server.', corsHeaders);
      }
      let verifierSecretId: string | null = null;
      try {
        const state = randomHex(32);
        const stateHash = await sha256Hex(state);
        const verifier = randomBase64Url(32);
        const challenge = await sha256Base64Url(verifier);
        verifierSecretId = await dependencies.storeSecret(
          verifier,
          `google-oauth-pkce-${workspaceId}-${caller.userId}-${randomHex(8)}`,
          'Short-lived PKCE verifier for a Google Workspace connection attempt.',
        );
        const scopeSet: GoogleScopeSet = action === 'connect_gmail' ? 'gmail' : 'drive';
        await dependencies.createOAuthState({
          state_hash: stateHash,
          workspace_id: workspaceId,
          user_id: caller.userId,
          pkce_verifier_secret_id: verifierSecretId,
          redirect_uri: config.oauth.redirectUri,
          created_at: new Date(now()).toISOString(),
          expires_at: new Date(now() + 10 * 60 * 1000).toISOString(),
          requested_scope_set: scopeSet,
        });
        const authorizationUrl = buildGoogleAuthorizationUrl(config.oauth, state, challenge, scopeSet);
        return jsonResponse(200, { authorizationUrl, expiresInSeconds: 600 }, corsHeaders);
      } catch {
        if (verifierSecretId) {
          try { await dependencies.deleteSecret(verifierSecretId); } catch { dependencies.logFailure?.('OAUTH_VERIFIER_CLEANUP_FAILED'); }
        }
        dependencies.logFailure?.('OAUTH_START_FAILED');
        return errorResponse(503, 'OAUTH_START_FAILED', 'Unable to start Google authorization. Try again.', corsHeaders);
      }
    }

    if (action === 'status') {
      try {
        const connection = await dependencies.getConnection(workspaceId, caller.userId);
        return jsonResponse(200, {
          connected: Boolean(connection),
          ...(connection ? {
            email: connection.google_email,
            connectedAt: connection.connected_at,
            scopes: connection.granted_scopes,
          } : {}),
        }, corsHeaders);
      } catch {
        dependencies.logFailure?.('CONNECTION_STATUS_FAILED');
        return errorResponse(503, 'CONNECTION_STATUS_UNAVAILABLE', 'Google connection status is temporarily unavailable.', corsHeaders);
      }
    }

    if (action === 'disconnect') {
      try {
        const connection = await dependencies.deleteConnection(workspaceId, caller.userId);
        if (connection) {
          try {
            await dependencies.deleteSecret(connection.refresh_secret_id);
          } catch {
            // The row is already removed, so no application operation can use this secret.
            // Keep a cleanup-only error code, not the Vault response, in logs.
            dependencies.logFailure?.('GOOGLE_SECRET_CLEANUP_FAILED');
            return jsonResponse(200, { connected: false, credentialCleanupPending: true }, corsHeaders);
          }
        }
        return jsonResponse(200, { connected: false, credentialCleanupPending: false }, corsHeaders);
      } catch {
        dependencies.logFailure?.('GOOGLE_DISCONNECT_FAILED');
        return errorResponse(503, 'GOOGLE_DISCONNECT_FAILED', 'Unable to disconnect Google Workspace. Try again.', corsHeaders);
      }
    }

    const config = getConfiguration(dependencies.environment);
    if (!config) {
      return errorResponse(503, 'GOOGLE_NOT_CONFIGURED', 'Google Workspace is not configured on the server.', corsHeaders);
    }
    let connection: GoogleWorkspaceConnection | null;
    try {
      connection = await dependencies.getConnection(workspaceId, caller.userId);
    } catch {
      return errorResponse(503, 'GOOGLE_CONNECTION_UNAVAILABLE', 'Google connection status is temporarily unavailable.', corsHeaders);
    }
    if (!connection) {
      return errorResponse(409, 'GOOGLE_NOT_CONNECTED', 'Connect a Google account before listing Drive files.', corsHeaders);
    }
    if ((action === 'list_files' || action === 'preview_file') &&
      !hasRequiredGoogleScopes(connection.granted_scopes)) {
      return errorResponse(409, 'GOOGLE_DRIVE_RECONNECT_REQUIRED', 'Connect Google Drive access before using Drive features.', corsHeaders);
    }
    if ((action === 'list_gmail' || action === 'preview_gmail_message') &&
      !hasScopesForSet(connection.granted_scopes, 'gmail')) {
      return errorResponse(409, 'GOOGLE_GMAIL_RECONNECT_REQUIRED', 'Explicitly connect Gmail read-only access before reading messages.', corsHeaders);
    }

    try {
      const refreshToken = await dependencies.readSecret(connection.refresh_secret_id);
      if (!refreshToken) {
        return errorResponse(409, 'GOOGLE_RECONNECT_REQUIRED', 'Reconnect Google to restore the expired connection.', corsHeaders);
      }
      const accessToken = await refreshGoogleAccessToken(config.oauth, refreshToken, fetcher);
      if (action === 'preview_file') {
        const preview = await previewGoogleDriveFile(accessToken, payload.fileId as string, fetcher);
        return jsonResponse(200, { connected: true, preview }, corsHeaders);
      }
      if (action === 'list_gmail') {
        const result = await listGmailMessages(
          accessToken,
          typeof payload.pageSize === 'number' ? payload.pageSize : 10,
          typeof payload.pageToken === 'string' ? payload.pageToken : null,
          fetcher,
        );
        return jsonResponse(200, { connected: true, messages: result.messages, nextPageToken: result.nextPageToken }, corsHeaders);
      }
      if (action === 'preview_gmail_message') {
        const preview = await previewGmailMessage(accessToken, payload.messageId as string, fetcher);
        return jsonResponse(200, { connected: true, preview }, corsHeaders);
      }
      const result = await listGoogleDriveFiles(
        accessToken,
        typeof payload.pageSize === 'number' ? payload.pageSize : 20,
        typeof payload.pageToken === 'string' ? payload.pageToken : null,
        fetcher,
      );
      return jsonResponse(200, { connected: true, files: result.files, nextPageToken: result.nextPageToken }, corsHeaders);
    } catch (error) {
      if (error instanceof GoogleProviderError && error.code === 'GOOGLE_REFRESH_TOKEN_REVOKED') {
        try {
          const removed = await dependencies.deleteConnection(workspaceId, caller.userId);
          if (removed) await dependencies.deleteSecret(removed.refresh_secret_id);
        } catch {
          dependencies.logFailure?.('GOOGLE_REVOKED_TOKEN_CLEANUP_FAILED');
        }
        return errorResponse(409, 'GOOGLE_RECONNECT_REQUIRED', 'Google authorization expired or was revoked. Reconnect to continue.', corsHeaders);
      }
      if (error instanceof GoogleProviderError) {
        if (error.code === 'GOOGLE_FILE_PREVIEW_UNSUPPORTED') {
          return errorResponse(415, error.code, 'Preview is available only for Google Docs, Sheets, Slides, and supported text files.', corsHeaders);
        }
        if (error.code === 'GOOGLE_FILE_PREVIEW_TOO_LARGE') {
          return errorResponse(413, error.code, 'This file is too large for an inline preview. Open it in Google Drive instead.', corsHeaders);
        }
        if (error.code === 'GOOGLE_FILE_NOT_DOWNLOADABLE') {
          return errorResponse(403, error.code, 'Google does not allow this file to be previewed.', corsHeaders);
        }
        if (error.code === 'GOOGLE_DRIVE_PREVIEW_TYPE_MISMATCH') {
          return errorResponse(415, error.code, 'This file could not be safely previewed as text.', corsHeaders);
        }
        if (error.code === 'GOOGLE_GMAIL_MESSAGE_NOT_FOUND') {
          return errorResponse(404, error.code, 'This Gmail message is no longer available.', corsHeaders);
        }
        if (error.code === 'GOOGLE_GMAIL_MESSAGE_PREVIEW_TOO_LARGE') {
          return errorResponse(413, error.code, 'This Gmail message is too large to preview safely.', corsHeaders);
        }
        if (error.code === 'GOOGLE_GMAIL_REQUEST_INVALID') {
          return errorResponse(400, error.code, 'The Gmail request is invalid.', corsHeaders);
        }
      }
      const gmailAction = action === 'list_gmail' || action === 'preview_gmail_message';
      dependencies.logFailure?.(error instanceof GoogleProviderError ? error.code : gmailAction ? 'GOOGLE_GMAIL_REQUEST_FAILED' : 'GOOGLE_DRIVE_LIST_FAILED');
      const failureCode = gmailAction
        ? action === 'preview_gmail_message' ? 'GOOGLE_GMAIL_PREVIEW_FAILED' : 'GOOGLE_GMAIL_LIST_FAILED'
        : action === 'preview_file' ? 'GOOGLE_DRIVE_PREVIEW_FAILED' : 'GOOGLE_DRIVE_LIST_FAILED';
      const failureMessage = gmailAction
        ? action === 'preview_gmail_message' ? 'Gmail message preview is temporarily unavailable.' : 'Gmail messages are temporarily unavailable.'
        : action === 'preview_file' ? 'Drive file preview is temporarily unavailable.' : 'Google Drive file metadata is temporarily unavailable.';
      return errorResponse(502, failureCode, failureMessage, corsHeaders);
    }
  };

  async function handleOAuthCallback(request: Request): Promise<Response> {
    const config = getConfiguration(dependencies.environment);
    if (!config) {
      return jsonResponse(503, { error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google Workspace is not configured on the server.' } });
    }
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    if (!state || !/^[0-9a-f]{64}$/.test(state)) return redirectCallback(config.appRedirectUrl, 'error');

    let stateRow: GoogleOAuthState | null;
    try {
      stateRow = await dependencies.consumeOAuthState(await sha256Hex(state));
    } catch {
      dependencies.logFailure?.('OAUTH_STATE_CONSUME_FAILED');
      return redirectCallback(config.appRedirectUrl, 'error');
    }
    if (!stateRow) return redirectCallback(config.appRedirectUrl, 'expired');

    let verifierSecretDeleted = false;
    try {
      if (Date.parse(stateRow.expires_at) <= now() || stateRow.redirect_uri !== config.oauth.redirectUri) {
        return redirectCallback(config.appRedirectUrl, 'expired');
      }
      const providerError = url.searchParams.get('error');
      if (providerError) return redirectCallback(config.appRedirectUrl, 'denied');
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) return redirectCallback(config.appRedirectUrl, 'error');

      const verifier = await dependencies.readSecret(stateRow.pkce_verifier_secret_id);
      try {
        await dependencies.deleteSecret(stateRow.pkce_verifier_secret_id);
        verifierSecretDeleted = true;
      } catch {
        dependencies.logFailure?.('OAUTH_VERIFIER_CLEANUP_FAILED');
      }
      if (!verifier) return redirectCallback(config.appRedirectUrl, 'error');

      if (stateRow.requested_scope_set !== 'drive' && stateRow.requested_scope_set !== 'gmail') {
        dependencies.logFailure?.('OAUTH_SCOPE_SET_INVALID');
        return redirectCallback(config.appRedirectUrl, 'error');
      }
      const token = await exchangeGoogleAuthorizationCode(config.oauth, code, verifier, fetcher, stateRow.requested_scope_set);
      const profile = await fetchGoogleUserProfile(token.accessToken, fetcher);
      if (!await dependencies.isCurrentMember(stateRow.workspace_id, stateRow.user_id)) {
        dependencies.logFailure?.('OAUTH_MEMBER_REVOKED');
        return redirectCallback(config.appRedirectUrl, 'error');
      }
      const prior = await dependencies.getConnection(stateRow.workspace_id, stateRow.user_id);
      let refreshSecretId: string;
      let createdNewSecret = false;
      if (token.refreshToken) {
        refreshSecretId = await dependencies.storeSecret(
          token.refreshToken,
          `google-refresh-${stateRow.workspace_id}-${stateRow.user_id}-${randomHex(8)}`,
          'Google Workspace OAuth refresh token; accessed only server-side for the scopes explicitly granted by the user.',
        );
        createdNewSecret = true;
      } else if (prior && prior.google_subject === profile.subject &&
        hasScopesForSet(prior.granted_scopes, stateRow.requested_scope_set)) {
        refreshSecretId = prior.refresh_secret_id;
      } else {
        dependencies.logFailure?.('GOOGLE_REFRESH_TOKEN_MISSING');
        return redirectCallback(config.appRedirectUrl, 'error');
      }

      try {
        await dependencies.saveConnection({
          workspace_id: stateRow.workspace_id,
          user_id: stateRow.user_id,
          google_subject: profile.subject,
          google_email: profile.email,
          granted_scopes: token.grantedScopes,
          refresh_secret_id: refreshSecretId,
          connected_at: new Date(now()).toISOString(),
        });
      } catch {
        if (createdNewSecret) {
          try { await dependencies.deleteSecret(refreshSecretId); } catch { dependencies.logFailure?.('GOOGLE_SECRET_CLEANUP_FAILED'); }
        }
        dependencies.logFailure?.('GOOGLE_CONNECTION_SAVE_FAILED');
        return redirectCallback(config.appRedirectUrl, 'error');
      }

      if (prior && prior.refresh_secret_id !== refreshSecretId) {
        try { await dependencies.deleteSecret(prior.refresh_secret_id); } catch { dependencies.logFailure?.('GOOGLE_OLD_SECRET_CLEANUP_FAILED'); }
      }
      return redirectCallback(config.appRedirectUrl, stateRow.requested_scope_set === 'gmail' ? 'gmail_connected' : 'connected');
    } catch (error) {
      dependencies.logFailure?.(error instanceof GoogleProviderError ? error.code : 'OAUTH_CALLBACK_FAILED');
      return redirectCallback(config.appRedirectUrl, 'error');
    } finally {
      if (!verifierSecretDeleted) {
        try { await dependencies.deleteSecret(stateRow.pkce_verifier_secret_id); } catch { dependencies.logFailure?.('OAUTH_VERIFIER_CLEANUP_FAILED'); }
      }
    }
  }
}

export class GoogleWorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function getConfiguration(environment: GoogleWorkspaceEnvironment): {
  readonly oauth: GoogleOAuthConfiguration;
  readonly appRedirectUrl: string;
} | null {
  const clientId = environment.FLOWWORK_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.FLOWWORK_GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = environment.FLOWWORK_GOOGLE_REDIRECT_URI?.trim();
  const appRedirectUrl = environment.FLOWWORK_GOOGLE_APP_REDIRECT_URL?.trim();
  if (!clientId || !clientSecret || !redirectUri || !appRedirectUrl) return null;
  const oauth: GoogleOAuthConfiguration = { clientId, clientSecret, redirectUri };
  if (!isSafeRedirect(redirectUri) || !isSafeRedirect(appRedirectUrl)) return null;
  return { oauth, appRedirectUrl };
}

function isSafeRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (localhost && url.protocol === 'http:'));
  } catch {
    return false;
  }
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new GoogleWorkspaceRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new GoogleWorkspaceRequestError(400, 'INVALID_REQUEST', 'Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new GoogleWorkspaceRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GoogleWorkspaceRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }
  if (!isRecord(value)) throw new GoogleWorkspaceRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  return value;
}

function createCorsHeaders(origin: string): HeadersInit {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'Origin',
  };
}

function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

function jsonResponse(status: number, value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function redirectCallback(appRedirectUrl: string, result: 'connected' | 'gmail_connected' | 'denied' | 'expired' | 'error'): Response {
  const url = new URL(appRedirectUrl);
  url.searchParams.set('google_connection', result);
  return new Response(null, {
    status: 303,
    headers: {
      location: url.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return bytesToBase64Url(digest);
}

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomBase64Url(byteCount: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
