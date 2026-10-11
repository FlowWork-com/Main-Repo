import type { JsonValue } from './contracts';

export const MVP_TOOL_UI_METADATA = [
  {
    id: 'echo',
    name: 'Echo',
    description: 'Return a JSON value without changing it.',
    version: '1.0.0',
    exampleInput: { greeting: 'Hello, FlowWork' },
  },
  {
    id: 'file-metadata',
    name: 'File metadata',
    description: 'Read metadata for a file registered to the current task.',
    version: '1.0.0',
    exampleInput: { fileId: '55000000-0000-4000-8000-000000000001' },
  },
  {
    id: 'json-inspect',
    name: 'JSON inspect',
    description: 'Parse JSON text and report its top-level structure.',
    version: '1.0.0',
    exampleInput: { json: '{"status":"ready"}' },
  },
  {
    id: 'text-transform',
    name: 'Text transform',
    description: 'Apply a deterministic operation to a text value.',
    version: '1.0.0',
    exampleInput: { operation: 'uppercase', text: 'hello, FlowWork' },
  },
] satisfies readonly ({
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly exampleInput: JsonValue;
})[];