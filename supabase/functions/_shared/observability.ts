const MAX_ERROR_BODY_BYTES = 4_096;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

type EdgeHandler = (request: Request) => Response | Promise<Response>;

type RequestOutcome = 'success' | 'client_error' | 'server_error' | 'unhandled_error';

/**
 * Adds a server-generated request ID and a bounded, redacted completion event
 * to an Edge Function. Never logs request/response payloads, URL query values,
 * authorization headers, workspace IDs, or exception messages.
 */
export function withRequestObservability(
  functionName: string,
  handler: EdgeHandler,
): EdgeHandler {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    let responseStatus = 500;
    let outcome: RequestOutcome = 'unhandled_error';
    let errorCode: string | undefined;

    try {
      const response = await handler(request);
      responseStatus = response.status;
      outcome = classifyOutcome(response.status);

      if (response.status >= 400) {
        try {
          errorCode = await readSafeErrorCode(response);
        } catch {
          // Logging must not interfere with the original response.
        }
      }

      const headers = new Headers(response.headers);
      headers.set('x-request-id', requestId);
      headers.set(
        'access-control-expose-headers',
        appendExposedHeader(headers.get('access-control-expose-headers'), 'x-request-id'),
      );

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      // Log only a fixed classification; never emit the exception or provider body.
      responseStatus = 500;
      outcome = 'unhandled_error';
      errorCode = 'UNHANDLED_EXCEPTION';
      throw new Error('Request handler failed.');
    } finally {
      // Preflight traffic is deliberately omitted to keep operational logs useful.
      if (request.method.toUpperCase() !== 'OPTIONS') {
        const event = {
          timestamp: new Date().toISOString(),
          event: 'edge_request_finished',
          function_name: functionName,
          request_id: requestId,
          method: request.method.toUpperCase(),
          status: responseStatus,
          outcome,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          ...(errorCode ? { error_code: errorCode } : {}),
        };

        const line = JSON.stringify(event);
        if (outcome === 'success') {
          console.info(line);
        } else {
          console.error(line);
        }
      }
    }
  };
}

function classifyOutcome(status: number): RequestOutcome {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

function appendExposedHeader(existing: string | null, headerName: string): string {
  const headers = (existing ?? '')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  if (!headers.some((header) => header.toLowerCase() === headerName.toLowerCase())) {
    headers.push(headerName);
  }
  return headers.join(', ');
}

async function readSafeErrorCode(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return undefined;
  }

  const body = response.clone().body;
  if (!body) return undefined;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let reachedEnd = false;

  try {
    while (byteCount < MAX_ERROR_BODY_BYTES) {
      const result = await reader.read();
      if (result.done) {
        reachedEnd = true;
        break;
      }

      const remaining = MAX_ERROR_BODY_BYTES - byteCount;
      const part = result.value.subarray(0, remaining);
      chunks.push(part);
      byteCount += part.byteLength;
      if (part.byteLength < result.value.byteLength) break;
    }
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // The source may already be closed.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  const code = parsed.error.code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
