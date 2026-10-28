import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { withRequestObservability } from './observability.ts';

function assertRequestId(value: string | null): asserts value is string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Expected a server-generated UUID request ID.');
  }
}

Deno.test('observability adds an exposed request ID and preserves the response body', async () => {
  const handler = withRequestObservability('test-function', () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-expose-headers': 'x-existing-header',
      },
    }));

  const response = await handler(new Request('https://edge.example.test/test', { method: 'POST' }));
  assertRequestId(response.headers.get('x-request-id'));
  const exposed = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
  assertEquals(exposed.includes('x-existing-header'), true);
  assertEquals(exposed.includes('x-request-id'), true);
  assertEquals(await response.json(), { ok: true });
});

Deno.test('structured error logs include only a bounded code and no response payload', async () => {
  const logLines: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };

  try {
    const handler = withRequestObservability('plan-workflow', () =>
      new Response(JSON.stringify({
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'customer-content MUST_NOT_BE_LOGGED',
          providerPayload: 'api_key=DO_NOT_LOG_THIS',
        },
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await handler(new Request('https://edge.example.test/plan-workflow', { method: 'POST' }));
    assertEquals(response.status, 502);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  assertEquals(logLines.length, 1);
  const record = JSON.parse(logLines[0]);
  assertEquals(record.event, 'edge_request_finished');
  assertEquals(record.function_name, 'plan-workflow');
  assertEquals(record.status, 502);
  assertEquals(record.outcome, 'server_error');
  assertEquals(record.error_code, 'PROVIDER_UNAVAILABLE');
  assertRequestId(record.request_id);
  assertEquals(typeof record.duration_ms, 'number');
  assertEquals(logLines[0].includes('MUST_NOT_BE_LOGGED'), false);
  assertEquals(logLines[0].includes('DO_NOT_LOG_THIS'), false);
  assertEquals(logLines[0].includes('providerPayload'), false);
});

Deno.test('unhandled exceptions produce a fixed error classification without logging exception text', async () => {
  const logLines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };

  try {
    const handler = withRequestObservability('execute-tool', () => {
      throw new Error('provider said api_key=DO_NOT_LOG_THIS');
    });

    const response = await handler(new Request('https://edge.example.test/execute-tool', { method: 'POST' }));
    assertEquals(response.status, 500);
    assertRequestId(response.headers.get('x-request-id'));
    assertEquals(
      await response.json(),
      { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } },
    );
  } finally {
    console.error = originalError;
  }

  assertEquals(logLines.length, 1);
  const record = JSON.parse(logLines[0]);
  assertEquals(record.outcome, 'unhandled_error');
  assertEquals(record.error_code, 'UNHANDLED_EXCEPTION');
  assertEquals(record.status, 500);
  assertEquals(logLines[0].includes('DO_NOT_LOG_THIS'), false);
});

Deno.test('OPTIONS preflight responses are not emitted as operational events', async () => {
  const logLines: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };

  try {
    const handler = withRequestObservability('test-function', () =>
      new Response(null, { status: 204 }));
    const response = await handler(new Request('https://edge.example.test/test', { method: 'OPTIONS' }));
    assertEquals(response.status, 204);
    assertRequestId(response.headers.get('x-request-id'));
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  assertEquals(logLines.length, 0);
});
