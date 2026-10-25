import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JsonValue,
  ToolEvidence,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
} from '../tools/contracts';
import { isPersistableJson } from '../tools/contracts';
import type {
  TaskFileContent,
  TaskFileContentSource,
  TaskFileMetadata,
  TaskFileMetadataSource,
} from '../tools/mvpTools';

export type StoredExecutionStatus = 'running' | 'succeeded' | 'failed';

export interface StoredToolExecution {
  readonly requestedBy: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: unknown;
  readonly status: StoredExecutionStatus;
  readonly result: ToolExecutionResult | null;
}

export interface ToolExecutionHistoryEntry {
  readonly executionId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly status: StoredExecutionStatus;
  readonly input: JsonValue;
  readonly output: JsonValue | null;
  readonly error: ToolExecutionError | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

interface ExecutionHistoryRow {
  readonly execution_id: string;
  readonly tool_id: string;
  readonly tool_version: string;
  readonly status: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: unknown;
  readonly created_at: string;
  readonly started_at: string;
  readonly completed_at: string | null;
}

export interface ToolExecutionRepository extends TaskFileMetadataSource, TaskFileContentSource {
  authorize(context: ToolExecutionContext): Promise<boolean>;
  hasApprovedRequest(
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<boolean>;
  findExecution(context: ToolExecutionContext): Promise<StoredToolExecution | null>;
  claimExecution(context: ToolExecutionContext, input: unknown): Promise<boolean>;
  completeExecution(
    context: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<void>;
  claimPlanStep(
    context: ToolExecutionContext,
    planRunId: string,
    stepId: string,
  ): Promise<{ readonly toolId: string; readonly toolVersion: string; readonly input: unknown }>;
  completePlanStep(
    context: ToolExecutionContext,
    planRunId: string,
    stepId: string,
    result: ToolExecutionResult,
  ): Promise<'running' | 'succeeded'>;
}

interface ExecutionRow {
  readonly requested_by: string;
  readonly execution_id: string;
  readonly request_id: string;
  readonly tool_id: string;
  readonly tool_version: string;
  readonly input: unknown;
  readonly status: string;
  readonly output: unknown;
  readonly error: unknown;
  readonly evidence: unknown;
}

interface TaskFileRow {
  readonly id: string;
  readonly file_name: string;
  readonly content_type: string | null;
  readonly created_at: string;
  readonly storage_path?: string;
}

export class SupabaseToolExecutionRepository
  implements ToolExecutionRepository
{
  constructor(private readonly client: SupabaseClient) {}

  async authorize(context: ToolExecutionContext): Promise<boolean> {
    const { data: membership, error: membershipError } = await this.client
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', context.workspaceId)
      .eq('user_id', context.userId)
      .maybeSingle();
    if (membershipError) throw operationError('authorize tool execution');
    if (!membership) return false;

    const { data: task, error: taskError } = await this.client
      .from('tasks')
      .select('id, workspace_id')
      .eq('id', context.taskId)
      .eq('workspace_id', context.workspaceId)
      .maybeSingle();
    if (taskError) throw operationError('authorize tool execution');
    return Boolean(task && task.id === context.taskId);
  }

  async hasApprovedRequest(
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('task_approvals')
      .select('request_id')
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .eq('request_id', requestId)
      .eq('decision', 'approved')
      .maybeSingle();
    if (error) throw operationError('check tool approval');
    return Boolean(data);
  }

  async findExecution(
    context: ToolExecutionContext,
  ): Promise<StoredToolExecution | null> {
    const byExecutionId = await this.client
      .from('task_tool_executions')
      .select('requested_by, execution_id, request_id, tool_id, tool_version, input, status, output, error, evidence')
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .eq('execution_id', context.executionId)
      .maybeSingle();
    if (byExecutionId.error) throw operationError('load tool execution');
    if (byExecutionId.data) return mapExecutionRow(byExecutionId.data as ExecutionRow);

    const byRequestId = await this.client
      .from('task_tool_executions')
      .select('requested_by, execution_id, request_id, tool_id, tool_version, input, status, output, error, evidence')
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .eq('request_id', context.requestId)
      .maybeSingle();
    if (byRequestId.error) throw operationError('load tool execution');
    return byRequestId.data
      ? mapExecutionRow(byRequestId.data as ExecutionRow)
      : null;
  }

  async claimExecution(
    context: ToolExecutionContext,
    input: unknown,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('claim_task_tool_execution', {
      p_workspace_id: context.workspaceId,
      p_task_id: context.taskId,
      p_execution_id: context.executionId,
      p_request_id: context.requestId,
      p_tool_id: context.toolId,
      p_tool_version: context.toolVersion,
      p_input: input,
      p_actor_id: context.userId,
    });
    if (error || !Array.isArray(data) || data.length !== 1) {
      throw operationError('reserve tool execution');
    }
    const row = data[0] as { readonly was_created?: unknown };
    if (typeof row.was_created !== 'boolean') {
      throw operationError('reserve tool execution');
    }
    return row.was_created;
  }

  async completeExecution(
    context: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<void> {
    const { error } = await this.client.rpc('finish_task_tool_execution', {
      p_workspace_id: context.workspaceId,
      p_task_id: context.taskId,
      p_execution_id: context.executionId,
      p_output: result.success ? result.output : null,
      p_error: result.success ? null : result.error,
      p_evidence: result.success ? result.evidence ?? null : null,
      p_actor_id: context.userId,
    });
    if (error) throw operationError('save tool execution result');
  }

  async claimPlanStep(
    context: ToolExecutionContext,
    planRunId: string,
    stepId: string,
  ): Promise<{ readonly toolId: string; readonly toolVersion: string; readonly input: unknown }> {
    const { data, error } = await this.client.rpc('claim_workflow_plan_step', {
      p_run_id: planRunId,
      p_step_id: stepId,
      p_execution_id: context.executionId,
      p_actor_id: context.userId,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw operationError('claim plan step');
    }
    const row = data as Record<string, unknown>;
    if (
      row.step_id !== stepId ||
      row.execution_id !== context.executionId ||
      typeof row.tool_id !== 'string' ||
      typeof row.tool_version !== 'string' ||
      !isPersistableJson(row.input)
    ) {
      throw operationError('validate plan step claim');
    }
    return { toolId: row.tool_id, toolVersion: row.tool_version, input: row.input };
  }

  async completePlanStep(
    context: ToolExecutionContext,
    planRunId: string,
    stepId: string,
    result: ToolExecutionResult,
  ): Promise<'running' | 'succeeded'> {
    const { error } = await this.client.rpc('finish_workflow_plan_step', {
      p_run_id: planRunId,
      p_step_id: stepId,
      p_execution_id: context.executionId,
      p_output: result.success ? result.output : null,
      p_error: result.success ? null : result.error,
      p_actor_id: context.userId,
    });
    if (error) throw operationError('save plan step result');

    const { data, error: statusError } = await this.client
      .from('workflow_plan_runs')
      .select('status')
      .eq('id', planRunId)
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .maybeSingle();
    if (statusError || !data || (data.status !== 'running' && data.status !== 'succeeded')) {
      throw operationError('load plan run status');
    }
    return data.status;
  }

  async getTaskFileContent(
    context: ToolExecutionContext,
    fileId: string,
  ): Promise<TaskFileContent | null> {
    if (!(await this.authorize(context))) return null;

    const { data, error } = await this.client
      .from('task_files')
      .select('id, file_name, storage_path, content_type')
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .eq('id', fileId)
      .maybeSingle();
    if (error) throw operationError('load task file');
    if (!data) return null;

    const file = data as {
      readonly id: string;
      readonly file_name: string;
      readonly storage_path: string;
      readonly content_type: string | null;
    };
    const extension = file.file_name.toLowerCase().split('.').pop();
    const expectedContentType = extension === 'csv'
      ? 'text/csv'
      : extension === 'tsv'
      ? 'text/tab-separated-values'
      : extension === 'xls'
      ? 'application/vnd.ms-excel'
      : extension === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : extension === 'pdf'
      ? 'application/pdf'
      : extension === 'jpg' || extension === 'jpeg'
      ? 'image/jpeg'
      : extension === 'png'
      ? 'image/png'
      : null;
    if (!expectedContentType || file.content_type?.toLowerCase() !== expectedContentType) {
      return null;
    }

    const pathParts = file.storage_path.split('/');
    if (
      pathParts.length !== 4 ||
      pathParts[0] !== context.workspaceId ||
      pathParts[1] !== context.taskId ||
      !isUuid(pathParts[2]) ||
      pathParts[3] !== file.file_name
    ) {
      return null;
    }

    const downloaded = await this.client.storage
      .from('workflow-files')
      .download(file.storage_path);
    if (downloaded.error) throw operationError('read task file content');
    if (!downloaded.data || downloaded.data.size === 0 || downloaded.data.size > 10_485_760) {
      return null;
    }

    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (extension === 'csv' || extension === 'tsv') {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
      if (text.includes('\u0000')) return null;
    }

    return {
      id: file.id,
      fileName: file.file_name,
      contentType: expectedContentType,
      bytes,
    };
  }

  async getTaskFileMetadata(
    context: ToolExecutionContext,
    fileId: string,
  ): Promise<TaskFileMetadata | null> {
    const { data, error } = await this.client
      .from('task_files')
      .select('id, file_name, content_type, created_at')
      .eq('workspace_id', context.workspaceId)
      .eq('task_id', context.taskId)
      .eq('id', fileId)
      .maybeSingle();
    if (error) throw operationError('load task file metadata');
    if (!data) return null;
    const file = data as TaskFileRow;
    return {
      id: file.id,
      fileName: file.file_name,
      contentType: file.content_type,
      createdAt: file.created_at,
    };
  }
}

export class SupabaseToolExecutionHistoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listTaskExecutions(
    workspaceId: string,
    taskId: string,
  ): Promise<ToolExecutionHistoryEntry[]> {
    const { data, error } = await this.client
      .from('task_tool_executions')
      .select('execution_id, tool_id, tool_version, status, input, output, error, created_at, started_at, completed_at')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });
    if (error) throw operationError('load tool execution history');
    return ((data ?? []) as ExecutionHistoryRow[]).map(mapExecutionHistoryRow);
  }
}

function mapExecutionHistoryRow(row: ExecutionHistoryRow): ToolExecutionHistoryEntry {
  const status = asExecutionStatus(row.status);
  if (!isPersistableJson(row.input)) {
    throw new Error('Tool execution history contains invalid input.');
  }
  const input = row.input;
  let output: JsonValue | null = null;
  let error: ToolExecutionError | null = null;
  if (status === 'succeeded') {
    if (!isPersistableJson(row.output)) {
      throw new Error('Tool execution history contains invalid output.');
    }
    output = row.output;
  } else if (status === 'failed') {
    error = asToolError(row.error);
  }
  return {
    executionId: row.execution_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    status,
    input,
    output,
    error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapExecutionRow(row: ExecutionRow): StoredToolExecution {
  const status = asExecutionStatus(row.status);
  let result: ToolExecutionResult | null = null;
  if (status === 'succeeded') {
    if (!isPersistableJson(row.output)) {
      throw new Error('Tool execution history contains invalid output.');
    }
    result = {
      success: true,
      output: row.output,
      ...(row.evidence ? { evidence: asEvidence(row.evidence) } : {}),
    };
  } else if (status === 'failed') {
    const error = asToolError(row.error);
    result = {
      success: false,
      error,
    };
  }
  return {
    requestedBy: row.requested_by,
    executionId: row.execution_id,
    requestId: row.request_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    input: row.input,
    status,
    result,
  };
}

function asExecutionStatus(value: string): StoredExecutionStatus {
  if (value === 'running' || value === 'succeeded' || value === 'failed') {
    return value;
  }
  throw new Error('Tool execution history contains an unsupported status.');
}

function asEvidence(value: unknown): ToolEvidence {
  const evidence = asRecord(value);
  if (
    !evidence ||
    typeof evidence.type !== 'string' ||
    typeof evidence.reference !== 'string' ||
    (evidence.summary !== undefined && typeof evidence.summary !== 'string')
  ) {
    throw new Error('Tool execution history contains invalid evidence.');
  }
  return {
    type: evidence.type,
    reference: evidence.reference,
    ...(typeof evidence.summary === 'string' ? { summary: evidence.summary } : {}),
  };
}

function asToolError(value: unknown): ToolExecutionError {
  const error = asRecord(value);
  if (
    !error ||
    !isErrorCode(error.code) ||
    typeof error.message !== 'string' ||
    typeof error.retryable !== 'boolean'
  ) {
    throw new Error('Tool execution history contains an invalid error.');
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isErrorCode(value: unknown): value is ToolExecutionError['code'] {
  switch (value) {
    case 'TOOL_NOT_FOUND':
    case 'INVALID_TOOL_INPUT':
    case 'INVALID_EXECUTION_CONTEXT':
    case 'PERMISSION_DENIED':
    case 'APPROVAL_REQUIRED':
    case 'EXECUTION_FAILED':
    case 'EXECUTION_TIMEOUT':
    case 'EXECUTOR_UNAVAILABLE':
    case 'IDEMPOTENCY_CONFLICT':
    case 'EXECUTION_IN_PROGRESS':
      return true;
    default:
      return false;
  }
}

function isUuid(value: string | undefined): boolean {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function operationError(operation: string): Error {
  return new Error(`Unable to ${operation}. Please retry or check your workspace access.`);
}
