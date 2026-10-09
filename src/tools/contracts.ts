export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'destructive';

export type ToolExecutionErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_TOOL_INPUT'
  | 'INVALID_EXECUTION_CONTEXT'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTOR_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXECUTION_IN_PROGRESS';

export interface ToolExecutionError {
  readonly code: ToolExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolEvidence {
  readonly type: string;
  readonly reference: string;
  readonly summary?: string;
}

export type ToolExecutionResult =
  | {
      readonly success: true;
      readonly output: JsonValue;
      readonly evidence?: ToolEvidence;
    }
  | {
      readonly success: false;
      readonly error: ToolExecutionError;
    };

export interface ToolExecutionContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface ToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: ToolRiskLevel;
  readonly requiresApproval: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly validateInput: (input: unknown) => boolean;
  readonly execute: (
    context: ToolExecutionContext,
    input: unknown,
  ) => Promise<ToolExecutionResult>;
}

export interface ToolMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: ToolRiskLevel;
  readonly requiresApproval: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export function toToolMetadata(tool: ToolDefinition): ToolMetadata {
  return Object.freeze({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    riskLevel: tool.riskLevel,
    requiresApproval: tool.requiresApproval,
    inputSchema: tool.inputSchema,
  });
}

export function toolFailure(
  code: ToolExecutionErrorCode,
  message: string,
  retryable = false,
): ToolExecutionResult {
  return {
    success: false,
    error: { code, message, retryable },
  };
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= 32_768 && !isCredentialLikeString(value);
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  return isSafeJsonObject(value, depth);
}

export function isPersistableJson(value: unknown): value is JsonValue {
  if (!isJsonValue(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= 32_768
    );
  } catch {
    return false;
  }
}

export function isSensitiveFieldName(key: string): boolean {
  return /(?:password|secret|token|credential|authorization|service.?role|api.?key)/i.test(
    key,
  );
}

export function isCredentialLikeString(value: string): boolean {
  return /(?:\bbearer\s+[a-z0-9._~+/-]{8,}|(?:sk|pk|rk)_live_[a-z0-9]{8,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,}|akia[a-z0-9]{16}|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|-----begin [a-z ]*private key-----)/i.test(
    value,
  );
}

function isSafeJsonObject(value: object, depth: number): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (
        prototype !== Array.prototype ||
        value.length > 4_096 ||
        Object.getOwnPropertySymbols(value).length
      ) {
        return false;
      }
      const array = value as unknown[];
      for (let index = 0; index < array.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
        if (
          descriptor &&
          (!('value' in descriptor) || !isJsonValue(descriptor.value, depth + 1))
        ) {
          return false;
        }
      }
      return Object.keys(array).every(
        (key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < array.length,
      );
    }
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length
    ) {
      return false;
    }
    const keys = Object.keys(value);
    if (keys.length > 4_096) return false;
    return keys.every((key) => {
      if (key.length > 32_768 || isSensitiveFieldName(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor &&
          'value' in descriptor &&
          isJsonValue(descriptor.value, depth + 1),
      );
    });
  } catch {
    return false;
  }
}
