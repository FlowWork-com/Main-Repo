export interface FinnlpAuthenticatedCaller<Context> {
  readonly userId: string;
  readonly context: Context;
}

export interface FinnlpIntegrationDependencies<Context> {
  readonly origins: ReadonlySet<string>;
  readonly authenticate: (accessToken: string) => Promise<FinnlpAuthenticatedCaller<Context> | null>;
  readonly isWorkspaceMember: (
    caller: FinnlpAuthenticatedCaller<Context>,
    workspaceId: string,
  ) => Promise<boolean>;
  readonly getConnection: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ readonly connected_at: string } | null>;
  readonly connect: (
    workspaceId: string,
    userId: string,
    apiKey: string,
  ) => Promise<{ readonly connected_at: string }>;
  readonly disconnect: (workspaceId: string, userId: string) => Promise<void>;
  readonly validateApiKey: (apiKey: string) => Promise<
    'valid' | 'unauthorized' | 'rate_limited' | 'unavailable'
  >;
  readonly logFailure?: (code: string) => void;
}

const MAX_REQUEST_BYTES = 16_384;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createFinnlpIntegrationHandler<Context>(
  dependencies: FinnlpIntegrationDependencies<Context>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    if (origin && !dependencies.origins.has(origin)) {
      return jsonResponse(403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' } });
    }
    const corsHeaders = origin ? createCorsHeaders(origin) : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported.', corsHeaders);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await readPayload(request);
    } catch (error) {
      const failure = error instanceof FinnlpRequestError
        ? error
        : new FinnlpRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
      return errorResponse(failure.status, failure.code, failure.message, corsHeaders);
    }

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', 'A valid sign-in is required.', corsHeaders);
    }

    let caller: FinnlpAuthenticatedCaller<Context> | null;
    try {
      caller = await dependencies.authenticate(match[1]);
    } catch {
      dependencies.logFailure?.('AUTHENTICATION_UNAVAILABLE');
      return errorResponse(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication is temporarily unavailable.', corsHeaders);
    }
    if (!caller || !UUID_PATTERN.test(caller.userId)) {
      return errorResponse(401, 'INVALID_AUTHENTICATION', 'A valid sign-in is required.', corsHeaders);
    }

    const action = payload.action;
    const workspaceId = payload.workspaceId;
    if (typeof action !== 'string' || !['status', 'connect', 'disconnect'].includes(action) ||
      typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'Request fields are invalid.', corsHeaders);
    }

    const allowedKeys = action === 'connect'
      ? new Set(['action', 'workspaceId', 'apiKey'])
      : new Set(['action', 'workspaceId']);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
      return errorResponse(400, 'INVALID_REQUEST', 'Request fields are invalid.', corsHeaders);
    }
    if (action === 'connect' && (
      typeof payload.apiKey !== 'string' ||
      payload.apiKey.trim().length < 16 ||
      payload.apiKey.trim().length > 512 ||
      hasControlCharacters(payload.apiKey)
    )) {
      return errorResponse(400, 'INVALID_PROVIDER_CREDENTIAL', 'A valid Finnhub API key is required.', corsHeaders);
    }

    try {
      if (!await dependencies.isWorkspaceMember(caller, workspaceId)) {
        return errorResponse(403, 'PERMISSION_DENIED', 'Workspace access is required.', corsHeaders);
      }
    } catch {
      dependencies.logFailure?.('WORKSPACE_MEMBERSHIP_CHECK_FAILED');
      return errorResponse(503, 'WORKSPACE_ACCESS_UNAVAILABLE', 'Workspace access could not be verified.', corsHeaders);
    }

    if (action === 'status') {
      try {
        const saved = await dependencies.getConnection(workspaceId, caller.userId);
        return jsonResponse(200, {
          connected: Boolean(saved),
          ...(saved ? { connectedAt: saved.connected_at } : {}),
        }, corsHeaders);
      } catch {
        dependencies.logFailure?.('CONNECTION_STATUS_UNAVAILABLE');
        return errorResponse(503, 'CONNECTION_STATUS_UNAVAILABLE', 'Connection status is temporarily unavailable.', corsHeaders);
      }
    }

    if (action === 'disconnect') {
      try {
        await dependencies.disconnect(workspaceId, caller.userId);
        return jsonResponse(200, { connected: false }, corsHeaders);
      } catch {
        dependencies.logFailure?.('DISCONNECT_FAILED');
        return errorResponse(503, 'DISCONNECT_FAILED', 'The integration could not be disconnected. Retry safely.', corsHeaders);
      }
    }

    let validation: 'valid' | 'unauthorized' | 'rate_limited' | 'unavailable';
    try {
      validation = await dependencies.validateApiKey(payload.apiKey as string);
    } catch {
      validation = 'unavailable';
    }
    if (validation === 'unauthorized') {
      return errorResponse(400, 'FINNHUB_CREDENTIAL_REJECTED', 'Finnhub did not accept that API key. Check the key and retry.', corsHeaders);
    }
    if (validation === 'rate_limited') {
      return errorResponse(429, 'FINNHUB_RATE_LIMITED', 'Finnhub rate-limited the connection check. Wait briefly and retry.', corsHeaders);
    }
    if (validation !== 'valid') {
      return errorResponse(503, 'FINNHUB_UNAVAILABLE', 'Finnhub could not validate the key right now. Retry later.', corsHeaders);
    }

    try {
      const saved = await dependencies.connect(workspaceId, caller.userId, (payload.apiKey as string).trim());
      return jsonResponse(200, { connected: true, connectedAt: saved.connected_at }, corsHeaders);
    } catch {
      dependencies.logFailure?.('CONNECTION_SAVE_FAILED');
      return errorResponse(503, 'CONNECTION_SAVE_FAILED', 'The API key could not be stored securely. Retry later.', corsHeaders);
    }
  };
}

export class FinnlpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
  ) {
    super(message);
  }
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new FinnlpRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  if (!request.body) throw new FinnlpRequestError(400, 'INVALID_REQUEST', 'Request body is required.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new FinnlpRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new FinnlpRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }
  if (!isRecord(parsed)) throw new FinnlpRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  return parsed;
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

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

function jsonResponse(
  status: number,
  value: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
