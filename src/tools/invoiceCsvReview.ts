import { toolFailure, type JsonValue, type ToolDefinition, type ToolExecutionContext } from './contracts';
import type { TaskFileContentSource } from './mvpTools';
import { MVP_TOOL_UI_METADATA } from './toolMetadata';

const metadata = (() => {
  const selected = MVP_TOOL_UI_METADATA.find((tool) => tool.id === 'invoice-csv-review');
  if (!selected) throw new Error('Invoice CSV review metadata is missing.');
  return selected;
})();

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DATA_ROWS = 2500;
const MAX_COLUMNS = 100;
const MAX_CELL_CHARS = 10_000;
const MAX_PREVIEW_ROWS = 12;
const MAX_CURRENCY_GROUPS = 25;

export interface InvoiceCsvReviewReport {
  readonly fileName: string;
  readonly delimiter: 'comma' | 'tab';
  readonly rowsRead: number;
  readonly rowsWithUsableAmounts: number;
  readonly rowsIncludedInCurrencyTotals: number;
  readonly distinctVendors: number;
  readonly currencies: readonly string[];
  readonly totalsByCurrency: readonly {
    readonly currency: string;
    readonly amount: number;
    readonly rows: number;
  }[];
  readonly unassignedCurrencyRows: number;
  readonly flaggedRowCount: number;
  readonly totalIssues: number;
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly invoiceNumber: string;
    readonly vendor: string;
    readonly date: string;
    readonly amount: number | null;
    readonly currency: string;
    readonly issues: readonly string[];
  }[];
  readonly omittedFlaggedRows: number;
  readonly headerWarnings: readonly string[];
  readonly interpretationNotes: readonly string[];
}

interface AmountResult {
  readonly value: number | null;
  readonly ambiguous: boolean;
}

interface ColumnMap {
  readonly invoiceNumber: number;
  readonly vendor: number;
  readonly date: number;
  readonly amount: number;
  readonly currency: number;
  readonly description: number;
}

interface ReviewRow {
  readonly sourceRow: number;
  readonly invoiceNumber: string;
  readonly vendor: string;
  readonly date: string;
  readonly amount: number | null;
  readonly currency: string;
  readonly issues: string[];
}

const HEADER_ALIASES = {
  invoiceNumber: ['invoicenumber', 'invoiceno', 'invoicenum', 'invoiceid', 'invno', 'invoice'],
  vendor: ['vendor', 'supplier', 'vendorname', 'suppliername', 'merchant', 'seller'],
  date: ['invoicedate', 'date'],
  amount: ['grandtotal', 'totalamount', 'invoicetotal', 'payableamount', 'invoiceamount', 'amount', 'total', 'price'],
  currency: ['currency', 'currencycode', 'originalcurrency', 'originalcurrencycode'],
  description: ['description', 'itemdescription', 'details', 'item', 'product'],
} as const;

export function createInvoiceCsvReviewTool(
  source?: TaskFileContentSource,
): ToolDefinition {
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      required: ['fileId'],
      properties: { fileId: { type: 'string', format: 'uuid' } },
    },
    validateInput: isInvoiceCsvReviewInput,
    async execute(context: ToolExecutionContext, input: unknown) {
      if (!isInvoiceCsvReviewInput(input)) {
        return toolFailure('INVALID_TOOL_INPUT', 'Input must identify a registered CSV or TSV attachment.');
      }
      if (!source) {
        return toolFailure('EXECUTOR_UNAVAILABLE', 'Invoice CSV review is not available in this environment.', true);
      }
      let file;
      try {
        file = await source.getTaskFileContent(context, input.fileId);
      } catch {
        return toolFailure('EXECUTOR_UNAVAILABLE', 'The attachment could not be read securely. Please retry.', true);
      }
      if (!file) {
        return toolFailure('INVALID_TOOL_INPUT', 'Choose a CSV or TSV attachment registered to this workflow.');
      }
      const expectedContentType = file.fileName.toLowerCase().endsWith('.csv')
        ? 'text/csv'
        : file.fileName.toLowerCase().endsWith('.tsv')
        ? 'text/tab-separated-values'
        : null;
      if (file.id !== input.fileId || !expectedContentType || file.contentType !== expectedContentType) {
        return toolFailure('INVALID_TOOL_INPUT', 'The attachment is not a supported CSV/TSV file registered to this workflow.');
      }
      try {
        const report = reviewInvoiceCsv(file.text, file.fileName);
        const output: JsonValue = {
          fileId: file.id,
          ...report,
        } as unknown as JsonValue;
        return {
          success: true,
          output,
          evidence: {
            type: 'invoice-csv-review',
            reference: file.id,
            summary: `Reviewed ${report.rowsRead} rows from ${file.fileName}; ${report.flaggedRowCount} rows need review.`,
          },
        };
      } catch (error) {
        return toolFailure(
          'INVALID_TOOL_INPUT',
          error instanceof Error ? error.message : 'The CSV or TSV could not be reviewed safely.',
        );
      }
    },
  };
}

export function reviewInvoiceCsv(text: string, fileName: string): InvoiceCsvReviewReport {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension !== 'csv' && extension !== 'tsv') {
    throw new Error('Invoice review currently supports CSV and TSV attachments only.');
  }
  if (!text || text.trim().length === 0) throw new Error('The attached file is empty.');
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new Error('The attached text exceeds the 10 MB review limit.');
  }
  if (text.includes('\u0000')) throw new Error('The attached file is not valid UTF-8 text.');

  const delimiter = extension === 'tsv' ? '\t' : ',';
  const rows = parseDelimitedText(text.replace(/^\uFEFF/, ''), delimiter);
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.trim() !== ''));
  if (headerIndex < 0) throw new Error('No header row was found in the attached file.');
  const headers = rows[headerIndex] ?? [];
  const columns = resolveColumns(headers);
  if (columns.amount < 0) {
    throw new Error('No amount column found. Add a column such as Amount, Total, Grand Total, or Invoice Total.');
  }
  if (columns.invoiceNumber < 0 && columns.vendor < 0 && columns.date < 0 && columns.description < 0) {
    throw new Error('This file does not contain enough invoice-related columns for a safe review.');
  }

  const headerWarnings: string[] = [];
  if (columns.invoiceNumber < 0) headerWarnings.push('Invoice number column not detected.');
  if (columns.vendor < 0) headerWarnings.push('Vendor column not detected.');
  if (columns.date < 0) headerWarnings.push('Invoice date column not detected.');
  if (columns.currency < 0) headerWarnings.push('Currency column not detected; amounts without an ISO currency code are excluded from currency totals.');
  const seenInvoiceNumbers = new Map<string, number>();
  const seenRows = new Map<string, number>();
  const vendors = new Set<string>();
  const totals = new Map<string, { amount: number; rows: number }>();
  const reviewRows: ReviewRow[] = [];
  let rowsWithUsableAmounts = 0;
  let rowsIncludedInCurrencyTotals = 0;
  let unassignedCurrencyRows = 0;
  let totalIssues = 0;

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (row.every((cell) => cell.trim() === '')) continue;
    if (reviewRows.length >= MAX_DATA_ROWS) {
      throw new Error(`Files are limited to ${MAX_DATA_ROWS.toLocaleString()} non-empty invoice rows per review.`);
    }

    const invoiceNumber = valueAt(row, columns.invoiceNumber);
    const vendor = valueAt(row, columns.vendor);
    const date = valueAt(row, columns.date);
    const rawAmount = valueAt(row, columns.amount);
    const rawCurrency = valueAt(row, columns.currency);
    const currency = rawCurrency.toUpperCase();
    const amount = parseAmountCell(rawAmount);
    const issues: string[] = [];

    if (columns.invoiceNumber >= 0 && !invoiceNumber) issues.push('Missing invoice number');
    if (columns.vendor >= 0 && !vendor) issues.push('Missing vendor');
    if (columns.date >= 0 && !date) issues.push('Missing invoice date');
    if (!rawAmount) issues.push('Missing amount');
    else if (amount.ambiguous) issues.push('Ambiguous amount separator; excluded from totals');
    else if (amount.value === null) issues.push('Invalid amount');
    else {
      rowsWithUsableAmounts += 1;
      if (amount.value < 0) issues.push('Negative amount; review as a credit or adjustment');
    }

    const validCurrency = /^[A-Z]{3}$/.test(currency);
    if (columns.currency >= 0 && !rawCurrency) issues.push('Missing currency; excluded from currency totals');
    else if (rawCurrency && !validCurrency) issues.push('Invalid currency code; excluded from currency totals');

    if (vendor) vendors.add(vendor.toLocaleLowerCase());

    if (invoiceNumber) {
      const key = invoiceNumber.toLocaleLowerCase();
      const firstRow = seenInvoiceNumbers.get(key);
      if (firstRow !== undefined) issues.push(`Duplicate invoice number; first seen on row ${firstRow} (retained in totals)`);
      else seenInvoiceNumbers.set(key, index + 1);
    }

    const duplicateKey = JSON.stringify(row);
    const priorRow = seenRows.get(duplicateKey);
    if (priorRow !== undefined) issues.push(`Duplicate of row ${priorRow}; retained in totals`);
    else seenRows.set(duplicateKey, index + 1);

    if (amount.value !== null && !amount.ambiguous && validCurrency) {
      const total = totals.get(currency) ?? { amount: 0, rows: 0 };
      total.amount += amount.value;
      total.rows += 1;
      totals.set(currency, total);
      rowsIncludedInCurrencyTotals += 1;
    } else if (amount.value !== null && !amount.ambiguous && !validCurrency) {
      unassignedCurrencyRows += 1;
    }

    totalIssues += issues.length;
    reviewRows.push({
      sourceRow: index + 1,
      invoiceNumber: clip(invoiceNumber, 120),
      vendor: clip(vendor, 120),
      date: clip(date, 80),
      amount: amount.ambiguous ? null : amount.value,
      currency: validCurrency ? currency : 'Unassigned',
      issues,
    });
  }

  if (!reviewRows.length) throw new Error('No invoice rows were found below the header row.');
  if (totals.size > MAX_CURRENCY_GROUPS) {
    throw new Error(`This file contains more than ${MAX_CURRENCY_GROUPS} currency codes. Split it into smaller files for a complete review.`);
  }

  const flagged = reviewRows.filter((row) => row.issues.length > 0);
  return {
    fileName: clip(fileName, 180),
    delimiter: delimiter === '\t' ? 'tab' : 'comma',
    rowsRead: reviewRows.length,
    rowsWithUsableAmounts,
    rowsIncludedInCurrencyTotals,
    distinctVendors: vendors.size,
    currencies: [...totals.keys()].sort(),
    totalsByCurrency: [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, value]) => ({ currency, amount: roundMoney(value.amount), rows: value.rows })),
    unassignedCurrencyRows,
    flaggedRowCount: flagged.length,
    totalIssues,
    previewRows: flagged.slice(0, MAX_PREVIEW_ROWS).map((row) => ({
      sourceRow: row.sourceRow,
      invoiceNumber: row.invoiceNumber,
      vendor: row.vendor,
      date: row.date,
      amount: row.amount,
      currency: row.currency,
      issues: row.issues.slice(0, 4),
    })),
    omittedFlaggedRows: Math.max(0, flagged.length - MAX_PREVIEW_ROWS),
    headerWarnings,
    interpretationNotes: [
      'Currency totals are kept separate; no currency conversion is performed.',
      'Rows with missing, invalid, or ambiguous amounts are excluded from totals, not treated as zero.',
      'Duplicate invoice numbers and duplicate rows are retained in totals and flagged for human review.',
      'This review reads CSV/TSV data only. It does not modify or send files, invoices, or messages.',
    ],
  };
}

function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
    closedQuote = false;
    if (row.length > MAX_COLUMNS) throw new Error(`Files are limited to ${MAX_COLUMNS} columns.`);
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    if (rows.length > MAX_DATA_ROWS + 2) {
      throw new Error(`Files are limited to ${MAX_DATA_ROWS.toLocaleString()} non-empty invoice rows per review.`);
    }
  };
  const add = (character: string) => {
    cell += character;
    if (cell.length > MAX_CELL_CHARS) throw new Error('A cell exceeds the 10,000-character safety limit.');
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          add('"');
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        add(character);
      }
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        pushCell();
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        pushRow();
      } else if (character === ' ' || character === '\t') {
        // Ignore padding between the end quote and the delimiter/line ending.
      } else {
        throw new Error('The attached file contains malformed quoted fields.');
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      pushCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      add(character);
    }
  }

  if (quoted) throw new Error('The attached file contains an unfinished quoted field.');
  if (cell.length > 0 || row.length > 0 || closedQuote) pushRow();
  return rows;
}

function resolveColumns(headers: readonly string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const find = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const index = normalized.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };
  return {
    invoiceNumber: find(HEADER_ALIASES.invoiceNumber),
    vendor: find(HEADER_ALIASES.vendor),
    date: find(HEADER_ALIASES.date),
    amount: find(HEADER_ALIASES.amount),
    currency: find(HEADER_ALIASES.currency),
    description: find(HEADER_ALIASES.description),
  };
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/#/g, 'number').replace(/[^a-z0-9]/g, '');
}

function valueAt(row: readonly string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

function parseAmountCell(input: string): AmountResult {
  let raw = input.trim();
  if (!raw) return { value: null, ambiguous: false };

  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1).trim();
  }
  if (/^-/.test(raw) || /-$/.test(raw)) negative = true;
  raw = raw
    .replace(/[₹$€£¥]/g, '')
    .replace(/^(?:INR|USD|EUR|GBP|JPY|AUD|CAD|CNY|Rs\.?)\s*/i, '')
    .replace(/\s+(?:INR|USD|EUR|GBP|JPY|AUD|CAD|CNY)$/i, '')
    .replace(/\s*(?:CR|DR)$/i, '')
    .trim();
  if (/[a-z]/i.test(raw)) return { value: null, ambiguous: false };

  const original = raw.replace(/\s/g, '').replace(/[^\d.,]/g, '');
  if (!/\d/.test(original)) return { value: null, ambiguous: false };
  const separators = (original.match(/[.,]/g) ?? []).length;
  const lastComma = original.lastIndexOf(',');
  const lastDot = original.lastIndexOf('.');
  const trailingDigits = original.length - Math.max(lastComma, lastDot) - 1;
  let normalized = original;
  const ambiguous = separators === 1 && trailingDigits === 3;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) normalized = original.replace(/\./g, '').replace(',', '.').replace(/,/g, '');
    else normalized = original.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = separators > 1 ? original.replace(/,/g, '') : (trailingDigits === 3 ? original.replace(/,/g, '') : original.replace(',', '.'));
  } else if (lastDot >= 0 && separators > 1) {
    const last = original.lastIndexOf('.');
    normalized = original.slice(0, last).replace(/\./g, '') + '.' + original.slice(last + 1);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || Math.abs(parsed) >= 1e15) return { value: null, ambiguous: false };
  return { value: negative ? -Math.abs(parsed) : Math.abs(parsed), ambiguous };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isInvoiceCsvReviewInput(value: unknown): value is { readonly fileId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 1 &&
    typeof input.fileId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.fileId);
}
