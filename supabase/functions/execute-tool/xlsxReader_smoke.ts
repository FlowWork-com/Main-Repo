import * as XLSX from '@sheetjs/xlsx';
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

function testReadsWorkbookAndExcludesFormulas(): void {
  const result = readSpreadsheetWorkbook(createWorkbookBytes(), 'invoices.xlsx');
  equal(result.worksheetName, 'Invoices', 'first non-empty worksheet is selected');
  equal(result.worksheetCount, 3, 'worksheet count is reported');
  equal(result.rows[0], ['Invoice Number', 'Vendor', 'Grand Total', 'Currency'], 'headers are preserved');
  equal(result.rows[1], ['INV-1', 'Acme, Inc.', '1180', 'INR'], 'ordinary cells are preserved as text');
  equal(result.rows[2]?.[2], '', 'formula cell is blanked rather than using its cached value');
  equal(result.formulaCellsExcluded, 1, 'formula count is reported');
}

function testRejectsUnsupportedAndMalformedFiles(): void {
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
    malformed = error instanceof Error && error.message.includes('XLSX ZIP archive');
  }
  assert(malformed, 'malformed workbook data is rejected');
}

function createLegacyWorkbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Invoice Number', 'Vendor', 'Grand Total', 'Currency'],
    ['INV-OLD', 'Legacy Co', 42, 'USD'],
  ]), 'Legacy invoices');
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xls', type: 'array' }));
}

function testReadsLegacyXls(): void {
  const result = readSpreadsheetWorkbook(createLegacyWorkbookBytes(), 'legacy.xls');
  equal(result.worksheetName, 'Legacy invoices', 'legacy XLS worksheet is selected');
  equal(result.rows[1], ['INV-OLD', 'Legacy Co', '42', 'USD'], 'legacy XLS cells are preserved');
}

function testRejectsExpandedZipEntryBeforeParsing(): void {
  const bytes = createWorkbookBytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = (offset: number) => view.getUint32(offset, true);
  let endRecord = -1;
  const minimumEndRecord = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minimumEndRecord; offset -= 1) {
    if (
      signature(offset) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      endRecord = offset;
      break;
    }
  }
  assert(endRecord >= 0, 'test workbook has a ZIP end-of-central-directory record');
  const centralDirectoryOffset = view.getUint32(endRecord + 16, true);
  assert(signature(centralDirectoryOffset) === 0x02014b50, 'test workbook has a central directory entry');
  view.setUint32(centralDirectoryOffset + 24, 25 * 1024 * 1024, true);

  let rejected = false;
  try {
    readSpreadsheetWorkbook(bytes, 'expanded.xlsx');
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('uncompressed size limit');
  }
  assert(rejected, 'oversized expanded entries are rejected before workbook parsing');
}

function testRejectsTooManyWorksheets(): void {
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
}

testReadsWorkbookAndExcludesFormulas();
testReadsLegacyXls();
testRejectsUnsupportedAndMalformedFiles();
testRejectsExpandedZipEntryBeforeParsing();
testRejectsTooManyWorksheets();
console.log('XLS/XLSX workbook reader smoke tests passed.');
