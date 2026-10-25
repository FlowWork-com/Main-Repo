function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

import {
  createAdvancePlanRunHandler,
  parseAllowedOrigins,
} from './handler.ts';

const runId = '54000000-0000-4000-8000-000000000001';
const userId = '41000000-0000-4000-8000-000000000001';

function createHarness(authorized = true) {
  const scheduled: (() => Promise<void>)[] = [];
  const dispatched: string[] = [];
  const processed: string[] = [];
  const handler = createAdvancePlanRunHandler({
    origins: parseAllowedOrigins('https://app.example.test'),
    workerSecret: 'internal-worker-secret',
    authenticate: async (token: string) => token === 'valid-user-token'
      ? { userId, context: { token } }
      : null,
    authorizeRun: async (actorId: string, requestedRunId: string) =>
      authorized && actorId === userId && requestedRunId === runId,
    scheduleBackground: (task: () => Promise<void>) => { scheduled.push(task); },
    dispatchWorker: async (requestedRunId: string) => { dispatched.push(requestedRunId); },
    processRun: async (requestedRunId: string) => { processed.push(requestedRunId); },
  });
  return { handler, scheduled, dispatched, processed };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://functions.example.test/advance-plan-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test('requires a well-formed run ID', async () => {
  const { handler } = createHarness();
  const response = await handler(post({ planRunId: 'not-a-uuid' }, {
    authorization: 'Bearer valid-user-token',
  }));
  assertEquals(response.status, 400);
});

Deno.test('authenticated workspace member queues background dispatch without waiting for worker', async () => {
  const { handler, scheduled, dispatched } = createHarness();
  const response = await handler(post({ planRunId: runId }, {
    authorization: 'Bearer valid-user-token',
  }));
  assertEquals(response.status, 202);
  assertEquals(scheduled.length, 1);
  assertEquals(dispatched.length, 0);
  await scheduled[0]();
  assertEquals(dispatched, [runId]);
});

Deno.test('denies a caller without run membership', async () => {
  const { handler, scheduled } = createHarness(false);
  const response = await handler(post({ planRunId: runId }, {
    authorization: 'Bearer valid-user-token',
  }));
  assertEquals(response.status, 403);
  assertEquals(scheduled.length, 0);
});

Deno.test('internal dispatch requires the server-only worker credential', async () => {
  const { handler, scheduled, processed } = createHarness();
  const denied = await handler(post({ planRunId: runId }, {
    'x-flowwork-worker-key': 'wrong-secret',
  }));
  assertEquals(denied.status, 401);
  assertEquals(scheduled.length, 0);

  const accepted = await handler(post({ planRunId: runId }, {
    'x-flowwork-worker-key': 'internal-worker-secret',
  }));
  assertEquals(accepted.status, 202);
  assertEquals(scheduled.length, 1);
  await scheduled[0]();
  assertEquals(processed, [runId]);
});

Deno.test('rejects disallowed origins', async () => {
  const { handler } = createHarness();
  const response = await handler(post({ planRunId: runId }, {
    origin: 'https://attacker.example',
    authorization: 'Bearer valid-user-token',
  }));
  assertEquals(response.status, 403);
});
