import {
  applyWorkflowCommand,
  type WorkflowAggregate,
} from '../workflow/workflow';
import {
  isCredentialLikeString,
  isPersistableJson,
  toolFailure,
  type JsonValue,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from '../tools/contracts';
import { ToolExecutor } from '../tools/toolExecutor';
import { ToolRegistry } from '../tools/toolRegistry';
import type { WorkflowRepository } from './workflowRepository';
import type {
  StoredToolExecution,
  ToolExecutionRepository,
} from './toolExecutionRepository';

export interface ToolExecutionRequest {
  readonly userId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: unknown;
}

export interface ToolExecutionOutcome {
  readonly result: ToolExecutionResult;
  readonly workflow: WorkflowAggregate;
}

export class ToolExecutionService {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly executionRepository: ToolExecutionRepository,
    private readonly workflowRepository: WorkflowRepository,
  ) {}

  async execute(
    request: ToolExecutionRequest,
    aggregate: WorkflowAggregate,
  ): Promise<ToolExecutionOutcome> {
    if (!request || typeof request !== 'object') {
      return unchanged(
        aggregate,
        toolFailure('INVALID_EXECUTION_CONTEXT', 'Execution request is invalid.'),
      );
    }
    const tool = this.registry.get(request.toolId, request.toolVersion);
    if (!tool) {
      return unchanged(
        aggregate,
        toolFailure('TOOL_NOT_FOUND', 'The requested tool version is not registered.'),
      );
    }

    const context = createContext(request, aggregate);
    if (!context) {
      return unchanged(
        aggregate,
        toolFailure(
          'INVALID_EXECUTION_CONTEXT',
          'Execution identity does not match the task and registered tool.',
        ),
      );
    }
    const validInput = isValidToolInput(tool, request.input);
    if (!validInput) {
      return unchanged(
        aggregate,
        toolFailure('INVALID_TOOL_INPUT', 'Tool input is invalid or unsafe to persist.'),
      );
    }
    const approvedRequestId = tool.requiresApproval
      ? recordedApprovalRequestId(aggregate)
      : null;
    if (tool.requiresApproval && !approvedRequestId) {
      return unchanged(
        aggregate,
        toolFailure(
          'APPROVAL_REQUIRED',
          'This tool requires an approved workflow request before execution.',
        ),
      );
    }

    let authorized: boolean;
    try {
      authorized = await this.executionRepository.authorize(context);
    } catch {
      return unchanged(
        aggregate,
        toolFailure(
          'EXECUTOR_UNAVAILABLE',
          'Execution authorization is temporarily unavailable.',
          true,
        ),
      );
    }
    if (!authorized) {
      return unchanged(
        aggregate,
        toolFailure('PERMISSION_DENIED', 'Workspace access is required to execute this tool.'),
      );
    }
    if (approvedRequestId) {
      let approved: boolean;
      try {
        approved = await this.executionRepository.hasApprovedRequest(
          context,
          approvedRequestId,
        );
      } catch {
        return unchanged(
          aggregate,
          toolFailure(
            'EXECUTOR_UNAVAILABLE',
            'Workflow approval could not be confirmed.',
            true,
          ),
        );
      }
      if (!approved) {
        return unchanged(
          aggregate,
          toolFailure(
            'APPROVAL_REQUIRED',
            'An approved workflow request is required.',
          ),
        );
      }
    }

    let existing: StoredToolExecution | null;
    try {
      existing = await this.executionRepository.findExecution(context);
    } catch {
      return unchanged(
        aggregate,
        toolFailure('EXECUTOR_UNAVAILABLE', 'Execution history is temporarily unavailable.', true),
      );
    }
    if (existing) {
      if (!matchesRequest(existing, request)) {
        return unchanged(
          aggregate,
          toolFailure(
            'IDEMPOTENCY_CONFLICT',
            'The request identity was already used for a different tool input.',
          ),
        );
      }
      return this.resumeStoredExecution(aggregate, context, existing);
    }

    let workflow = aggregate;
    if (workflow.task.status === 'Planning') {
      try {
        workflow = await this.applyCommand(
          workflow,
          context,
          `tool-execution:${context.executionId}:start`,
          { type: 'start' },
        );
      } catch {
        return unchanged(
          aggregate,
          toolFailure(
            'EXECUTION_FAILED',
            'The workflow could not enter the Running state.',
            true,
          ),
        );
      }
    } else if (workflow.task.status !== 'Running') {
      return unchanged(
        aggregate,
        toolFailure(
          'INVALID_EXECUTION_CONTEXT',
          'Tools can execute only while the workflow is Planning or Running.',
        ),
      );
    }

    let claimed: boolean;
    try {
      claimed = await this.executionRepository.claimExecution(context, request.input);
    } catch {
      let racedExecution: StoredToolExecution | null;
      try {
        racedExecution = await this.executionRepository.findExecution(context);
      } catch {
        return unchanged(
          workflow,
          toolFailure(
            'EXECUTOR_UNAVAILABLE',
            'Execution history is temporarily unavailable.',
            true,
          ),
        );
      }
      if (racedExecution) {
        if (matchesRequest(racedExecution, request)) {
          return this.resumeStoredExecution(workflow, context, racedExecution);
        }
        return unchanged(
          workflow,
          toolFailure(
            'IDEMPOTENCY_CONFLICT',
            'The request identity was used for different input.',
          ),
        );
      }
      return unchanged(
        workflow,
        toolFailure(
          'EXECUTOR_UNAVAILABLE',
          'Execution could not be reserved safely.',
          true,
        ),
      );
    }
    if (!claimed) {
      let racedExecution: StoredToolExecution | null;
      try {
        racedExecution = await this.executionRepository.findExecution(context);
      } catch {
        return unchanged(
          workflow,
          toolFailure(
            'EXECUTOR_UNAVAILABLE',
            'Execution history is temporarily unavailable.',
            true,
          ),
        );
      }
      if (racedExecution && matchesRequest(racedExecution, request)) {
        return this.resumeStoredExecution(workflow, context, racedExecution);
      }
      return unchanged(
        workflow,
        toolFailure(
          'IDEMPOTENCY_CONFLICT',
          'The request identity was claimed by a different execution.',
        ),
      );
    }

    let result = await this.executor.execute(tool, context, request.input);
    if (result.success && !isPersistableJson(result.output)) {
      result = toolFailure(
        'EXECUTION_FAILED',
        'Tool returned data that cannot be safely persisted.',
      );
    }

    await this.executionRepository.completeExecution(context, result);
    workflow = await this.applyResultToWorkflow(workflow, context, result);
    return { result, workflow };
  }

  private async resumeStoredExecution(
    workflow: WorkflowAggregate,
    context: ToolExecutionContext,
    execution: StoredToolExecution,
  ): Promise<ToolExecutionOutcome> {
    if (execution.status === 'running') {
      return unchanged(
        workflow,
        toolFailure(
          'EXECUTION_IN_PROGRESS',
          'This execution request is already being processed.',
          true,
        ),
      );
    }
    const result =
      execution.result ??
      toolFailure('EXECUTION_FAILED', 'The stored execution result is incomplete.');
    if (workflow.task.status === 'Running') {
      workflow = await this.applyResultToWorkflow(workflow, context, result);
    }
    return { result, workflow };
  }

  private async applyResultToWorkflow(
    aggregate: WorkflowAggregate,
    context: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<WorkflowAggregate> {
    if (result.success) {
      if (aggregate.task.status === 'Running') {
        return this.applyCommand(
          aggregate,
          context,
          `tool-execution:${context.executionId}:verify`,
          { type: 'begin-verification' },
        );
      }
      return aggregate;
    }
    if (aggregate.task.status === 'Running') {
      return this.applyCommand(
        aggregate,
        context,
        `tool-execution:${context.executionId}:fail`,
        { type: 'fail', reason: result.error.message },
      );
    }
    return aggregate;
  }

  private async applyCommand(
    aggregate: WorkflowAggregate,
    context: ToolExecutionContext,
    idempotencyKey: string,
    command:
      | { readonly type: 'start' }
      | { readonly type: 'begin-verification' }
      | {
          readonly type: 'fail';
          readonly reason: string;
        },
  ): Promise<WorkflowAggregate> {
    const common = {
      taskId: aggregate.task.id,
      tenantId: aggregate.task.tenantId,
      ownerId: aggregate.task.ownerId,
      actorId: context.userId,
      actorTenantId: aggregate.task.tenantId,
      idempotencyKey,
      expectedSequence: aggregate.events.length,
      occurredAt: new Date().toISOString(),
    };
    const next = applyWorkflowCommand(aggregate, { ...common, ...command });
    if (next !== aggregate) {
      await this.workflowRepository.persistEvents(aggregate, next);
    }
    return next;
  }
}

function createContext(
  request: ToolExecutionRequest,
  aggregate: WorkflowAggregate,
): ToolExecutionContext | null {
  if (
    typeof request.userId !== 'string' ||
    !request.userId.trim() ||
    typeof request.workspaceId !== 'string' ||
    request.workspaceId !== aggregate.task.tenantId ||
    typeof request.taskId !== 'string' ||
    request.taskId !== aggregate.task.id ||
    typeof request.executionId !== 'string' ||
    !isUuid(request.executionId) ||
    typeof request.requestId !== 'string' ||
    !request.requestId.trim() ||
    request.requestId.length > 200 ||
    isCredentialLikeString(request.requestId) ||
    typeof request.toolId !== 'string' ||
    !request.toolId.trim() ||
    typeof request.toolVersion !== 'string' ||
    !request.toolVersion.trim()
  ) {
    return null;
  }
  return {
    userId: request.userId,
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    executionId: request.executionId,
    toolId: request.toolId,
    toolVersion: request.toolVersion,
    requestId: request.requestId,
    signal: new AbortController().signal,
  };
}

function isValidToolInput(tool: ToolDefinition, input: unknown): boolean {
  try {
    return isPersistableJson(input) && tool.validateInput(input);
  } catch {
    return false;
  }
}

function recordedApprovalRequestId(
  aggregate: WorkflowAggregate,
): string | null {
  const request = [...aggregate.events]
    .reverse()
    .find((event) => event.type === 'approval.requested');
  if (!request || request.type !== 'approval.requested') return null;
  const approved = aggregate.events.some(
    (event) =>
      event.type === 'approval.recorded' &&
      event.result.requestId === request.requestId &&
      event.result.decision === 'approved',
  );
  return approved ? request.requestId : null;
}

function matchesRequest(
  stored: StoredToolExecution,
  request: ToolExecutionRequest,
): boolean {
  if (!isPersistableJson(stored.input) || !isPersistableJson(request.input)) return false;
  return (
    stored.requestedBy === request.userId &&
    stored.executionId === request.executionId &&
    stored.requestId === request.requestId &&
    stored.toolId === request.toolId &&
    stored.toolVersion === request.toolVersion &&
    canonicalJson(stored.input) === canonicalJson(request.input)
  );
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function unchanged(
  workflow: WorkflowAggregate,
  result: ToolExecutionResult,
): ToolExecutionOutcome {
  return { result, workflow };
}
