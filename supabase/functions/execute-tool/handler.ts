import {
  isCredentialLikeString,
  isPersistableJson,
} from '../../../src/tools/contracts.ts';
import type { ToolExecutionOutcome } from '../../../src/backend/toolExecutionService.ts';

const maxRequestBytes = 65_536;
const allowedRequestKeys = new Set([
  'taskId',
  'executionId',
  'requestId',
  'toolId',
  'toolVersion',
  'input',
]);
const allowedOrigins = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

interface ExecuteToolPayload {
  readonly taskId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: unknown;
}

export interface AuthenticatedCaller<Context> {
  readonly userId: string;
  readonly context: Context;
}

export interface ExecuteToolHandlerDependencies<Context> {
  readonly origins: ReadonlySet<string>;
  readonly authenticate: (
    accessToken: string,
  ) => Promise<AuthenticatedCaller<Context> | null>;
  readonly execute: (
    caller: AuthenticatedCaller<Context>,
    request: ExecuteToolPayload,
    signal: AbortSignal,
  ) => Promise<ToolExecutionOutcome>;
  readonly logFailure?: (code: string) => void;
}

export class ToolRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  return allowedOrigins(value);
}

export function createExecuteToolHandler<Context>(
  dependencies: ExecuteToolHandlerDependencies<Context>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    if (origin && !dependencies.origins.has(origin)) {
      return jsonResponse(
        403,
        { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' } },
      );
    }
    const corsHeaders = origin ? createCorsHeaders(origin) : {};
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }
    if (request.method !== 'POST') {
      return errorResponse(
        405,
        'METHOD_NOT_ALLOWED',
        'Only POST requests are supported.',
        corsHeaders,
      );
    }

    let payload: ExecuteToolPayload;
    try {
      payload = await readPayload(request);
    } catch (error) {
      const failure = error instanceof ToolRequestError
        ? error
        : new ToolRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
      return errorResponse(
        failure.status,
        failure.code,
        failure.publicMessage,
        corsHeaders,
      );
    }

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return errorResponse(
        401,
        'AUTHENTICATION_REQUIRED',
        'A valid sign-in is required.',
        corsHeaders,
      );
    }

    let caller: AuthenticatedCaller<Context> | null;
    try {
      caller = await dependencies.authenticate(match[1]);
    } catch {
      dependencies.logFailure?.('AUTHENTICATION_UNAVAILABLE');
      return errorResponse(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'Authentication is temporarily unavailable.',
        corsHeaders,
      );
    }
    if (!caller || !isUuid(caller.userId)) {
      return errorResponse(
        401,
        'INVALID_AUTHENTICATION',
        'A valid sign-in is required.',
        corsHeaders,
      );
    }

    try {
      const outcome = await dependencies.execute(caller, payload, request.signal);
      return jsonResponse(
        200,
        {
          result: outcome.result,
          workflowStatus: outcome.workflow.task.status,
        },
        corsHeaders,
      );
    } catch (error) {
      if (error instanceof ToolRequestError) {
        return errorResponse(
          error.status,
          error.code,
          error.publicMessage,
          corsHeaders,
        );
      }
      dependencies.logFailure?.('EXECUTION_UNAVAILABLE');
      return errorResponse(
        503,
        'EXECUTION_UNAVAILABLE',
        'Tool execution is temporarily unavailable.',
        corsHeaders,
      );
    }
  };
}

async function readPayload(request: Request): Promise<ExecuteToolPayload> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxRequestBytes) {
    throw new ToolRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  if (!request.body) {
    throw new ToolRequestError(400, 'INVALID_REQUEST', 'Request body is required.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxRequestBytes) {
        await reader.cancel();
        throw new ToolRequestError(
          413,
          'REQUEST_TOO_LARGE',
          'Request body is too large.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let text: string;
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ToolRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedRequestKeys.has(key))) {
    throw new ToolRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  }
  const taskId = value.taskId;
  const executionId = value.executionId;
  const requestId = value.requestId;
  const toolId = value.toolId;
  const toolVersion = value.toolVersion;
  const input = value.input;
  if (
    !isUuid(taskId) ||
    !isUuid(executionId) ||
    typeof requestId !== 'string' ||
    !requestId.trim() ||
    requestId.length > 200 ||
    isCredentialLikeString(requestId) ||
    typeof toolId !== 'string' ||
    !toolId.trim() ||
    toolId.length > 100 ||
    typeof toolVersion !== 'string' ||
    !toolVersion.trim() ||
    toolVersion.length > 40 ||
    !('input' in value) ||
    !isPersistableJson(input)
  ) {
    throw new ToolRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  }
  return { taskId, executionId, requestId, toolId, toolVersion, input };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
