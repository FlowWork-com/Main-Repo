import { describe, expect, it } from 'vitest';
import {
  ALLOWED_WORKFLOW_TRANSITIONS,
  applyWorkflowCommand,
  canTransitionWorkflowStatus,
  createWorkflow,
  WorkflowDomainError,
  type WorkflowAggregate,
  type WorkflowCommand,
  type WorkflowCommandContext,
} from './workflow';

const identity = {
  id: 'task-1',
  tenantId: 'tenant-1',
  ownerId: 'owner-1',
} as const;

function createTask(): WorkflowAggregate {
  return createWorkflow({
    task: identity,
    actorId: 'owner-1',
    actorTenantId: identity.tenantId,
    idempotencyKey: 'create-1',
    occurredAt: '2026-10-07T10:00:00.000Z',
  });
}

function context(
  aggregate: WorkflowAggregate,
  idempotencyKey: string,
  actorId = 'owner-1',
): WorkflowCommandContext {
  return {
    taskId: aggregate.task.id,
    tenantId: aggregate.task.tenantId,
    ownerId: aggregate.task.ownerId,
    actorId,
    actorTenantId: aggregate.task.tenantId,
    idempotencyKey,
    expectedSequence: aggregate.events.length,
    occurredAt: '2026-10-07T10:01:00.000Z',
  };
}

function apply(
  aggregate: WorkflowAggregate,
  command: WorkflowCommand,
): WorkflowAggregate {
  return applyWorkflowCommand(aggregate, command);
}

function expectDomainError(
  action: () => unknown,
  code: WorkflowDomainError['code'],
): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof WorkflowDomainError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected WorkflowDomainError with code ${code}.`);
}

describe('workflow domain', () => {
  it('defines the complete status graph and rejects terminal shortcuts', () => {
    expect(ALLOWED_WORKFLOW_TRANSITIONS).toEqual({
      Planning: ['Running', 'Failed'],
      Running: ['Waiting for approval', 'Verifying', 'Failed'],
      'Waiting for approval': ['Running', 'Failed'],
      Verifying: ['Completed', 'Failed'],
      Completed: [],
      Failed: ['Planning'],
    });
    expect(canTransitionWorkflowStatus('Verifying', 'Completed')).toBe(true);
    expect(canTransitionWorkflowStatus('Running', 'Completed')).toBe(false);
    expect(canTransitionWorkflowStatus('Completed', 'Planning')).toBe(false);
  });

  it('creates an owned, tenant-scoped task with an initial audit event', () => {
    const aggregate = createTask();

    expect(aggregate.task).toEqual({
      ...identity,
      status: 'Planning',
      attempt: 1,
    });
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.events[0]).toMatchObject({
      type: 'task.created',
      sequence: 1,
      taskId: identity.id,
      tenantId: identity.tenantId,
      ownerId: identity.ownerId,
    });
  });

  it('rejects mismatched tenant or owner context', () => {
    const aggregate = createTask();
    expectDomainError(
      () =>
        createWorkflow({
          task: identity,
          actorId: 'owner-1',
          actorTenantId: 'tenant-2',
          idempotencyKey: 'create-other-tenant',
          occurredAt: '2026-10-07T10:00:00.000Z',
        }),
      'CONTEXT_MISMATCH',
    );

    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'wrong-owner'),
          ownerId: 'owner-2',
          type: 'start',
        }),
      'CONTEXT_MISMATCH',
    );
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'wrong-tenant'),
          tenantId: 'tenant-2',
          type: 'start',
        }),
      'CONTEXT_MISMATCH',
    );
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'wrong-actor-tenant'),
          actorTenantId: 'tenant-2',
          type: 'start',
        }),
      'CONTEXT_MISMATCH',
    );

    const wrongTenantHistory = {
      ...aggregate,
      events: [{ ...aggregate.events[0], tenantId: 'tenant-2' }],
    };
    expectDomainError(
      () =>
        apply(wrongTenantHistory, {
          ...context(aggregate, 'wrong-event-tenant'),
          type: 'start',
        }),
      'CONTEXT_MISMATCH',
    );
  });

  it('requires an approval decision for the pending request before resuming', () => {
    let aggregate = createTask();
    aggregate = apply(aggregate, {
      ...context(aggregate, 'start-1'),
      type: 'start',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'approval-request-1'),
      type: 'request-approval',
      requestId: 'approval-1',
    });
    const waiting = aggregate;

    expect(aggregate.task.status).toBe('Waiting for approval');
    expect(aggregate.events.at(-1)).toMatchObject({
      type: 'approval.requested',
      requestId: 'approval-1',
    });
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'approval-self-approved'),
          type: 'resolve-approval',
          result: {
            requestId: 'approval-1',
            decision: 'approved',
            approverId: 'owner-1',
            decidedAt: '2026-10-07T10:02:00.000Z',
          },
        }),
      'INVALID_APPROVAL',
    );

    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'approval-wrong-request', 'reviewer-1'),
          type: 'resolve-approval',
          result: {
            requestId: 'approval-other',
            decision: 'approved',
            approverId: 'reviewer-1',
            decidedAt: '2026-10-07T10:02:00.000Z',
          },
        }),
      'INVALID_APPROVAL',
    );

    aggregate = apply(aggregate, {
      ...context(aggregate, 'approval-approved', 'reviewer-1'),
      type: 'resolve-approval',
      result: {
        requestId: 'approval-1',
        decision: 'approved',
        approverId: 'reviewer-1',
        decidedAt: '2026-10-07T10:02:00.000Z',
      },
    });
    expect(aggregate.task.status).toBe('Running');
    expect(aggregate.events.slice(0, waiting.events.length)).toEqual(
      waiting.events,
    );
    expect(aggregate.events.at(-2)).toMatchObject({
      type: 'approval.recorded',
      result: { decision: 'approved' },
    });
  });

  it('moves a rejected approval to Failed', () => {
    let aggregate = createTask();
    aggregate = apply(aggregate, {
      ...context(aggregate, 'start'),
      type: 'start',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'approval-request'),
      type: 'request-approval',
      requestId: 'approval-1',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'approval-rejected', 'reviewer-1'),
      type: 'resolve-approval',
      result: {
        requestId: 'approval-1',
        decision: 'rejected',
        approverId: 'reviewer-1',
        decidedAt: '2026-10-07T10:02:00.000Z',
        reason: 'Needs changes',
      },
    });

    expect(aggregate.task.status).toBe('Failed');
    expect(aggregate.events.at(-1)).toMatchObject({
      type: 'status.changed',
      to: 'Failed',
      reason: 'Needs changes',
    });
  });

  it('completes only after verification supplies evidence', () => {
    let aggregate = createTask();
    aggregate = apply(aggregate, {
      ...context(aggregate, 'start'),
      type: 'start',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'begin-verification'),
      type: 'begin-verification',
    });
    expect(aggregate.task.status).toBe('Verifying');
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'verification-no-evidence'),
          type: 'record-verification',
          result: {
            passed: true,
            evidenceReference: ' ',
            verifiedBy: 'owner-1',
            verifiedAt: '2026-10-07T10:02:00.000Z',
          },
        }),
      'INVALID_VERIFICATION',
    );

    aggregate = apply(aggregate, {
      ...context(aggregate, 'verification-passed'),
      type: 'record-verification',
      result: {
        passed: true,
        evidenceReference: 'receipt://workflow/task-1',
        verifiedBy: 'owner-1',
        verifiedAt: '2026-10-07T10:02:00.000Z',
      },
    });
    expect(aggregate.task.status).toBe('Completed');
    expect(aggregate.events.at(-2)).toMatchObject({
      type: 'verification.recorded',
      result: {
        passed: true,
        evidenceReference: 'receipt://workflow/task-1',
      },
    });
  });

  it('records failed verification as failure rather than success', () => {
    let aggregate = createTask();
    aggregate = apply(aggregate, {
      ...context(aggregate, 'start'),
      type: 'start',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'verify'),
      type: 'begin-verification',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'verification-failed'),
      type: 'record-verification',
      result: {
        passed: false,
        evidenceReference: 'check://task-1/failure',
        verifiedBy: 'owner-1',
        verifiedAt: '2026-10-07T10:02:00.000Z',
        summary: 'Expected record was not found.',
      },
    });
    expect(aggregate.task.status).toBe('Failed');
  });

  it('makes duplicate commands idempotent and rejects key reuse for new intent', () => {
    const initial = createTask();
    const startCommand = {
      ...context(initial, 'start-once'),
      type: 'start' as const,
    };
    const started = apply(initial, startCommand);
    const replayed = apply(started, {
      ...startCommand,
      expectedSequence: -1,
      occurredAt: '2026-10-07T11:00:00.000Z',
    });

    expect(replayed).toBe(started);
    expect(replayed.events).toHaveLength(2);
    expectDomainError(
      () =>
        apply(started, {
          ...startCommand,
          type: 'fail',
          reason: 'Different command',
        }),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('checks event sequence and detects corrupt event history', () => {
    const aggregate = createTask();
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'stale-sequence'),
          expectedSequence: 0,
          type: 'start',
        }),
      'SEQUENCE_MISMATCH',
    );
    const corrupted = {
      ...aggregate,
      events: [{ ...aggregate.events[0], sequence: 4 }],
    };
    expectDomainError(
      () => apply(corrupted, { ...context(aggregate, 'next'), type: 'start' }),
      'CORRUPT_HISTORY',
    );
  });

  it('allows explicit failure and recovery retries while incrementing attempts', () => {
    let aggregate = createTask();
    aggregate = apply(aggregate, {
      ...context(aggregate, 'start'),
      type: 'start',
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'fail'),
      type: 'fail',
      reason: 'Execution could not be completed.',
    });
    expect(aggregate.task.status).toBe('Failed');
    expect(aggregate.task.attempt).toBe(1);

    aggregate = apply(aggregate, {
      ...context(aggregate, 'retry'),
      type: 'retry',
      reason: 'Retry after correcting the source data.',
    });
    expect(aggregate.task).toMatchObject({
      status: 'Planning',
      attempt: 2,
    });
    aggregate = apply(aggregate, {
      ...context(aggregate, 'retry-start'),
      type: 'start',
    });
    expect(aggregate.task.status).toBe('Running');
    expect(aggregate.task.attempt).toBe(2);
    expect(aggregate.events.at(-1)).toMatchObject({
      type: 'status.changed',
      attempt: 2,
      from: 'Planning',
      to: 'Running',
    });
  });

  it('rejects unsupported retries and transitions from Completed', () => {
    const aggregate = createTask();
    expectDomainError(
      () =>
        apply(aggregate, {
          ...context(aggregate, 'retry-too-early'),
          type: 'retry',
          reason: 'Not failed yet',
        }),
      'INVALID_TRANSITION',
    );

    const completed = {
      ...aggregate,
      task: { ...aggregate.task, status: 'Completed' as const },
      events: [
        {
          ...aggregate.events[0],
          statusAfter: 'Completed' as const,
        },
      ],
    };
    expectDomainError(
      () =>
        apply(completed, {
          ...context(completed, 'completed-start'),
          type: 'start',
        }),
      'INVALID_TRANSITION',
    );
  });
});
