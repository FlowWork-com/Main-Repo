import {
  toolFailure,
  type JsonValue,
  type ToolDefinition,
  type ToolExecutionContext,
} from './contracts';
import type { TaskFileContent, TaskFileContentSource } from './mvpTools';
import { MVP_TOOL_UI_METADATA } from './toolMetadata';

const metadata = (() => {
  const selected = MVP_TOOL_UI_METADATA.find((tool) => tool.id === 'invoice-document-extract');
  if (!selected) throw new Error('Invoice document extraction metadata is missing.');
  return selected;
})();

export const MAX_INVOICE_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const FIELD_REVIEW_CONFIDENCE_THRESHOLD = 0.8;

export interface InvoiceDocumentExtractionField<T> {
  readonly value: T | null;
  /** Model-reported estimate, not an empirically calibrated probability. */
  readonly confidenceEstimate: number;
  readonly needsReview: boolean;
}

export interface InvoiceDocumentExtractionReport {
  readonly fileId: string;
  readonly fileName: string;
  readonly sourceFormat: 'pdf' | 'jpg' | 'jpeg' | 'png';
  readonly reviewRequired: true;
  readonly validationStatus: 'needs_review' | 'insufficient_data';
  readonly fields: {
    readonly invoiceNumber: InvoiceDocumentExtractionField<string>;
    readonly invoiceDate: InvoiceDocumentExtractionField<string>;
    readonly vendor: InvoiceDocumentExtractionField<string>;
    readonly description: InvoiceDocumentExtractionField<string>;
    readonly currency: InvoiceDocumentExtractionField<string>;
    readonly subtotal: InvoiceDocumentExtractionField<number>;
    readonly taxAmount: InvoiceDocumentExtractionField<number>;
    readonly totalAmount: InvoiceDocumentExtractionField<number>;
  };
  readonly warnings: readonly string[];
  readonly interpretationNotes: readonly string[];
}

export type InvoiceDocumentExtractor = (file: TaskFileContent, signal?: AbortSignal) => Promise<unknown>;

type FieldKind = 'string' | 'number';

const FIELD_SPEC = [
  ['invoiceNumber', 'Invoice number', 'string'],
  ['invoiceDate', 'Invoice date', 'string'],
  ['vendor', 'Vendor or supplier name', 'string'],
  ['description', 'Concise invoice description', 'string'],
  ['currency', 'ISO 4217 currency code', 'string'],
  ['subtotal', 'Subtotal before tax', 'number'],
  ['taxAmount', 'Total tax amount', 'number'],
  ['totalAmount', 'Grand total payable, not subtotal or balance due', 'number'],
] as const satisfies readonly (readonly [string, string, FieldKind])[];

export function createInvoiceDocumentExtractionTool(
  source?: TaskFileContentSource,
  extractor?: InvoiceDocumentExtractor,
): ToolDefinition {
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    riskLevel: 'high',
    // Document bytes are sent to an externally configured model. The existing execution
    // approval gate must run before that transfer is allowed.
    requiresApproval: true,
    inputSchema: {
      type: 'object',
      required: ['fileId'],
      properties: { fileId: { type: 'string', format: 'uuid' } },
    },
    validateInput: isInvoiceDocumentInput,
    async execute(context: ToolExecutionContext, input: unknown) {
      if (!isInvoiceDocumentInput(input)) {
        return toolFailure('INVALID_TOOL_INPUT', 'Input must identify a registered PDF or image attachment.');
      }
      if (!source) {
        return toolFailure('EXECUTOR_UNAVAILABLE', 'Invoice document access is unavailable in this environment.', true);
      }
      if (!extractor) {
        return toolFailure(
          'EXECUTOR_UNAVAILABLE',
          'Invoice extraction is not configured. Set the server-side FLOWWORK_INVOICE_PROVIDER, FLOWWORK_INVOICE_BASE_URL, FLOWWORK_INVOICE_MODEL, and FLOWWORK_INVOICE_API_KEY secrets.',
        );
      }

      let file: TaskFileContent | null;
      try {
        file = await source.getTaskFileContent(context, input.fileId);
      } catch {
        return toolFailure('EXECUTOR_UNAVAILABLE', 'The attachment could not be read securely. Please retry.', true);
      }
      if (!file || file.id !== input.fileId) {
        return toolFailure('INVALID_TOOL_INPUT', 'Choose a PDF, JPG, JPEG, or PNG file registered to this workflow.');
      }

      const validationError = validateInvoiceDocumentBytes(file);
      if (validationError) {
        return toolFailure('INVALID_TOOL_INPUT', validationError);
      }

      let extracted: unknown;
      try {
        extracted = await extractor(file, context.signal);
      } catch {
        return toolFailure(
          'EXECUTOR_UNAVAILABLE',
          'The invoice extraction provider could not process this document. Check the server-side provider configuration and retry.',
          true,
        );
      }

      try {
        const report = normalizeInvoiceExtraction(file, extracted);
        const output: JsonValue = report as unknown as JsonValue;
        return {
          success: true,
          output,
          evidence: {
            type: 'invoice-document-extraction',
            reference: file.id,
            summary: `Extracted invoice fields from ${file.fileName}; human review is required.`,
          },
        };
      } catch {
        return toolFailure('EXECUTOR_UNAVAILABLE', 'The extraction provider returned an invalid response. Please retry.', true);
      }
    },
  };
}

export function validateInvoiceDocumentBytes(file: TaskFileContent): string | null {
  const extension = getExtension(file.fileName);
  const expectedMime = mimeForExtension(extension);
  if (!expectedMime || file.contentType.toLowerCase() !== expectedMime) {
    return 'The attachment must be a PDF, JPG, JPEG, or PNG with a matching file type.';
  }
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_INVOICE_DOCUMENT_BYTES) {
    return 'Invoice documents must be between 1 byte and 10 MB.';
  }

  if (extension === 'pdf' && !startsWith(file.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'The file contents do not match a PDF document.';
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    if (!startsWith(file.bytes, [0xff, 0xd8, 0xff])) {
      return 'The file contents do not match a JPEG image.';
    }
  }
  if (extension === 'png' && !startsWith(file.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'The file contents do not match a PNG image.';
  }
  return null;
}

export function normalizeInvoiceExtraction(
  file: TaskFileContent,
  raw: unknown,
): InvoiceDocumentExtractionReport {
  if (!isRecord(raw)) throw new Error('Invalid extraction response.');
  const fields: Record<string, InvoiceDocumentExtractionField<string | number>> = {};
  const warnings: string[] = [];

  for (const [key, label, kind] of FIELD_SPEC) {
    const candidate = raw[key];
    let value: string | number | null = null;
    let confidenceEstimate = 0;

    if (isRecord(candidate)) {
      confidenceEstimate = typeof candidate.confidence === 'number' &&
        Number.isFinite(candidate.confidence) &&
        candidate.confidence >= 0 &&
        candidate.confidence <= 1
        ? candidate.confidence
        : 0;

      if (kind === 'string' && (typeof candidate.value === 'string' || candidate.value === null)) {
        const trimmed = typeof candidate.value === 'string' ? candidate.value.trim() : '';
        value = trimmed ? clip(trimmed, 500) : null;
      } else if (
        kind === 'number' &&
        (typeof candidate.value === 'number' || candidate.value === null)
      ) {
        value = typeof candidate.value === 'number' &&
          Number.isFinite(candidate.value) &&
          Math.abs(candidate.value) <= 1_000_000_000_000
          ? roundMoney(candidate.value)
          : null;
      }
    }

    const needsReview = value === null || confidenceEstimate < FIELD_REVIEW_CONFIDENCE_THRESHOLD;
    fields[key] = { value, confidenceEstimate, needsReview };
    if (value === null) warnings.push(`${label} is missing or could not be read.`);
    else if (confidenceEstimate < FIELD_REVIEW_CONFIDENCE_THRESHOLD) {
      warnings.push(`${label} has low model-estimated confidence (${confidenceEstimate.toFixed(2)}).`);
    }
    if (candidate !== undefined && !isRecord(candidate)) {
      warnings.push(`${label} response format was invalid; review this field.`);
    }
  }

  const invoiceDate = fields['invoiceDate'] as InvoiceDocumentExtractionField<string>;
  if (invoiceDate.value && !isValidIsoDate(invoiceDate.value)) {
    warnings.push('Invoice date is not a valid YYYY-MM-DD date.');
    fields['invoiceDate'] = { ...invoiceDate, needsReview: true };
  }

  const currency = fields['currency'] as InvoiceDocumentExtractionField<string>;
  if (currency.value) {
    const normalized = currency.value.toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
      warnings.push('Currency is not a three-letter ISO-style code.');
      fields['currency'] = { ...currency, value: normalized, needsReview: true };
    } else {
      fields['currency'] = { ...currency, value: normalized };
    }
  }

  const subtotal = fields['subtotal'] as InvoiceDocumentExtractionField<number>;
  const taxAmount = fields['taxAmount'] as InvoiceDocumentExtractionField<number>;
  const totalAmount = fields['totalAmount'] as InvoiceDocumentExtractionField<number>;
  if (subtotal.value !== null && taxAmount.value !== null && totalAmount.value !== null) {
    const expectedTotal = subtotal.value + taxAmount.value;
    const tolerance = Math.max(1, Math.abs(totalAmount.value) * 0.01);
    if (Math.abs(expectedTotal - totalAmount.value) > tolerance) {
      warnings.push('Subtotal plus tax does not match the grand total within the 1% or one-unit tolerance.');
      fields['subtotal'] = { ...subtotal, needsReview: true };
      fields['taxAmount'] = { ...taxAmount, needsReview: true };
      fields['totalAmount'] = { ...totalAmount, needsReview: true };
    }
  }

  const requiredKeys = ['invoiceNumber', 'invoiceDate', 'vendor', 'totalAmount'];
  const availableRequiredFields = requiredKeys.filter((key) => fields[key]?.value !== null).length;
  const validationStatus = availableRequiredFields < 2
    ? 'insufficient_data'
    : 'needs_review';

  if (!warnings.length) warnings.push('No automated validation warnings were detected, but a human must still verify all extracted fields.');
  const extension = getExtension(file.fileName) as InvoiceDocumentExtractionReport['sourceFormat'];

  return {
    fileId: file.id,
    fileName: clip(file.fileName, 180),
    sourceFormat: extension,
    reviewRequired: true,
    validationStatus,
    fields: fields as InvoiceDocumentExtractionReport['fields'],
    warnings,
    interpretationNotes: [
      'Field confidence values are estimates reported by the model. They have not been calibrated against a labeled evaluation set and are not verified probabilities.',
      'Every result requires human review. This tool does not write to invoice records, create output files, send messages, or execute follow-up actions.',
      'The configured external model receives the original private document for processing. Do not run this tool unless the task owner has approved that data transfer.',
      'Numeric validation checks consistency only; it does not prove that extracted values match the source document.',
    ],
  };
}

function isInvoiceDocumentInput(value: unknown): value is { readonly fileId: string } {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.fileId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.fileId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index + 1).toLowerCase();
}

function mimeForExtension(extension: string): string | null {
  switch (extension) {
    case 'pdf': return 'application/pdf';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    default: return null;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
