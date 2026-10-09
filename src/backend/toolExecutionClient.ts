import {
  isPersistableJson,
  type ToolExecutionError,
  type ToolExecutionResult,
} from '../tools/contracts';
import {
  WORKFLOW_STATUSES,
  type WorkflowStatus,
} from '../workflow/workflow';

export interface ExecuteToolRequest {
  readonly taskId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: unknown;
}

export interface ExecuteToolResponse {
  readonly result: ToolExecutionResult;
  readonly workflowStatus: WorkflowStatus;
}

export interface ToolExecutionFunctionInvoker {
  invoke(
    functionName: string,
    options: { readonly body: ExecuteToolRequest },
  ): Promise<{ readonly data: unknown; readonly error: unknown | null }>;
}

export async function executeTool(
  client: { readonly functions: ToolExecutionFunctionInvoker },
  request: ExecuteToolRequest,
): Promise<ExecuteToolResponse> {
  const { data, error } = await client.functions.invoke('execute-tool', {
    body: request,
  });
  if (error) throw new Error('Unable to execute this tool. Please retry.');
  if (!isExecuteToolResponse(data)) {
    throw new Error('The tool execution service returned an invalid response.');
  }
  return data;
}

function isExecuteToolResponse(value: unknown): value is ExecuteToolResponse {
  if (!isRecord(value) || !isWorkflowStatus(value.workflowStatus)) {
    return false;
  }
  const result = value.result;
  if (!isRecord(result) || typeof result.success !== 'boolean') return false;
  if (result.success) return 'output' in result && isPersistableJson(result.output);
  const error = result.error;
  return (
    isRecord(error) &&
    isExecutionErrorCode(error.code) &&
    typeof error.message === 'string' &&
    error.message.length > 0 &&
    error.message.length <= 300 &&
    typeof error.retryable === 'boolean'
  );
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' &&
    WORKFLOW_STATUSES.some((status) => status === value);
}

function isExecutionErrorCode(value: unknown): value is ToolExecutionError['code'] {
  return (
    value === 'TOOL_NOT_FOUND' ||
    value === 'INVALID_TOOL_INPUT' ||
    value === 'INVALID_EXECUTION_CONTEXT' ||
    value === 'PERMISSION_DENIED' ||
    value === 'APPROVAL_REQUIRED' ||
    value === 'EXECUTION_FAILED' ||
    value === 'EXECUTION_TIMEOUT' ||
    value === 'EXECUTOR_UNAVAILABLE' ||
    value === 'IDEMPOTENCY_CONFLICT' ||
    value === 'EXECUTION_IN_PROGRESS'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
