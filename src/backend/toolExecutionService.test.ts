import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkflowCommand,
  createWorkflow,
  type WorkflowAggregate,
  type WorkflowCommandContext,
} from '../workflow/workflow';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '../tools/contracts';
import { createMvpTools } from '../tools/mvpTools';
import { ToolExecutor } from '../tools/toolExecutor';
import { ToolRegistry } from '../tools/toolRegistry';
import { ToolExecutionService } from './toolExecutionService';
import type {
  StoredToolExecution,
  ToolExecutionRepository,
} from './toolExecutionRepository';
import type { WorkflowRepository } from './workflowRepository';

const identity = {
  id: 'task-1',
  tenantId: 'workspace-1',
  ownerId: 'user-1',
} as const;
const executionId = '44000000-0000-4000-8000-000000000001';

function workflow(): WorkflowAggregate {
  return createWorkflow({
    task: identity,
    actorId: identity.ownerId,
    actorTenantId: identity.tenantId,
    idempotencyKey: 'create-task',
    occurredAt: '2026-10-08T10:00:00.000Z',
  });
}

function commandContext(
  aggregate: WorkflowAggregate,
  actorId: string = identity.ownerId,
  idempotencyKey = 'start-task',
): WorkflowCommandContext {
  return {
    taskId: aggregate.task.id,
    tenantId: aggregate.task.tenantId,
    ownerId: aggregate.task.ownerId,
    actorId,
    actorTenantId: aggregate.task.tenantId,
    idempotencyKey,
    expectedSequence: aggregate.events.length,
    occurredAt: '2026-10-08T10:01:00.000Z',
  };
}

function request(
  overrides: Partial<{
    readonly userId: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly requestId: string;
    readonly toolId: string;
    readonly toolVersion: string;
    readonly input: unknown;
  }> = {},
) {
  return {
    userId: identity.ownerId,
    workspaceId: identity.tenantId,
    taskId: identity.id,
    executionId,
    requestId: 'request-1',
    toolId: 'echo',
    toolVersion: '1.0.0',
    input: { value: 'safe' },
    ...overrides,
  };
}

function workflowRepository(): WorkflowRepository & {
  persistEvents: ReturnType<typeof vi.fn>;
} {
  return {
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    persistEvents: vi.fn(async () => undefined),
  };
}

class MemoryExecutionRepository implements ToolExecutionRepository {
  record: StoredToolExecution | null = null;
  authorized = true;
  authorize = vi.fn(async () => this.authorized);
  hasApprovedRequest = vi.fn(async () => true);
  findExecution = vi.fn(async () => this.record);
  claimExecution = vi.fn(
    async (
      context: ToolExecutionContext,
      input: unknown,
    ): Promise<boolean> => {
      if (this.record) return false;
      this.record = {
        requestedBy: context.userId,
        executionId: context.executionId,
        requestId: context.requestId,
        toolId: context.toolId,
        toolVersion: context.toolVersion,
        input,
        status: 'running',
        result: null,
      };
      return true;
    },
  );
  completeExecution = vi.fn(
    async (
      _context: ToolExecutionContext,
      result: ToolExecutionResult,
    ): Promise<void> => {
      if (!this.record) throw new Error('Execution has not been claimed.');
      this.record = {
        ...this.record,
        status: result.success ? 'succeeded' : 'failed',
        result,
      };
    },
  );
  getTaskFileMetadata = vi.fn(async () => null);
}

function createRegistry(
  source: MemoryExecutionRepository,
  tool?: ToolDefinition,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of createMvpTools(source)) registry.register(definition);
  if (tool) registry.register(tool);
  return registry;
}

function createService(
  store: MemoryExecutionRepository,
  workflowStore: WorkflowRepository,
  registry = createRegistry(store),
  timeoutMs = 100,
): ToolExecutionService {
  return new ToolExecutionService(
    registry,
    new ToolExecutor(timeoutMs),
    store,
    workflowStore,
  );
}

describe('ToolExecutionService', () => {
  it('executes a registered tool, persists it, and transitions through workflow rules to verification', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const service = createService(executions, workflows);
    const outcome = await service.execute(request(), workflow());

    expect(outcome.result).toEqual({
      success: true,
      output: { value: { value: 'safe' } },
    });
    expect(outcome.workflow.task.status).toBe('Verifying');
    expect(outcome.workflow.events.map((event) =>
      event.type === 'status.changed' ? event.to : event.type,
    )).toEqual(['task.created', 'Running', 'Verifying']);
    expect(executions.claimExecution).toHaveBeenCalledOnce();
    expect(executions.completeExecution).toHaveBeenCalledOnce();
    expect(workflows.persistEvents).toHaveBeenCalledTimes(2);
  });

  it('replays completed idempotent executions without invoking the tool twice', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const service = createService(executions, workflows);
    const first = await service.execute(request(), workflow());
    const second = await service.execute(request(), first.workflow);
    const otherMemberReplay = await service.execute(
      request({ userId: 'user-2' }),
      first.workflow,
    );

    expect(second.result).toEqual(first.result);
    expect(second.workflow.task.status).toBe('Verifying');
    expect(otherMemberReplay.result).toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(executions.claimExecution).toHaveBeenCalledOnce();
    expect(executions.completeExecution).toHaveBeenCalledOnce();
  });

  it('records executor failures and moves the workflow to Failed', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const failingTool: ToolDefinition = {
      id: 'explode',
      name: 'Failing tool',
      description: 'Test a failure path.',
      version: '1.0.0',
      riskLevel: 'low',
      requiresApproval: false,
      inputSchema: {},
      validateInput: () => true,
      async execute() {
        throw new Error('secret details are not exposed');
      },
    };
    const registry = createRegistry(executions, failingTool);
    const service = createService(executions, workflows, registry);
    const outcome = await service.execute(
      request({ toolId: 'explode' }),
      workflow(),
    );

    expect(outcome.result).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_FAILED', message: 'Tool execution failed.' },
    });
    expect(outcome.workflow.task.status).toBe('Failed');
    expect(executions.record?.status).toBe('failed');
  });

  it('records timeout as a structured failure and moves the workflow to Failed', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const pendingTool: ToolDefinition = {
      id: 'slow',
      name: 'Slow tool',
      description: 'Test a timeout path.',
      version: '1.0.0',
      riskLevel: 'low',
      requiresApproval: false,
      inputSchema: {},
      validateInput: () => true,
      async execute() {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ success: true, output: 'late' }), 50);
        });
      },
    };
    const registry = createRegistry(executions, pendingTool);
    const service = createService(executions, workflows, registry, 2);
    const outcome = await service.execute(
      request({ toolId: 'slow' }),
      workflow(),
    );

    expect(outcome.result).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_TIMEOUT' },
    });
    expect(outcome.workflow.task.status).toBe('Failed');
  });

  it('rejects cross-workspace, cross-task, and unauthorized execution before tools run', async () => {
    const executions = new MemoryExecutionRepository();
    executions.authorized = false;
    const workflows = workflowRepository();
    const toolExecute = vi.fn(async () => ({
      success: true as const,
      output: 'ran',
    }));
    const guardedTool: ToolDefinition = {
      id: 'guarded',
      name: 'Guarded',
      description: 'Test the authorization boundary.',
      version: '1.0.0',
      riskLevel: 'low',
      requiresApproval: false,
      inputSchema: {},
      validateInput: () => true,
      execute: toolExecute,
    };
    const service = createService(
      executions,
      workflows,
      createRegistry(executions, guardedTool),
    );

    const crossWorkspace = await service.execute(
      request({ toolId: 'guarded', workspaceId: 'workspace-other' }),
      workflow(),
    );
    const crossTask = await service.execute(
      request({ toolId: 'guarded', taskId: 'task-other' }),
      workflow(),
    );
    const unauthorized = await service.execute(
      request({ toolId: 'guarded' }),
      workflow(),
    );

    expect(crossWorkspace.result).toMatchObject({
      success: false,
      error: { code: 'INVALID_EXECUTION_CONTEXT' },
    });
    expect(crossTask.result).toMatchObject({
      success: false,
      error: { code: 'INVALID_EXECUTION_CONTEXT' },
    });
    expect(unauthorized.result).toMatchObject({
      success: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    expect(toolExecute).not.toHaveBeenCalled();
    expect(executions.claimExecution).not.toHaveBeenCalled();
  });

  it('requires a persisted approval event for gated tools', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const gatedTool: ToolDefinition = {
      id: 'gated',
      name: 'Gated',
      description: 'Requires an approved workflow event.',
      version: '1.0.0',
      riskLevel: 'high',
      requiresApproval: true,
      inputSchema: {},
      validateInput: () => true,
      async execute() {
        return { success: true, output: { approved: true } };
      },
    };
    const service = createService(
      executions,
      workflows,
      createRegistry(executions, gatedTool),
    );
    const started = applyWorkflowCommand(workflow(), {
      ...commandContext(workflow()),
      type: 'start',
    });
    const waiting = applyWorkflowCommand(started, {
      ...commandContext(started, identity.ownerId, 'request-approval'),
      type: 'request-approval',
      requestId: 'approval-1',
    });
    const blocked = await service.execute(
      request({
        userId: identity.ownerId,
        toolId: 'gated',
        input: {},
      }),
      waiting,
    );
    expect(blocked.result).toMatchObject({
      success: false,
      error: { code: 'APPROVAL_REQUIRED' },
    });
    expect(executions.authorize).not.toHaveBeenCalled();

    const approved = applyWorkflowCommand(waiting, {
      ...commandContext(waiting, 'reviewer-1', 'approve-request'),
      type: 'resolve-approval',
      result: {
        requestId: 'approval-1',
        decision: 'approved',
        approverId: 'reviewer-1',
        decidedAt: '2026-10-08T10:02:00.000Z',
      },
    });
    const authorizedExecutions = new MemoryExecutionRepository();
    const approvedService = createService(
      authorizedExecutions,
      workflows,
      createRegistry(authorizedExecutions, gatedTool),
    );
    authorizedExecutions.hasApprovedRequest.mockResolvedValue(false);
    const unpersistedApproval = await approvedService.execute(
      request({
        userId: 'reviewer-1',
        toolId: 'gated',
        input: {},
      }),
      approved,
    );
    expect(unpersistedApproval.result).toMatchObject({
      success: false,
      error: { code: 'APPROVAL_REQUIRED' },
    });
    expect(authorizedExecutions.claimExecution).not.toHaveBeenCalled();

    authorizedExecutions.hasApprovedRequest.mockResolvedValue(true);
    const allowed = await approvedService.execute(
      request({
        userId: 'reviewer-1',
        toolId: 'gated',
        input: {},
      }),
      approved,
    );
    expect(allowed.result).toEqual({
      success: true,
      output: { approved: true },
    });
    expect(allowed.workflow.task.status).toBe('Verifying');
    expect(authorizedExecutions.hasApprovedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'reviewer-1' }),
      'approval-1',
    );
  });

  it('rejects invalid inputs and unregistered tools without changing workflow state', async () => {
    const executions = new MemoryExecutionRepository();
    const workflows = workflowRepository();
    const service = createService(executions, workflows);
    const invalidInput = await service.execute(
      request({ input: { authorization: 'should-not-persist' } }),
      workflow(),
    );
    const missing = await service.execute(
      request({ toolId: 'run-shell' }),
      workflow(),
    );

    expect(invalidInput.result).toMatchObject({
      success: false,
      error: { code: 'INVALID_TOOL_INPUT' },
    });
    expect(missing.result).toMatchObject({
      success: false,
      error: { code: 'TOOL_NOT_FOUND' },
    });
    expect(invalidInput.workflow.task.status).toBe('Planning');
    expect(missing.workflow.task.status).toBe('Planning');
    expect(executions.authorize).not.toHaveBeenCalled();
  });
});
