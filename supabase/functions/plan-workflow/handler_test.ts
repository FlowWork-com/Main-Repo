import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createPlanWorkflowHandler } from './handler.ts';
import type { PlannerRequest, PlannerResponse, WorkflowPlan } from '../../../src/planning/planning.ts';

const taskId = '43000000-0000-4000-8000-000000000001';
const userId = '41000000-0000-4000-8000-000000000001';

function createHandler(overrides: Record<string, unknown> = {}) {
  return createPlanWorkflowHandler({
    origins: new Set(['https://app.example.test']),
    authenticate: async (token: string) => token === 'valid-token'
      ? { userId, context: {} }
      : null,
    loadTask: async (_caller: unknown, id: string) => id === taskId
      ? { id, workspaceId: '42000000-0000-4000-8000-000000000001', ownerId: userId, title: 'Test task', details: '' }
      : null,
    persistPlan: async (_caller, _task, plan) => plan,
    ...overrides,
  });
}

function post(body: BodyInit, headers: HeadersInit = {}) {
  return new Request('https://edge.example.test/plan-workflow', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', ...headers },
    body,
  });
}

Deno.test('plan-workflow parses normal JSON request bodies', async () => {
  const handler = createHandler();
  const response = await handler(post(JSON.stringify({ taskId, goal: 'Summarize the task.' })));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error.code, 'PLANNER_NOT_CONFIGURED');
});

Deno.test('plan-workflow copies multiple streamed body chunks before parsing', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ taskId, goal: 'Summarize the task.' }));
  const request = new Request('https://edge.example.test/plan-workflow', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 13));
        controller.enqueue(encoded.slice(13, 27));
        controller.enqueue(encoded.slice(27));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  const response = await createHandler()(request);
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error.code, 'PLANNER_NOT_CONFIGURED');
});

Deno.test('plan-workflow rejects malformed and unknown request fields', async () => {
  const handler = createHandler();
  const malformed = await handler(post('{'));
  assertEquals(malformed.status, 400);
  const unknownField = await handler(post(JSON.stringify({ taskId, goal: 'Goal', actorId: userId })));
  assertEquals(unknownField.status, 400);
  const invalidTask = await handler(post(JSON.stringify({ taskId: 'not-a-uuid', goal: 'Goal' })));
  assertEquals(invalidTask.status, 400);
});

Deno.test('plan-workflow enforces streamed body limits without Content-Length', async () => {
  const request = new Request('https://edge.example.test/plan-workflow', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(30_000));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  const response = await createHandler()(request);
  assertEquals(response.status, 413);
});

Deno.test('plan-workflow enforces streamed limits despite an inaccurate Content-Length', async () => {
  const request = new Request('https://edge.example.test/plan-workflow', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-length': '1' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(66_000));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  assertEquals((await createHandler()(request)).status, 413);
});

Deno.test('plan-workflow rejects missing, invalid, or expired authentication', async () => {
  const handler = createHandler();
  const body = JSON.stringify({ taskId, goal: 'Goal' });
  assertEquals((await handler(post(body, { authorization: '' }))).status, 401);
  assertEquals((await handler(post(body, { authorization: 'Bearer expired-token' }))).status, 401);
});

Deno.test('plan-workflow rejects forbidden origins and inaccessible tasks', async () => {
  const handler = createHandler();
  const body = JSON.stringify({ taskId, goal: 'Goal' });
  assertEquals((await handler(post(body, { origin: 'https://evil.example.test' }))).status, 403);
  const mismatch = await createHandler({ loadTask: async () => null })(post(body));
  assertEquals(mismatch.status, 403);
  const membershipFailure = await createHandler({ loadTask: async () => { throw new Error('database failure'); } })(post(body));
  assertEquals(membershipFailure.status, 403);
});

Deno.test('plan-workflow only supports POST and OPTIONS', async () => {
  const response = await createHandler()(new Request('https://edge.example.test/plan-workflow', {
    method: 'GET',
  }));
  assertEquals(response.status, 405);
});

Deno.test('plan-workflow persists an explicitly enabled development mock only in tests', async () => {
  let persisted = false;
  const handler = createPlanWorkflowHandler({
    origins: new Set(),
    plannerEnvironment: {
      FLOWWORK_PLANNER_PROVIDER: 'mock',
      FLOWWORK_PLANNER_ALLOW_MOCK: 'true',
    },
    authenticate: async () => ({ userId, context: {} }),
    loadTask: async () => ({
      id: taskId,
      workspaceId: '42000000-0000-4000-8000-000000000001',
      ownerId: userId,
      title: 'Task',
      details: '',
    }),
    persistPlan: async (_caller, _task, plan) => {
      persisted = true;
      return plan;
    },
  });
  const response = await handler(post(JSON.stringify({ taskId, goal: 'Summarize this task.' })));
  assertEquals(response.status, 200);
  assertEquals(persisted, true);
});


Deno.test('financial plans get one FinNLP handoff and one main-planner refinement without claiming factual verification', async () => {
  const requests: PlannerRequest[] = [];
  let reviewerCalls = 0;
  let persistedPlan: WorkflowPlan | null = null;

  const makePlan = (request: PlannerRequest): WorkflowPlan => ({
    id: '66000000-0000-4000-8000-000000000001',
    taskId: request.taskId,
    goal: request.goal,
    summary: 'Review the supplied revenue statement with explicit limitations.',
    steps: [{
      id: 'step-one',
      title: 'Summarize financial request',
      description: 'Summarize the request without inventing accounting data.',
      toolId: 'echo',
      toolVersion: '1.0.0',
      input: { label: request.goal },
      dependencies: [],
      expectedOutcome: 'The request is represented as structured data.',
      verificationCriteria: 'The output preserves the supplied request.',
      validation: { valid: true, blockingReasons: [] },
    }],
    dependencies: [],
    createdAt: '2026-10-26T00:00:00.000Z',
    version: 1,
    validationStatus: 'valid',
    limitations: [],
  });

  const adapter = {
    providerName: 'test-main-planner',
    async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
      requests.push(request);
      return { success: true, plan: makePlan(request) };
    },
  };

  const reviewer = {
    async reviewFinancialClaim(_context: { signal: AbortSignal }, input: { claim: string; draftAnswer?: string; sources: readonly unknown[] }) {
      reviewerCalls += 1;
      assertEquals(input.sources.length, 0);
      assertEquals(input.claim, 'Explain whether revenue grew 8% year over year.');
      return {
        reviewStatus: 'supported_by_sources',
        decodedMeaning: 'Year over year compares the period with the same period in the previous year.',
        assessmentSummary: 'No independent financial evidence was supplied, so the numeric claim cannot be source-verified.',
        findings: [{
          statement: 'Revenue grew by 8%.',
          assessment: 'supports_claim',
          explanation: 'The draft repeats the claim but no independent source was supplied.',
          sourceIds: [],
        }],
        ambiguities: [{
          term: 'revenue grew',
          interpretations: ['Reported nominal revenue', 'Inflation- or currency-adjusted revenue'],
          clarificationQuestion: 'Which reporting basis and comparable periods apply?',
        }],
        questionsForMainAgent: ['Request the filing or source that supports the 8% figure.'],
        nextStepForMainAgent: 'Do not state that the 8% figure is verified until primary evidence is checked. ' + 'Additional primary-source review remains required. '.repeat(16),
        confidence: 'moderate',
      };
    },
  };

  const handler = createPlanWorkflowHandler({
    origins: new Set(),
    plannerEnvironment: {},
    createPlannerAdapter: () => adapter,
    financialReviewer: reviewer,
    authenticate: async () => ({ userId, context: {} }),
    loadTask: async () => ({
      id: taskId,
      workspaceId: '42000000-0000-4000-8000-000000000001',
      ownerId: userId,
      title: 'Revenue review',
      details: '',
    }),
    persistPlan: async (_caller, _task, plan) => {
      persistedPlan = plan;
      return plan;
    },
  });

  const response = await handler(post(JSON.stringify({
    taskId,
    goal: 'Explain whether revenue grew 8% year over year.',
  })));
  assertEquals(response.status, 200);
  assertEquals(requests.length, 2);
  assertEquals(reviewerCalls, 1);
  assertEquals(typeof requests[1].reviewerFeedback, 'string');
  assertEquals(requests[1].reviewerFeedback?.includes('No independent financial evidence'), true);

  const body = await response.json();
  const plan = body.plan as WorkflowPlan;
  assertEquals(persistedPlan !== null, true);
  assertEquals(plan.limitations.some((item) => item.includes('FinNLP review status: insufficient_evidence')), true);
  assertEquals(
    plan.limitations.some((item) =>
      item === 'No independent source snippets were supplied during planning review, so this is not factual verification.'),
    true,
  );
  assertEquals(
    plan.limitations.some((item) => item.startsWith('FinNLP next step: Do not state that the 8% figure is verified')),
    true,
  );
});

Deno.test('financial planning explicitly records when the FinNLP sidecar is not configured', async () => {
  const handler = createPlanWorkflowHandler({
    origins: new Set(),
    plannerEnvironment: {
      FLOWWORK_PLANNER_PROVIDER: 'mock',
      FLOWWORK_PLANNER_ALLOW_MOCK: 'true',
    },
    authenticate: async () => ({ userId, context: {} }),
    loadTask: async () => ({
      id: taskId,
      workspaceId: '42000000-0000-4000-8000-000000000001',
      ownerId: userId,
      title: 'Revenue review',
      details: '',
    }),
    persistPlan: async (_caller, _task, plan) => plan,
  });
  const response = await handler(post(JSON.stringify({
    taskId,
    goal: 'Explain revenue growth.',
  })));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(
    body.plan.limitations.some((item: string) => item.includes('FinNLP sidecar is not configured')),
    true,
  );
});
