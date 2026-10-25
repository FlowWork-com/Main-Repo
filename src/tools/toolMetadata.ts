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
  {
    id: 'invoice-csv-review',
    name: 'Invoice and spreadsheet review',
    description: 'Review an attached CSV, TSV, XLS, or XLSX invoice table. Summarizes totals by currency and flags rows for human review. Does not edit or send data.',
    version: '1.0.0',
    exampleInput: { fileId: '55000000-0000-4000-8000-000000000001' },
  },
  {
    id: 'invoice-document-extract',
    name: 'PDF/image invoice extraction',
    description: 'Extract invoice fields from an attached PDF or image using the configured external vision provider. Returns field-level model-estimated confidence and validation warnings. Always requires human review and approval before document transfer.',
    version: '1.0.0',
    exampleInput: { fileId: '55000000-0000-4000-8000-000000000001' },
  },
];

/** Tools available to both the planner and the manual execution UI. */
export const MVP_TOOL_UI_METADATA: readonly ToolUiMetadata[] = [
  ...MVP_PLANNER_TOOL_UI_METADATA,
  {
    id: 'finnlp-company-news',
    name: 'FinNLP company news',
    description: 'Read up to 20 sourced company-news articles for a ticker and date range of at most 31 days. Results are untrusted news evidence, not investment advice.',
    version: '1.0.0',
    exampleInput: {
      ticker: 'AAPL',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    },
  },
];
