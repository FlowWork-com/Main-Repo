import type { AuthenticatedCaller } from '../execute-tool/handler.ts';

const maxRequestBytes = 8_192;
const allowedOrigins = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

export interface AdvancePlanRunDependencies<Context> {
  readonly origins: ReadonlySet<string>;
  readonly workerSecret: string;
  readonly authenticate: (accessToken: string) => Promise<AuthenticatedCaller<Context> | null>;
  readonly authorizeRun: (userId: string, runId: string) => Promise<boolean>;
  readonly scheduleBackground: (task: () => Promise<void>) => void;
  readonly dispatchWorker: (runId: string) => Promise<void>;
  readonly processRun: (runId: string) => Promise<void>;
  readonly logFailure?: (code: string) => void;
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  return allowedOrigins(value);
}

export function createAdvancePlanRunHandler<Context>(
  dependencies: AdvancePlanRunDependencies<Context>,
): (request: Request) => Promise<Response> {
  return async (request) => {
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

    let payload: { planRunId: string };
    try {
      payload = await readPayload(request);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body is invalid.', corsHeaders);
    }

    const internalKey = request.headers.get('x-flowwork-worker-key');
    if (internalKey !== null) {
      if (!constantTimeEqual(internalKey, dependencies.workerSecret)) {
        return errorResponse(401, 'INVALID_WORKER_AUTH', 'Worker authentication is invalid.', corsHeaders);
      }
      dependencies.scheduleBackground(async () => {
        try {
          await dependencies.processRun(payload.planRunId);
        } catch {
          dependencies.logFailure?.('PLAN_WORKER_FAILED');
        }
      });
      return jsonResponse(202, { accepted: true }, corsHeaders);
    }

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', 'A valid sign-in is required.', corsHeaders);
    }
    let caller: AuthenticatedCaller<Context> | null;
    try {
      caller = await dependencies.authenticate(match[1]);
    } catch {
      dependencies.logFailure?.('AUTHENTICATION_UNAVAILABLE');
      return errorResponse(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication is temporarily unavailable.', corsHeaders);
    }
    if (!caller || !isUuid(caller.userId)) {
      return errorResponse(401, 'INVALID_AUTHENTICATION', 'A valid sign-in is required.', corsHeaders);
    }

    let authorized: boolean;
    try {
      authorized = await dependencies.authorizeRun(caller.userId, payload.planRunId);
    } catch {
      dependencies.logFailure?.('PLAN_RUN_AUTHORIZATION_UNAVAILABLE');
      return errorResponse(503, 'PLAN_RUN_UNAVAILABLE', 'Plan run status is temporarily unavailable.', corsHeaders);
    }
    if (!authorized) {
      return errorResponse(403, 'PERMISSION_DENIED', 'Workspace access is required for this plan run.', corsHeaders);
    }

    dependencies.scheduleBackground(async () => {
      try {
        await dependencies.dispatchWorker(payload.planRunId);
      } catch {
        dependencies.logFailure?.('PLAN_WORKER_DISPATCH_FAILED');
      }
    });
    return jsonResponse(202, { accepted: true }, corsHeaders);
  };
}

async function readPayload(request: Request): Promise<{ planRunId: string }> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxRequestBytes) throw new Error('too large');
  if (!request.body) throw new Error('missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxRequestBytes) {
      await reader.cancel();
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 ||
    typeof parsed.planRunId !== 'string' || !isUuid(parsed.planRunId)) {
    throw new Error('invalid payload');
  }
  return { planRunId: parsed.planRunId };
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string>): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function createCorsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-flowwork-worker-key',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
