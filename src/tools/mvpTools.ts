import {
  isJsonValue,
  toolFailure,
  type JsonValue,
  type ToolDefinition,
  type ToolExecutionContext,
} from './contracts';

export interface TaskFileMetadata {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string | null;
  readonly createdAt: string;
}

export interface TaskFileMetadataSource {
  getTaskFileMetadata(
    context: ToolExecutionContext,
    fileId: string,
  ): Promise<TaskFileMetadata | null>;
}

const safeToolProperties = {
  riskLevel: 'low',
  requiresApproval: false,
} as const;

const echo: ToolDefinition = {
  id: 'echo',
  name: 'Echo',
  description: 'Return a JSON value without changing it.',
  version: '1.0.0',
  ...safeToolProperties,
  inputSchema: { type: 'any-json-value' },
  validateInput: isJsonValue,
  async execute(_context, input) {
    if (!isJsonValue(input)) {
      return toolFailure('INVALID_TOOL_INPUT', 'Input must be a JSON value.');
    }
    return { success: true, output: { value: input } };
  },
};

type TextTransformInput =
  | { readonly operation: 'uppercase' | 'lowercase' | 'trim'; readonly text: string }
  | {
      readonly operation: 'replace';
      readonly text: string;
      readonly search: string;
      readonly replacement: string;
    }
  | {
      readonly operation: 'extract';
      readonly text: string;
      readonly start: number;
      readonly end: number;
    };

function isTextTransformInput(value: unknown): value is TextTransformInput {
  if (!isPlainObject(value) || typeof value.text !== 'string') return false;
  switch (value.operation) {
    case 'uppercase':
    case 'lowercase':
    case 'trim':
      return Object.keys(value).every((key) => ['operation', 'text'].includes(key));
    case 'replace':
      return (
        typeof value.search === 'string' &&
        value.search.length > 0 &&
        typeof value.replacement === 'string' &&
        Object.keys(value).every((key) =>
          ['operation', 'text', 'search', 'replacement'].includes(key),
        )
      );
    case 'extract':
      return (
        Number.isInteger(value.start) &&
        Number.isInteger(value.end) &&
        (value.start as number) >= 0 &&
        (value.end as number) >= (value.start as number) &&
        Object.keys(value).every((key) =>
          ['operation', 'text', 'start', 'end'].includes(key),
        )
      );
    default:
      return false;
  }
}

const textTransform: ToolDefinition = {
  id: 'text-transform',
  name: 'Text transform',
  description: 'Apply a deterministic operation to a text value.',
  version: '1.0.0',
  ...safeToolProperties,
  inputSchema: {
    type: 'object',
    operations: ['uppercase', 'lowercase', 'trim', 'replace', 'extract'],
  },
  validateInput: isTextTransformInput,
  async execute(_context, input) {
    if (!isTextTransformInput(input)) {
      return toolFailure('INVALID_TOOL_INPUT', 'Input is not a valid text transform request.');
    }
    switch (input.operation) {
      case 'uppercase':
        return { success: true, output: { text: input.text.toUpperCase() } };
      case 'lowercase':
        return { success: true, output: { text: input.text.toLowerCase() } };
      case 'trim':
        return { success: true, output: { text: input.text.trim() } };
      case 'replace':
        return {
          success: true,
          output: { text: input.text.replaceAll(input.search, input.replacement) },
        };
      case 'extract':
        return {
          success: true,
          output: { text: input.text.slice(input.start, input.end) },
        };
    }
  },
};

interface JsonInspectInput {
  readonly json: string;
}

function isJsonInspectInput(value: unknown): value is JsonInspectInput {
  return (
    isPlainObject(value) &&
    typeof value.json === 'string' &&
    Object.keys(value).length === 1
  );
}

const jsonInspect: ToolDefinition = {
  id: 'json-inspect',
  name: 'JSON inspect',
  description: 'Parse JSON text and report its top-level structure.',
  version: '1.0.0',
  ...safeToolProperties,
  inputSchema: { type: 'object', required: ['json'], properties: { json: { type: 'string' } } },
  validateInput: isJsonInspectInput,
  async execute(_context, input) {
    if (!isJsonInspectInput(input)) {
      return toolFailure('INVALID_TOOL_INPUT', 'Input must contain JSON text.');
    }
    let value: unknown;
    try {
      value = JSON.parse(input.json);
    } catch {
      return toolFailure('INVALID_TOOL_INPUT', 'Input is not valid JSON.');
    }
    if (!isJsonValue(value)) {
      return toolFailure('INVALID_TOOL_INPUT', 'JSON contains unsupported values.');
    }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const output: Record<string, JsonValue> = { type };
    if (Array.isArray(value)) output.length = value.length;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output.keys = Object.keys(value).sort();
    }
    return { success: true, output };
  },
};

interface FileMetadataInput {
  readonly fileId: string;
}

function isFileMetadataInput(value: unknown): value is FileMetadataInput {
  return (
    isPlainObject(value) &&
    typeof value.fileId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.fileId,
    ) &&
    Object.keys(value).length === 1
  );
}

export function createFileMetadataTool(
  source: TaskFileMetadataSource,
): ToolDefinition {
  return {
    id: 'file-metadata',
    name: 'File metadata',
    description: 'Read metadata for a file registered to the current task.',
    version: '1.0.0',
    ...safeToolProperties,
    inputSchema: {
      type: 'object',
      required: ['fileId'],
      properties: { fileId: { type: 'string', format: 'uuid' } },
    },
    validateInput: isFileMetadataInput,
    async execute(context, input) {
      if (!isFileMetadataInput(input)) {
        return toolFailure('INVALID_TOOL_INPUT', 'Input must identify a registered task file.');
      }
      const file = await source.getTaskFileMetadata(context, input.fileId);
      if (!file) {
        return toolFailure('INVALID_TOOL_INPUT', 'Task file was not found.');
      }
      return {
        success: true,
        output: {
          id: file.id,
          fileName: file.fileName,
          contentType: file.contentType,
          createdAt: file.createdAt,
        },
        evidence: {
          type: 'task-file-metadata',
          reference: file.id,
          summary: `Metadata for ${file.fileName}`,
        },
      };
    },
  };
}

export function createMvpTools(
  fileMetadataSource: TaskFileMetadataSource,
): readonly ToolDefinition[] {
  return [echo, textTransform, jsonInspect, createFileMetadataTool(fileMetadataSource)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
