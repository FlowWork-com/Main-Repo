import {
  applyWorkflowCommand,
  createWorkflow,
  type WorkflowAggregate,
} from '../../../src/workflow/workflow.ts';
import { ToolExecutionService } from '../../../src/backend/toolExecutionService.ts';
import type {
  StoredToolExecution,
  ToolExecutionRepository,
} from '../../../src/backend/toolExecutionRepository.ts';
import type { WorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '../../../src/tools/contracts.ts';
import { createMvpTools } from '../../../src/tools/mvpTools.ts';
import { ToolExecutor } from '../../../src/tools/toolExecutor.ts';
import { ToolRegistry } from '../../../src/tools/toolRegistry.ts';
import {
  createExecuteToolHandler,
  parseAllowedOrigins,
  type AuthenticatedCaller,
} from './handler.ts';
import { createVerifiedAuthenticator } from './auth.ts';

const ownerId = '41000000-0000-4000-8000-000000000001';
const reviewerId = '41000000-0000-4000-8000-000000000002';
const outsiderId = '41000000-0000-4000-8000-000000000003';
const workspaceId = '42000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '42000000-0000-4000-8000-000000000002';
const taskId = '43000000-0000-4000-8000-000000000001';
const executionId = '44000000-0000-4000-8000-000000000001';

interface TestContext {
  readonly tasks: Map<string, WorkflowAggregate>;
  readonly members: Set<string>;
  readonly repository: MemoryExecutionRepository;
  readonly handler: (request: Request) => Promise<Response>;
  readonly executeCount: () => number;
}

class MemoryExecutionRepository implements ToolExecutionRepository {
  readonly records: StoredToolExecution[] = [];
  readonly approved = new Set<string>();
  authorize = async (context: ToolExecutionContext): Promise<boolean> =>
    this.members.has(`${context.workspaceId}:${context.userId}`) &&
    this.tasks.has(`${context.workspaceId}:${context.taskId}`);
  constructor(
    private readonly members: Set<string>,
    private readonly tasks: Set<string>,
  ) {}
  hasApprovedRequest = async (
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<boolean> =>
    this.approved.has(`${context.taskId}:${requestId}`);
  findExecution = async (
    context: ToolExecutionContext,
  ): Promise<StoredToolExecution | null> =>
    this.records.find((record) =>
      record.executionId === context.executionId ||
      record.requestId === context.requestId
    ) ?? null;
  claimExecution = async (
    context: ToolExecutionContext,
    input: unknown,
  ): Promise<boolean> => {
    if (await this.findExecution(context)) return false;
    this.records.push({
      requestedBy: context.userId,
      executionId: context.executionId,
      requestId: context.requestId,
      toolId: context.toolId,
      toolVersion: context.toolVersion,
      input,
      status: 'running',
      result: null,
    });
    return true;
  };
  completeExecution = async (
    context: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<void> => {
    const index = this.records.findIndex((record) =>
      record.executionId === context.executionId
    );
    if (index < 0) throw new Error('Execution was not claimed.');
    this.records[index] = {
      ...this.records[index],
      status: result.success ? 'succeeded' : 'failed',
      result,
    };
  };
  getTaskFileMetadata = async () => null;
}

class TestWorkflowRepository implements WorkflowRepository {
  persistCount = 0;
  listWorkspaces = async () => [];
  createWorkspace = async () => ({
    id: workspaceId,
    name: 'Test',
    memberUserIds: [ownerId],
  });
  getTask = async () => null;
  listTasks = async () => [];
  createTask = async () => {
    throw new Error('Not implemented in this test.');
  };
  persistEvents = async () => {
    this.persistCount += 1;
  };
}

function makeWorkflow(
  status: 'Planning' | 'Running' | 'Verifying' = 'Planning',
): WorkflowAggregate {
  const created = createWorkflow({
    task: { id: taskId, tenantId: workspaceId, ownerId },
    actorId: ownerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'create-task',
    occurredAt: '2026-10-09T10:00:00.000Z',
  });
  if (status === 'Planning') return created;
  const started = applyWorkflowCommand(created, {
    taskId,
    tenantId: workspaceId,
    ownerId,
    actorId: ownerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'start-task',
    expectedSequence: created.events.length,
    occurredAt: '2026-10-09T10:01:00.000Z',
    type: 'start',
  });
  if (status === 'Running') return started;
  return applyWorkflowCommand(started, {
    taskId,
    tenantId: workspaceId,
    ownerId,
    actorId: ownerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'begin-verification',
    expectedSequence: started.events.length,
    occurredAt: '2026-10-09T10:02:00.000Z',
    type: 'begin-verification',
  });
}

function gatedWorkflow(): WorkflowAggregate {
  const running = makeWorkflow('Running');
  const waiting = applyWorkflowCommand(running, {
    taskId,
    tenantId: workspaceId,
    ownerId,
    actorId: ownerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'request-approval',
    expectedSequence: running.events.length,
    occurredAt: '2026-10-09T10:02:00.000Z',
    type: 'request-approval',
    requestId: 'approval-1',
  });
  return applyWorkflowCommand(waiting, {
    taskId,
    tenantId: workspaceId,
    ownerId,
    actorId: reviewerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'approve-request',
    expectedSequence: waiting.events.length,
    occurredAt: '2026-10-09T10:03:00.000Z',
    type: 'resolve-approval',
    result: {
      requestId: 'approval-1',
      decision: 'approved',
      approverId: reviewerId,
      decidedAt: '2026-10-09T10:03:00.000Z',
    },
  });
}

function setup(options: {
  readonly status?: 'Planning' | 'Running' | 'Verifying';
  readonly timeoutMs?: number;
} = {}): TestContext {
  const tasks = new Map<string, WorkflowAggregate>([
    [taskId, makeWorkflow(options.status)],
  ]);
  const members = new Set([`${workspaceId}:${ownerId}`]);
  const repository = new MemoryExecutionRepository(
    members,
    new Set([`${workspaceId}:${taskId}`]),
  );
  const workflowRepository = new TestWorkflowRepository();
  const registry = new ToolRegistry();
  for (const tool of createMvpTools(repository)) registry.register(tool);
  let toolCalls = 0;
  const failureTool = customTool('fail-on-purpose', async () => {
    toolCalls += 1;
    return {
      success: false,
      error: { code: 'EXECUTION_FAILED', message: 'Internal detail', retryable: false },
    };
  });
  const timeoutTool = customTool('timeout-on-purpose', async (context) => {
    toolCalls += 1;
    return await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ success: true, output: { late: true } }),
        20,
      );
      context.signal.addEventListener('abort', () => clearTimeout(timer), {
        once: true,
      });
    });
  });
  const cancellableTool = customTool('cancel-on-purpose', async (context) => {
    toolCalls += 1;
    return await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ success: true, output: { late: true } }),
        1_000,
      );
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: {
            code: 'EXECUTION_TIMEOUT',
            message: 'Tool execution was cancelled.',
            retryable: true,
          },
        });
      }, { once: true });
    });
  });
  const gatedTool = {
    ...customTool('gated-tool', async () => {
      toolCalls += 1;
      return { success: true, output: { gated: true } };
    }),
    riskLevel: 'high',
    requiresApproval: true,
  } satisfies ToolDefinition;
  registry.register(failureTool);
  registry.register(timeoutTool);
  registry.register(cancellableTool);
  registry.register(gatedTool);

  const authenticate = async (token: string) => {
    if (token === 'valid-owner') {
      return { userId: ownerId, context: undefined };
    }
    if (token === 'valid-reviewer') {
      return { userId: reviewerId, context: undefined };
    }
    if (token === 'valid-outsider') {
      return { userId: outsiderId, context: undefined };
    }
    return null;
  };
  const handler = createExecuteToolHandler({
    origins: parseAllowedOrigins('http://localhost:5173'),
    authenticate,
    execute: async (caller: AuthenticatedCaller<undefined>, request) => {
      const aggregate = tasks.get(request.taskId);
      if (!aggregate) {
        throw new Error('Task not found.');
      }
      const trustedWorkspaceId = aggregate.task.tenantId;
      if (!members.has(`${trustedWorkspaceId}:${caller.userId}`)) {
        const result = await new ToolExecutionService(
          registry,
          new ToolExecutor(options.timeoutMs ?? 100),
          repository,
          workflowRepository,
        ).execute({
          ...request,
          userId: caller.userId,
          workspaceId: trustedWorkspaceId,
        }, aggregate);
        return result;
      }
      const service = new ToolExecutionService(
        registry,
        new ToolExecutor(options.timeoutMs ?? 100),
        repository,
        workflowRepository,
      );
      const outcome = await service.execute({
        ...request,
        userId: caller.userId,
        workspaceId: trustedWorkspaceId,
      }, aggregate);
      tasks.set(request.taskId, outcome.workflow);
      return outcome;
    },
  });
  return {
    tasks,
    members,
    repository,
    handler,
    executeCount: () => toolCalls,
  };
}

function customTool(
  id: string,
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    id,
    name: id,
    description: 'A deterministic test-only tool.',
    version: '1.0.0',
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: { type: 'object' },
    validateInput: (value) =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    execute,
  };
}

function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskId,
    executionId,
    requestId: 'request-1',
    toolId: 'echo',
    toolVersion: '1.0.0',
    input: { value: 'safe' },
    ...overrides,
  });
}

function post(
  handler: (request: Request) => Promise<Response>,
  body: string,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(new Request('http://localhost/functions/v1/execute-tool', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  }));
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function recordCount(context: TestContext): number {
  return context.repository.records.length;
}

Deno.test('Edge handler rejects missing and invalid authentication', async () => {
  const context = setup();
  const missing = await post(context.handler, requestBody());
  const invalid = await post(context.handler, requestBody(), 'expired-token');
  if (missing.status !== 401 || invalid.status !== 401) {
    throw new Error('Unauthenticated requests must be rejected.');
  }
  if (context.repository.records.length !== 0) {
    throw new Error('Unauthenticated requests must not claim executions.');
  }
});

Deno.test('verified authenticator derives the actor only from Supabase Auth', async () => {
  const verified = createVerifiedAuthenticator((token) => ({
    auth: {
      getUser: async (receivedToken: string) => ({
        data: {
          user: receivedToken === 'valid-token' ? { id: ownerId } : null,
        },
        error: null,
      }),
    },
    token,
  }));
  const caller = await verified('valid-token');
  const invalid = await verified('forged-token');
  if (caller?.userId !== ownerId || caller.context.token !== 'valid-token' || invalid !== null) {
    throw new Error('Caller identity must come from the verified Auth response.');
  }
});

Deno.test('authentication service errors are sanitized as temporary failures', async () => {
  const logged: string[] = [];
  const handler = createExecuteToolHandler({
    origins: parseAllowedOrigins('http://localhost:5173'),
    authenticate: async () => {
      throw new Error('private authentication response');
    },
    execute: async () => {
      throw new Error('Execution must not run.');
    },
    logFailure: (code) => logged.push(code),
  });
  const response = await post(handler, requestBody(), 'valid-owner');
  const body = await responseBody(response);
  const error = body.error as Record<string, unknown>;
  if (
    response.status !== 503 ||
    error.code !== 'AUTHENTICATION_UNAVAILABLE' ||
    error.message !== 'Authentication is temporarily unavailable.' ||
    logged.join(',') !== 'AUTHENTICATION_UNAVAILABLE'
  ) {
    throw new Error('Authentication service errors must not leak internal details.');
  }
});

Deno.test('Edge handler rejects forged identity and workspace fields', async () => {
  const context = setup();
  for (const body of [
    requestBody({ userId: outsiderId }),
    requestBody({ workspaceId: otherWorkspaceId }),
    requestBody({ approvalId: 'approval-1' }),
    requestBody({ result: { success: true } }),
  ]) {
    const response = await post(context.handler, body, 'valid-owner');
    if (response.status !== 400) {
      throw new Error('Client-controlled identity and result fields must be rejected.');
    }
  }
  if (context.repository.records.length !== 0) {
    throw new Error('Forged request fields must not claim executions.');
  }
});

Deno.test('Edge handler runs the canonical tool and returns the workflow state', async () => {
  const context = setup();
  const response = await post(context.handler, requestBody(), 'valid-owner');
  const body = await responseBody(response);
  const result = body.result as Record<string, unknown>;
  if (
    response.status !== 200 ||
    result.success !== true ||
    body.workflowStatus !== 'Verifying' ||
    recordCount(context) !== 1
  ) {
    throw new Error('A valid request must execute and enter Verifying.');
  }
});

Deno.test('Edge handler rejects nonmembers and cross-workspace tasks', async () => {
  const context = setup();
  const nonmember = await post(context.handler, requestBody(), 'valid-outsider');
  if (nonmember.status !== 200) {
    throw new Error('Authorization failures use structured tool results.');
  }
  const nonmemberBody = await responseBody(nonmember);
  if (
    (nonmemberBody.result as Record<string, unknown>).success !== false ||
    context.repository.records.length !== 0
  ) {
    throw new Error('Nonmembers must not claim or execute tools.');
  }

  const crossWorkspaceTaskId = '43000000-0000-4000-8000-000000000002';
  context.tasks.set(
    crossWorkspaceTaskId,
    createWorkflow({
      task: { id: crossWorkspaceTaskId, tenantId: otherWorkspaceId, ownerId },
      actorId: ownerId,
      actorTenantId: otherWorkspaceId,
      idempotencyKey: 'cross-workspace-task',
      occurredAt: '2026-10-09T10:00:00.000Z',
    }),
  );
  const crossWorkspace = await post(
    context.handler,
    requestBody({ taskId: crossWorkspaceTaskId }),
    'valid-owner',
  );
  const crossWorkspaceBody = await responseBody(crossWorkspace);
  if (
    (crossWorkspaceBody.result as Record<string, unknown>).success !== false ||
    context.repository.records.length !== 0
  ) {
    throw new Error('A workspace member cannot execute another workspace task.');
  }
});

Deno.test('Edge handler rejects task/workspace mismatch and invalid workflow status', async () => {
  const context = setup({ status: 'Verifying' });
  const extraWorkspace = await post(
    context.handler,
    requestBody({ workspaceId: otherWorkspaceId }),
    'valid-owner',
  );
  const invalidStatus = await post(context.handler, requestBody(), 'valid-owner');
  const invalidStatusBody = await responseBody(invalidStatus);
  if (
    extraWorkspace.status !== 400 ||
    (invalidStatusBody.result as Record<string, unknown>).success !== false ||
    context.repository.records.length !== 0
  ) {
    throw new Error('Mismatched workspace input and invalid workflow states must be rejected.');
  }
});

Deno.test('Edge handler rejects invalid inputs and unknown tool versions', async () => {
  const context = setup();
  const invalid = await post(
    context.handler,
    requestBody({
      toolId: 'text-transform',
      input: { operation: 'not-allowed', text: 'safe' },
    }),
    'valid-owner',
  );
  const unknown = await post(
    context.handler,
    requestBody({ toolId: 'echo', toolVersion: '99.0.0' }),
    'valid-owner',
  );
  const unknownTool = await post(
    context.handler,
    requestBody({ toolId: 'unregistered-tool' }),
    'valid-owner',
  );
  const invalidBody = await responseBody(invalid);
  const unknownBody = await responseBody(unknown);
  const unknownToolBody = await responseBody(unknownTool);
  if (
    (invalidBody.result as Record<string, unknown>).success !== false ||
    ((invalidBody.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'INVALID_TOOL_INPUT' ||
    ((unknownBody.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'TOOL_NOT_FOUND' ||
    ((unknownToolBody.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'TOOL_NOT_FOUND' ||
    context.repository.records.length !== 0
  ) {
    throw new Error('Invalid input and unknown tool versions must be rejected before claim.');
  }
});

Deno.test('Edge handler records structured failures and timeouts', async () => {
  const failedContext = setup();
  const failed = await post(
    failedContext.handler,
    requestBody({ toolId: 'fail-on-purpose', input: {} }),
    'valid-owner',
  );
  const failedBody = await responseBody(failed);
  const failedError = ((failedBody.result as Record<string, unknown>).error ??
    {}) as Record<string, unknown>;
  if (
    failedError.code !== 'EXECUTION_FAILED' ||
    failedError.message !== 'Tool execution failed.' ||
    failedContext.repository.records[0]?.status !== 'failed'
  ) {
    throw new Error('Execution errors must be sanitized and persisted.');
  }

  const timeoutContext = setup({ timeoutMs: 1 });
  const timeout = await post(
    timeoutContext.handler,
    requestBody({ toolId: 'timeout-on-purpose', input: {} }),
    'valid-owner',
  );
  const timeoutBody = await responseBody(timeout);
  if (
    ((timeoutBody.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'EXECUTION_TIMEOUT' ||
    timeoutContext.repository.records[0]?.status !== 'failed'
  ) {
    throw new Error('Timed-out tools must persist a structured failure.');
  }
});

Deno.test('Edge request cancellation aborts the running tool', async () => {
  const context = setup();
  const controller = new AbortController();
  const responsePromise = context.handler(new Request(
    'http://localhost/functions/v1/execute-tool',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-owner',
      },
      body: requestBody({ toolId: 'cancel-on-purpose', input: {} }),
      signal: controller.signal,
    },
  ));
  for (let attempt = 0; attempt < 20 && context.executeCount() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  controller.abort();
  const response = await responsePromise;
  const body = await responseBody(response);
  if (
    ((body.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'EXECUTION_TIMEOUT' ||
    context.repository.records[0]?.status !== 'failed' ||
    context.executeCount() !== 1
  ) {
    throw new Error('Aborted Edge requests must cancel and persist the tool failure.');
  }
});

Deno.test('Edge handler requires persisted approval for high-risk tools', async () => {
  const context = setup();
  context.tasks.set(taskId, gatedWorkflow());
  const approvalRequired = await post(
    context.handler,
    requestBody({ toolId: 'gated-tool', input: {} }),
    'valid-owner',
  );
  const approvalRequiredBody = await responseBody(approvalRequired);
  const approvalError = (
    (approvalRequiredBody.result as Record<string, unknown>).error ?? {}
  ) as Record<string, unknown>;
  if (approvalError.code !== 'APPROVAL_REQUIRED' || recordCount(context) !== 0) {
    throw new Error('A recorded workflow approval event alone is not sufficient.');
  }

  context.repository.approved.add(`${taskId}:approval-1`);
  const approved = await post(
    context.handler,
    requestBody({ toolId: 'gated-tool', input: {} }),
    'valid-owner',
  );
  const approvedBody = await responseBody(approved);
  if (
    (approvedBody.result as Record<string, unknown>).success !== true ||
    recordCount(context) !== 1
  ) {
    throw new Error('Only persisted approval allows the high-risk tool to execute.');
  }
});

Deno.test('Edge handler safely replays completed executions and rejects conflicting IDs', async () => {
  const context = setup();
  const first = await post(context.handler, requestBody(), 'valid-owner');
  const replay = await post(context.handler, requestBody(), 'valid-owner');
  const conflict = await post(
    context.handler,
    requestBody({ input: { value: 'different' } }),
    'valid-owner',
  );
  const replayBody = await responseBody(replay);
  const conflictBody = await responseBody(conflict);
  if (
    first.status !== 200 ||
    (replayBody.result as Record<string, unknown>).success !== true ||
    ((conflictBody.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'IDEMPOTENCY_CONFLICT' ||
    context.repository.records.length !== 1
  ) {
    throw new Error('Replays must not execute twice or replace a conflicting result.');
  }
});

Deno.test('Edge handler returns an in-progress result without executing again', async () => {
  const context = setup();
  context.repository.records.push({
    requestedBy: ownerId,
    executionId,
    requestId: 'request-1',
    toolId: 'echo',
    toolVersion: '1.0.0',
    input: { value: 'safe' },
    status: 'running',
    result: null,
  });
  const response = await post(context.handler, requestBody(), 'valid-owner');
  const body = await responseBody(response);
  if (
    ((body.result as Record<string, unknown>).error as Record<string, unknown>).code !==
      'EXECUTION_IN_PROGRESS' ||
    context.executeCount() !== 0
  ) {
    throw new Error('An in-progress execution must not invoke its tool again.');
  }
});

Deno.test('Edge handler enforces POST, body limits, and configured CORS origins', async () => {
  const context = setup();
  const get = await context.handler(new Request(
    'http://localhost/functions/v1/execute-tool',
    { method: 'GET' },
  ));
  const origin = await post(context.handler, requestBody(), 'valid-owner', {
    origin: 'https://untrusted.example',
  });
  const oversized = await post(
    context.handler,
    JSON.stringify({ ...JSON.parse(requestBody()), input: 'x'.repeat(70_000) }),
    'valid-owner',
  );
  if (get.status !== 405 || origin.status !== 403 || oversized.status !== 413) {
    throw new Error('Method, origin, and body-size restrictions must be enforced.');
  }
});
