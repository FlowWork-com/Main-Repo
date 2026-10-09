import {
  isCredentialLikeString,
  isPersistableJson,
  toolFailure,
  type ToolExecutionError,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolEvidence,
} from './contracts';

export class ToolExecutor {
  constructor(private readonly timeoutMs = 5_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Tool execution timeout must be a positive number.');
    }
  }

  async execute(
    tool: ToolDefinition,
    context: ToolExecutionContext,
    input: unknown,
  ): Promise<ToolExecutionResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutSignal = new Promise<ToolExecutionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          toolFailure(
            'EXECUTION_TIMEOUT',
            'Tool execution exceeded its time limit.',
            true,
          ),
        );
      }, this.timeoutMs);
    });

    try {
      const execution = Promise.resolve().then(() =>
        tool.execute({ ...context, signal: controller.signal }, input),
      );
      const result = await Promise.race([execution, timeoutSignal]);
      if (result?.success === true) {
        if (!isPersistableJson(result.output) || !isValidEvidence(result.evidence)) {
          return toolFailure(
            'EXECUTION_FAILED',
            'Tool returned data that cannot be safely persisted.',
          );
        }
        return {
          success: true,
          output: result.output,
          ...(result.evidence ? { evidence: sanitizeEvidence(result.evidence) } : {}),
        };
      }
      if (result?.success === false && isValidError(result.error)) {
        return {
          success: false,
          error: sanitizeError(result.error),
        };
      }
      return toolFailure('EXECUTION_FAILED', 'Tool returned an invalid execution result.');
    } catch {
      return toolFailure('EXECUTION_FAILED', 'Tool execution failed.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

}

const errorCodes: readonly ToolExecutionError['code'][] = [
  'TOOL_NOT_FOUND',
  'INVALID_TOOL_INPUT',
  'INVALID_EXECUTION_CONTEXT',
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'EXECUTION_FAILED',
  'EXECUTION_TIMEOUT',
  'EXECUTOR_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
  'EXECUTION_IN_PROGRESS',
];

const safeErrorMessages: Readonly<Record<ToolExecutionError['code'], string>> = {
  TOOL_NOT_FOUND: 'The requested tool version is not registered.',
  INVALID_TOOL_INPUT: 'Tool input is invalid.',
  INVALID_EXECUTION_CONTEXT: 'Execution context is invalid.',
  PERMISSION_DENIED: 'Workspace access is required.',
  APPROVAL_REQUIRED: 'An approved workflow request is required.',
  EXECUTION_FAILED: 'Tool execution failed.',
  EXECUTION_TIMEOUT: 'Tool execution exceeded its time limit.',
  EXECUTOR_UNAVAILABLE: 'Tool execution is temporarily unavailable.',
  IDEMPOTENCY_CONFLICT: 'The request identity was used for different input.',
  EXECUTION_IN_PROGRESS: 'This execution request is already being processed.',
};

function isValidError(value: unknown): value is ToolExecutionError {
  const error = asRecord(value);
  return Boolean(
    error &&
      typeof error.code === 'string' &&
      errorCodes.some((code) => code === error.code) &&
      typeof error.message === 'string' &&
      error.message.trim().length > 0 &&
      error.message.length <= 300 &&
      typeof error.retryable === 'boolean',
  );
}

function sanitizeError(error: ToolExecutionError): ToolExecutionError {
  return {
    code: error.code,
    message: safeErrorMessages[error.code],
    retryable: error.code === 'EXECUTION_TIMEOUT' || error.retryable,
  };
}

function isValidEvidence(value: unknown): value is ToolEvidence | undefined {
  if (value === undefined) return true;
  const evidence = asRecord(value);
  return Boolean(
    evidence &&
      typeof evidence.type === 'string' &&
      evidence.type.trim().length > 0 &&
      evidence.type.length <= 100 &&
      !isCredentialLikeString(evidence.type) &&
      typeof evidence.reference === 'string' &&
      evidence.reference.trim().length > 0 &&
      evidence.reference.length <= 500 &&
      !isCredentialLikeString(evidence.reference) &&
      (evidence.summary === undefined ||
        (typeof evidence.summary === 'string' &&
          evidence.summary.length <= 500 &&
          !isCredentialLikeString(evidence.summary))),
  );
}

function sanitizeEvidence(evidence: ToolEvidence): ToolEvidence {
  return {
    type: evidence.type,
    reference: evidence.reference,
    ...(evidence.summary === undefined ? {} : { summary: evidence.summary }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
