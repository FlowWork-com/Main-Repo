import type { JsonValue } from './contracts';

interface ToolUiMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly exampleInput: JsonValue;
}

export const MVP_PLANNER_TOOL_UI_METADATA: readonly ToolUiMetadata[] = [
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
];

/** Tools exposed to the manual execution UI. New capabilities must be added to the planner catalogue separately. */
export const MVP_TOOL_UI_METADATA: readonly ToolUiMetadata[] = [
  ...MVP_PLANNER_TOOL_UI_METADATA.slice(0, 2),
  {
    id: 'invoice-csv-review',
    name: 'Invoice CSV review',
    description: 'Read an attached CSV/TSV invoice table and summarize totals by currency, with flagged rows for human review. Does not edit or send data.',
    version: '1.0.0',
    exampleInput: { fileId: '55000000-0000-4000-8000-000000000001' },
  },
  ...MVP_PLANNER_TOOL_UI_METADATA.slice(2),
];
