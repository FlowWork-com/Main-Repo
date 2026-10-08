import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflow,
  type WorkflowAggregate,
  type WorkflowCommandContext,
} from '../workflow/workflow';
import {
  applyTaskCommand,
  createWorkflowTask,
} from './workflowService';
import type {
  PersistedTask,
  WorkflowRepository,
} from './workflowRepository';

function repository(): WorkflowRepository & {
  created?: PersistedTask;
  persistEvents: ReturnType<typeof vi.fn>;
} {
  const store: WorkflowRepository & {
    created?: PersistedTask;
    persistEvents: ReturnType<typeof vi.fn>;
  } = {
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(async (input) => {
      const record: PersistedTask = {
        id: input.workflow.task.id,
        workspaceId: input.workflow.task.tenantId,
        ownerId: input.workflow.task.ownerId,
        title: input.title,
        details: input.details,
        workflow: input.workflow,
        createdAt: input.workflow.events[0].occurredAt,
        updatedAt: input.workflow.events[0].occurredAt,
      };
      store.created = record;
      return record;
    }),
    persistEvents: vi.fn(async () => undefined),
  };
  return store;
}

function commandContext(aggregate: WorkflowAggregate): WorkflowCommandContext {
  return {
    taskId: aggregate.task.id,
    tenantId: aggregate.task.tenantId,
    ownerId: aggregate.task.ownerId,
    actorId: aggregate.task.ownerId,
    actorTenantId: aggregate.task.tenantId,
    idempotencyKey: 'start-task',
    expectedSequence: aggregate.events.length,
    occurredAt: '2026-10-08T10:01:00.000Z',
  };
}

describe('workflow service persistence boundary', () => {
  it('creates a Planning aggregate before asking the repository to persist it', async () => {
    const store = repository();
    const result = await createWorkflowTask(store, {
      workspaceId: 'workspace-1',
      actorId: 'user-1',
      title: 'Check invoice',
      details: 'Confirm the amount.',
    });

    expect(result.workflow.task.status).toBe('Planning');
    expect(result.workflow.events).toHaveLength(1);
    expect(store.createTask).toHaveBeenCalledOnce();
    expect(store.created?.title).toBe('Check invoice');
  });

  it('validates a command in the domain and persists only its appended events', async () => {
    const store = repository();
    const aggregate = createWorkflow({
      task: { id: 'task-1', tenantId: 'workspace-1', ownerId: 'user-1' },
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'create-task',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });
    const started = await applyTaskCommand(store, aggregate, {
      ...commandContext(aggregate),
      type: 'start',
    });

    expect(started.task.status).toBe('Running');
    expect(store.persistEvents).toHaveBeenCalledWith(aggregate, started);
  });

  it('does not write when a command is rejected by the workflow domain', async () => {
    const store = repository();
    const aggregate = createWorkflow({
      task: { id: 'task-1', tenantId: 'workspace-1', ownerId: 'user-1' },
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'create-task',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });

    await expect(
      applyTaskCommand(store, aggregate, {
        ...commandContext(aggregate),
        type: 'begin-verification',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(store.persistEvents).not.toHaveBeenCalled();
  });
});
