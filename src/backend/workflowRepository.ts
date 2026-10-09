import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  WorkflowAggregate,
  WorkflowEvent,
  WorkflowStatus,
} from '../workflow/workflow';

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly memberUserIds: readonly string[];
}

export interface PersistedTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly details: string;
  readonly workflow: WorkflowAggregate;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  title: string;
  details: string;
  status: string;
  attempt: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  task_id: string;
  sequence: number;
  event_type: string;
  actor_id: string;
  occurred_at: string;
  idempotency_key: string;
  request_fingerprint: string;
  status_after: string;
  attempt: number;
  payload: unknown;
}

interface DbEvent {
  readonly sequence: number;
  readonly eventType: WorkflowEvent['type'];
  readonly actorId: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly statusAfter: WorkflowStatus;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
}

export interface WorkflowRepository {
  listWorkspaces(userId: string): Promise<WorkspaceRecord[]>;
  createWorkspace(name: string): Promise<WorkspaceRecord>;
  getTask(taskId: string): Promise<PersistedTask | null>;
  listTasks(workspaceId: string): Promise<PersistedTask[]>;
  createTask(
    input: {
      readonly title: string;
      readonly details: string;
      readonly workflow: WorkflowAggregate;
    },
  ): Promise<PersistedTask>;
  persistEvents(
    current: WorkflowAggregate,
    next: WorkflowAggregate,
  ): Promise<void>;
}

export class SupabaseWorkflowRepository implements WorkflowRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const { data: memberships, error: membershipError } = await this.client
      .from('workspace_members')
      .select('workspace_id, user_id')
      .eq('user_id', userId);
    if (membershipError) throw operationError('load workspaces');
    if (!memberships?.length) return [];

    const workspaceIds = memberships.map((membership) => membership.workspace_id);
    const { data: workspaces, error } = await this.client
      .from('workspaces')
      .select('id, name')
      .in('id', workspaceIds)
      .order('created_at', { ascending: true });
    if (error) throw operationError('load workspaces');
    return (workspaces ?? []).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      memberUserIds: memberships
        .filter((membership) => membership.workspace_id === workspace.id)
        .map((membership) => membership.user_id),
    }));
  }

  async createWorkspace(name: string): Promise<WorkspaceRecord> {
    const { data, error } = await this.client.rpc('create_workspace', {
      p_name: name,
    });
    if (error || typeof data !== 'string') {
      throw operationError('create workspace');
    }
    const { data: workspace, error: workspaceError } = await this.client
      .from('workspaces')
      .select('id, name')
      .eq('id', data)
      .single();
    if (workspaceError || !workspace) throw operationError('load workspace');

    const { data: userResult, error: userError } =
      await this.client.auth.getUser();
    if (userError || !userResult.user) throw operationError('load workspace access');
    return {
      id: workspace.id,
      name: workspace.name,
      memberUserIds: [userResult.user.id],
    };
  }

  async listTasks(workspaceId: string): Promise<PersistedTask[]> {
    const { data, error } = await this.client
      .from('tasks')
      .select(
        'id, workspace_id, owner_id, title, details, status, attempt, created_at, updated_at',
      )
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false });
    if (error) throw operationError('load tasks');
    const rows = (data ?? []) as TaskRow[];
    if (!rows.length) return [];

    const events = await this.loadEvents(rows);
    return rows.map((row) => mapTaskRow(row, events.get(row.id) ?? []));
  }

  async getTask(taskId: string): Promise<PersistedTask | null> {
    const { data, error } = await this.client
      .from('tasks')
      .select(
        'id, workspace_id, owner_id, title, details, status, attempt, created_at, updated_at',
      )
      .eq('id', taskId)
      .maybeSingle();
    if (error) throw operationError('load task');
    if (!data) return null;
    const row = data as TaskRow;
    const events = await this.loadEvents([row]);
    return mapTaskRow(row, events.get(row.id) ?? []);
  }

  async createTask(input: {
    readonly title: string;
    readonly details: string;
    readonly workflow: WorkflowAggregate;
  }): Promise<PersistedTask> {
    const { task, events } = input.workflow;
    const initialEvent = events[0];
    if (!initialEvent || initialEvent.type !== 'task.created') {
      throw new Error('A task must begin with its creation event.');
    }
    const { data, error } = await this.client.rpc('create_workflow_task', {
      p_task_id: task.id,
      p_workspace_id: task.tenantId,
      p_title: input.title,
      p_details: input.details,
      p_initial_event: serializeEvent(initialEvent),
    });
    if (error || data !== task.id) throw operationError('create task');

    const timestamp = initialEvent.occurredAt;
    return {
      id: task.id,
      workspaceId: task.tenantId,
      ownerId: task.ownerId,
      title: input.title,
      details: input.details,
      workflow: input.workflow,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async persistEvents(
    current: WorkflowAggregate,
    next: WorkflowAggregate,
  ): Promise<void> {
    const newEvents = next.events.slice(current.events.length);
    if (!newEvents.length) return;
    const { error } = await this.client.rpc('persist_workflow_events', {
      p_task_id: current.task.id,
      p_expected_sequence: current.events.length,
      p_status: next.task.status,
      p_attempt: next.task.attempt,
      p_events: newEvents.map(serializeEvent),
    });
    if (error) throw operationError('save workflow update');
  }

  private async loadEvents(taskRows: readonly TaskRow[]): Promise<Map<string, WorkflowEvent[]>> {
    const taskIds = taskRows.map((row) => row.id);
    const { data, error } = await this.client
      .from('task_events')
      .select(
        'task_id, sequence, event_type, actor_id, occurred_at, idempotency_key, request_fingerprint, status_after, attempt, payload',
      )
      .in('task_id', [...taskIds])
      .order('sequence', { ascending: true });
    if (error) throw operationError('load task history');

    const tasks = new Map(taskRows.map((row) => [row.id, row]));

    const grouped = new Map<string, WorkflowEvent[]>();
    for (const row of (data ?? []) as EventRow[]) {
      const task = tasks.get(row.task_id);
      if (!task) throw new Error('Task history does not match its task.');
      const events = grouped.get(row.task_id) ?? [];
      events.push(mapEventRow(row, task));
      grouped.set(row.task_id, events);
    }
    return grouped;
  }
}

export function mapTaskRow(
  row: TaskRow,
  events: readonly WorkflowEvent[],
): PersistedTask {
  const status = asWorkflowStatus(row.status);
  const task = {
    id: row.id,
    tenantId: row.workspace_id,
    ownerId: row.owner_id,
    status,
    attempt: row.attempt,
  };
  if (!events.length) throw new Error('Task history is empty.');
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    title: row.title,
    details: row.details,
    workflow: { task, events },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapEventRow(row: EventRow, task: TaskRow): WorkflowEvent {
  const common = {
    sequence: row.sequence,
    taskId: row.task_id,
    tenantId: task.workspace_id,
    ownerId: task.owner_id,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    statusAfter: asWorkflowStatus(row.status_after),
    attempt: row.attempt,
  };
  const payload = asObject(row.payload);

  switch (row.event_type) {
    case 'task.created':
      return { ...common, type: 'task.created' };
    case 'status.changed':
      return {
        ...common,
        type: 'status.changed',
        from: asWorkflowStatus(payload.from),
        to: asWorkflowStatus(payload.to),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      };
    case 'approval.requested':
      return {
        ...common,
        type: 'approval.requested',
        requestId: requiredString(payload.requestId),
      };
    case 'approval.recorded':
      return {
        ...common,
        type: 'approval.recorded',
        result: mapApprovalResult(payload.result),
      };
    case 'verification.recorded':
      return {
        ...common,
        type: 'verification.recorded',
        result: mapVerificationResult(payload.result),
      };
    default:
      throw new Error('Task history contains an unsupported event.');
  }
}

export function serializeEvent(event: WorkflowEvent): DbEvent {
  const payload: Record<string, unknown> =
    event.type === 'status.changed'
      ? {
          from: event.from,
          to: event.to,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        }
      : event.type === 'approval.requested'
        ? { requestId: event.requestId }
        : event.type === 'approval.recorded' ||
            event.type === 'verification.recorded'
          ? { result: event.result }
          : {};

  return {
    sequence: event.sequence,
    eventType: event.type,
    actorId: event.actorId,
    occurredAt: event.occurredAt,
    idempotencyKey: event.idempotencyKey,
    requestFingerprint: event.requestFingerprint,
    statusAfter: event.statusAfter,
    attempt: event.attempt,
    payload,
  };
}

function mapApprovalResult(value: unknown): {
  requestId: string;
  decision: 'approved' | 'rejected';
  approverId: string;
  decidedAt: string;
  reason?: string;
} {
  const result = asObject(value);
  if (result.decision !== 'approved' && result.decision !== 'rejected') {
    throw new Error('Task history contains an invalid approval.');
  }
  return {
    requestId: requiredString(result.requestId),
    decision: result.decision,
    approverId: requiredString(result.approverId),
    decidedAt: requiredString(result.decidedAt),
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
  };
}

function mapVerificationResult(value: unknown): {
  passed: boolean;
  evidenceReference: string;
  verifiedBy: string;
  verifiedAt: string;
  summary?: string;
} {
  const result = asObject(value);
  if (typeof result.passed !== 'boolean') {
    throw new Error('Task history contains an invalid verification.');
  }
  return {
    passed: result.passed,
    evidenceReference: requiredString(result.evidenceReference),
    verifiedBy: requiredString(result.verifiedBy),
    verifiedAt: requiredString(result.verifiedAt),
    ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
  };
}

function asWorkflowStatus(value: unknown): WorkflowStatus {
  if (
    value === 'Planning' ||
    value === 'Running' ||
    value === 'Waiting for approval' ||
    value === 'Verifying' ||
    value === 'Completed' ||
    value === 'Failed'
  ) {
    return value;
  }
  throw new Error('Task history contains an unsupported workflow status.');
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Task history contains invalid event data.');
}

function requiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error('Task history contains incomplete event data.');
}

function operationError(operation: string): Error {
  return new Error(`Unable to ${operation}. Please retry or check your workspace access.`);
}
