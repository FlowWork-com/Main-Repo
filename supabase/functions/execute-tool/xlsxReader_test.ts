// @deno-types="https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { readSpreadsheetWorkbook } from './xlsxReader.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function createWorkbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[''], ['']]), 'Empty');
  const invoices = XLSX.utils.aoa_to_sheet([
    ['Invoice Number', 'Vendor', 'Grand Total', 'Currency'],
    ['INV-1', 'Acme, Inc.', 1180, 'INR'],
    ['INV-2', 'Beta', 20, 'USD'],
  ]);
  invoices['C3'] = { t: 'n', f: '10*2', v: 20, z: '0.00' };
  XLSX.utils.book_append_sheet(workbook, invoices, 'Invoices');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Other Data'], ['Not included']]), 'Notes');
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }));
}

Deno.test('reads an XLSX workbook, selects the first non-empty worksheet, and excludes formulas', () => {
  const result = readSpreadsheetWorkbook(createWorkbookBytes(), 'invoices.xlsx');
  equal(result.worksheetName, 'Invoices', 'first non-empty worksheet is selected');
  equal(result.worksheetCount, 3, 'worksheet count is reported');
  equal(result.rows[0], ['Invoice Number', 'Vendor', 'Grand Total', 'Currency'], 'headers are preserved');
  equal(result.rows[1], ['INV-1', 'Acme, Inc.', '1180', 'INR'], 'ordinary cells are preserved as text');
  equal(result.rows[2]?.[2], '', 'formula cell is blanked rather than using its cached value');
  equal(result.formulaCellsExcluded, 1, 'formula count is reported');
});

Deno.test('rejects unsupported extensions and malformed workbook bytes', () => {
  let wrongExtension = false;
  try {
    readSpreadsheetWorkbook(new Uint8Array([1, 2, 3]), 'invoices.csv');
  } catch (error) {
    wrongExtension = error instanceof Error && error.message.includes('.xls and .xlsx');
  }
  assert(wrongExtension, 'unsupported extensions are rejected before parsing');

  let malformed = false;
  try {
    readSpreadsheetWorkbook(new Uint8Array([1, 2, 3]), 'invoices.xlsx');
  } catch (error) {
    malformed = error instanceof Error && error.message.includes('could not be parsed');
  }
  assert(malformed, 'malformed workbook data is rejected');
});

Deno.test('rejects workbooks containing too many worksheets', () => {
  const workbook = XLSX.utils.book_new();
  for (let index = 0; index < 21; index += 1) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Invoice Number', 'Amount'], [`INV-${index}`, 1]]),
      `Sheet${index}`,
    );
  }
  const bytes = new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }));
  let rejected = false;
  try {
    readSpreadsheetWorkbook(bytes, 'many-sheets.xlsx');
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('20 worksheets');
  }
  assert(rejected, 'excessive worksheets are rejected');
});
