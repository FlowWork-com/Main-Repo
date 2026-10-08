import {
  applyWorkflowCommand,
  createWorkflow,
  type WorkflowAggregate,
  type WorkflowCommand,
} from '../workflow/workflow';
import type {
  PersistedTask,
  WorkflowRepository,
} from './workflowRepository';

export async function createWorkflowTask(
  repository: WorkflowRepository,
  input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly title: string;
    readonly details: string;
  },
): Promise<PersistedTask> {
  const taskId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const workflow = createWorkflow({
    task: {
      id: taskId,
      tenantId: input.workspaceId,
      ownerId: input.actorId,
    },
    actorId: input.actorId,
    actorTenantId: input.workspaceId,
    idempotencyKey: crypto.randomUUID(),
    occurredAt,
  });
  return repository.createTask({
    title: input.title,
    details: input.details,
    workflow,
  });
}

export async function applyTaskCommand(
  repository: WorkflowRepository,
  aggregate: WorkflowAggregate,
  command: WorkflowCommand,
): Promise<WorkflowAggregate> {
  const next = applyWorkflowCommand(aggregate, command);
  if (next !== aggregate) await repository.persistEvents(aggregate, next);
  return next;
}
