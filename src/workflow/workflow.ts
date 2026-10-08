export const WORKFLOW_STATUSES = [
  'Planning',
  'Running',
  'Waiting for approval',
  'Verifying',
  'Completed',
  'Failed',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const ALLOWED_WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  Planning: ['Running', 'Failed'],
  Running: ['Waiting for approval', 'Verifying', 'Failed'],
  'Waiting for approval': ['Running', 'Failed'],
  Verifying: ['Completed', 'Failed'],
  Completed: [],
  Failed: ['Planning'],
};

export interface WorkflowTaskIdentity {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
}

export interface WorkflowTask extends WorkflowTaskIdentity {
  readonly status: WorkflowStatus;
  readonly attempt: number;
}

export interface WorkflowAggregate {
  readonly task: WorkflowTask;
  readonly events: readonly WorkflowEvent[];
}

export interface ApprovalResult {
  readonly requestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly approverId: string;
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly evidenceReference: string;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
  readonly summary?: string;
}

interface EventMetadata {
  readonly sequence: number;
  readonly taskId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly statusAfter: WorkflowStatus;
  readonly attempt: number;
}

export type WorkflowEvent =
  | (EventMetadata & {
      readonly type: 'task.created';
    })
  | (EventMetadata & {
      readonly type: 'status.changed';
      readonly from: WorkflowStatus;
      readonly to: WorkflowStatus;
      readonly reason?: string;
    })
  | (EventMetadata & {
      readonly type: 'approval.requested';
      readonly requestId: string;
    })
  | (EventMetadata & {
      readonly type: 'approval.recorded';
      readonly result: ApprovalResult;
    })
  | (EventMetadata & {
      readonly type: 'verification.recorded';
      readonly result: VerificationResult;
    });

export interface WorkflowCommandContext {
  readonly taskId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly actorId: string;
  readonly actorTenantId: string;
  readonly idempotencyKey: string;
  readonly expectedSequence: number;
  readonly occurredAt: string;
}

export type WorkflowCommand =
  | (WorkflowCommandContext & { readonly type: 'start' })
  | (WorkflowCommandContext & {
      readonly type: 'request-approval';
      readonly requestId: string;
    })
  | (WorkflowCommandContext & {
      readonly type: 'resolve-approval';
      readonly result: ApprovalResult;
    })
  | (WorkflowCommandContext & { readonly type: 'begin-verification' })
  | (WorkflowCommandContext & {
      readonly type: 'record-verification';
      readonly result: VerificationResult;
    })
  | (WorkflowCommandContext & {
      readonly type: 'fail';
      readonly reason: string;
    })
  | (WorkflowCommandContext & {
      readonly type: 'retry';
      readonly reason: string;
    });

export type WorkflowDomainErrorCode =
  | 'INVALID_INPUT'
  | 'CONTEXT_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'SEQUENCE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_APPROVAL'
  | 'INVALID_VERIFICATION'
  | 'CORRUPT_HISTORY';

export class WorkflowDomainError extends Error {
  constructor(
    readonly code: WorkflowDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowDomainError';
  }
}

export function canTransitionWorkflowStatus(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return ALLOWED_WORKFLOW_TRANSITIONS[from].includes(to);
}

export function createWorkflow(input: {
  readonly task: WorkflowTaskIdentity;
  readonly actorId: string;
  readonly actorTenantId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}): WorkflowAggregate {
  assertNonEmpty(input.task.id, 'task id');
  assertNonEmpty(input.task.tenantId, 'tenant id');
  assertNonEmpty(input.task.ownerId, 'owner id');
  assertNonEmpty(input.actorId, 'actor id');
  assertNonEmpty(input.idempotencyKey, 'idempotency key');
  assertNonEmpty(input.occurredAt, 'occurred at');
  if (input.actorTenantId !== input.task.tenantId) {
    throw new WorkflowDomainError(
      'CONTEXT_MISMATCH',
      'The actor and task must belong to the same tenant.',
    );
  }

  const fingerprint = stableStringify({
    type: 'task.created',
    task: input.task,
    actorId: input.actorId,
  });
  const task: WorkflowTask = {
    ...input.task,
    status: 'Planning',
    attempt: 1,
  };
  const event: WorkflowEvent = {
    type: 'task.created',
    sequence: 1,
    taskId: task.id,
    tenantId: task.tenantId,
    ownerId: task.ownerId,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint,
    statusAfter: task.status,
    attempt: task.attempt,
  };
  return { task, events: [event] };
}

export function applyWorkflowCommand(
  aggregate: WorkflowAggregate,
  command: WorkflowCommand,
): WorkflowAggregate {
  assertAggregate(aggregate);
  assertCommandContext(aggregate.task, command);

  const fingerprint = commandFingerprint(command);
  const priorEvents = aggregate.events.filter(
    (event) => event.idempotencyKey === command.idempotencyKey,
  );
  if (priorEvents.length > 0) {
    if (priorEvents.some((event) => event.requestFingerprint !== fingerprint)) {
      throw new WorkflowDomainError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used for a different command.',
      );
    }
    return aggregate;
  }

  if (command.expectedSequence !== aggregate.events.length) {
    throw new WorkflowDomainError(
      'SEQUENCE_MISMATCH',
      `Expected event sequence ${aggregate.events.length}, received ${command.expectedSequence}.`,
    );
  }
  assertNonEmpty(command.idempotencyKey, 'idempotency key');
  assertNonEmpty(command.occurredAt, 'occurred at');

  const events: WorkflowEvent[] = [];
  let status = aggregate.task.status;
  let attempt = aggregate.task.attempt;

  const eventMetadata = (
    statusAfter: WorkflowStatus,
    eventAttempt: number,
  ): EventMetadata => ({
    sequence: aggregate.events.length + events.length + 1,
    taskId: aggregate.task.id,
    tenantId: aggregate.task.tenantId,
    ownerId: aggregate.task.ownerId,
    actorId: command.actorId,
    occurredAt: command.occurredAt,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: fingerprint,
    statusAfter,
    attempt: eventAttempt,
  });

  const changeStatus = (
    nextStatus: WorkflowStatus,
    reason?: string,
  ): void => {
    assertAllowedTransition(status, nextStatus);
    const from = status;
    status = nextStatus;
    events.push({
      ...eventMetadata(status, attempt),
      type: 'status.changed',
      from,
      to: status,
      ...(reason === undefined ? {} : { reason }),
    });
  };

  switch (command.type) {
    case 'start':
      changeStatus('Running');
      break;
    case 'request-approval':
      assertAllowedTransition(status, 'Waiting for approval');
      assertNonEmpty(command.requestId, 'approval request id');
      changeStatus('Waiting for approval');
      events.push({
        ...eventMetadata('Waiting for approval', attempt),
        type: 'approval.requested',
        requestId: command.requestId,
      });
      break;
    case 'resolve-approval': {
      if (status !== 'Waiting for approval') {
        throw invalidTransition(status, 'resolve approval');
      }
      validateApproval(command.result, command.actorId, aggregate.events);
      events.push({
        ...eventMetadata(status, attempt),
        type: 'approval.recorded',
        result: command.result,
      });
      if (command.result.decision === 'approved') {
        changeStatus('Running');
      } else {
        changeStatus('Failed', command.result.reason ?? 'Approval rejected');
      }
      break;
    }
    case 'begin-verification':
      changeStatus('Verifying');
      break;
    case 'record-verification':
      if (status !== 'Verifying') {
        throw invalidTransition(status, 'record verification');
      }
      validateVerification(command.result, command.actorId);
      events.push({
        ...eventMetadata(status, attempt),
        type: 'verification.recorded',
        result: command.result,
      });
      if (command.result.passed) {
        changeStatus('Completed');
      } else {
        changeStatus('Failed', command.result.summary ?? 'Verification failed');
      }
      break;
    case 'fail':
      assertNonEmpty(command.reason, 'failure reason');
      changeStatus('Failed', command.reason);
      break;
    case 'retry':
      if (status !== 'Failed') {
        throw invalidTransition(status, 'retry');
      }
      assertNonEmpty(command.reason, 'retry reason');
      attempt += 1;
      changeStatus('Planning', command.reason);
      break;
    default:
      assertNever(command);
  }

  return {
    task: { ...aggregate.task, status, attempt },
    events: [...aggregate.events, ...events],
  };
}

function assertAggregate(aggregate: WorkflowAggregate): void {
  if (!Number.isInteger(aggregate.task.attempt) || aggregate.task.attempt < 1) {
    throw new WorkflowDomainError(
      'CORRUPT_HISTORY',
      'Workflow attempt must be a positive integer.',
    );
  }
  let latestStatus: WorkflowStatus | undefined;
  let latestAttempt = 0;
  aggregate.events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new WorkflowDomainError(
        'CORRUPT_HISTORY',
        `Event at index ${index} has sequence ${event.sequence}; expected ${index + 1}.`,
      );
    }
    if (
      event.taskId !== aggregate.task.id ||
      event.tenantId !== aggregate.task.tenantId ||
      event.ownerId !== aggregate.task.ownerId
    ) {
      throw new WorkflowDomainError(
        'CONTEXT_MISMATCH',
        'Workflow event context does not match its task.',
      );
    }
    latestStatus = event.statusAfter;
    latestAttempt = event.attempt;
  });
  if (
    latestStatus !== aggregate.task.status ||
    latestAttempt !== aggregate.task.attempt
  ) {
    throw new WorkflowDomainError(
      'CORRUPT_HISTORY',
      'Workflow task state does not match its event history.',
    );
  }
}

function assertCommandContext(
  task: WorkflowTask,
  command: WorkflowCommandContext,
): void {
  if (
    command.taskId !== task.id ||
    command.tenantId !== task.tenantId ||
    command.ownerId !== task.ownerId ||
    command.actorTenantId !== task.tenantId
  ) {
    throw new WorkflowDomainError(
      'CONTEXT_MISMATCH',
      'Command task, tenant, owner, or actor context does not match the workflow.',
    );
  }
  assertNonEmpty(command.actorId, 'actor id');
}

function validateApproval(
  result: ApprovalResult,
  actorId: string,
  events: readonly WorkflowEvent[],
): void {
  const pendingRequest = [...events]
    .reverse()
    .find((event) => event.type === 'approval.requested');
  if (
    pendingRequest &&
    pendingRequest.requestId === result.requestId &&
    result.decision === 'approved' &&
    pendingRequest.actorId === actorId
  ) {
    throw new WorkflowDomainError(
      'INVALID_APPROVAL',
      'An approval requester cannot approve their own request.',
    );
  }
  if (
    !pendingRequest ||
    pendingRequest.requestId !== result.requestId ||
    result.approverId !== actorId ||
    !['approved', 'rejected'].includes(result.decision) ||
    typeof result.approverId !== 'string' ||
    typeof result.decidedAt !== 'string' ||
    !result.decidedAt.trim()
  ) {
    throw new WorkflowDomainError(
      'INVALID_APPROVAL',
      'Approval must resolve the pending request with a valid decision and approver.',
    );
  }
}

function validateVerification(
  result: VerificationResult,
  actorId: string,
): void {
  if (
    typeof result.passed !== 'boolean' ||
    typeof result.evidenceReference !== 'string' ||
    !result.evidenceReference.trim() ||
    result.verifiedBy !== actorId ||
    typeof result.verifiedAt !== 'string' ||
    !result.verifiedAt.trim()
  ) {
    throw new WorkflowDomainError(
      'INVALID_VERIFICATION',
      'Verification requires evidence, an outcome, a timestamp, and the acting verifier.',
    );
  }
}

function assertAllowedTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): void {
  if (!canTransitionWorkflowStatus(from, to)) {
    throw invalidTransition(from, `transition to ${to}`);
  }
}

function invalidTransition(
  status: WorkflowStatus,
  action: string,
): WorkflowDomainError {
  return new WorkflowDomainError(
    'INVALID_TRANSITION',
    `Cannot ${action} while workflow is ${status}.`,
  );
}

function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowDomainError('INVALID_INPUT', `${label} must not be empty.`);
  }
}

function commandFingerprint(command: WorkflowCommand): string {
  const intent = Object.fromEntries(
    Object.entries(command).filter(
      ([key]) =>
        key !== 'expectedSequence' &&
        key !== 'occurredAt' &&
        key !== 'idempotencyKey',
    ),
  );
  return stableStringify(intent);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

function assertNever(value: never): never {
  throw new WorkflowDomainError(
    'INVALID_INPUT',
    `Unsupported workflow command: ${JSON.stringify(value)}`,
  );
}
