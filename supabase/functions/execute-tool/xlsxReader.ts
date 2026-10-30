import * as XLSX from '@sheetjs/xlsx';
import * as cptable from '@sheetjs/cptable';
import type { SpreadsheetWorkbookData, SpreadsheetWorkbookReader } from '../../../src/tools/mvpTools.ts';

XLSX.set_cptable(cptable);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 2_000;
const MAX_DATA_ROWS = 2_500;
const MAX_COLUMNS = 100;
const MAX_CELL_CHARS = 10_000;
const MAX_WORKSHEETS = 20;

/**
 * Reads one non-empty worksheet from a private workbook.
 * Workbook formulas are deliberately removed rather than evaluated or trusting stale cached results.
 */
export const readSpreadsheetWorkbook: SpreadsheetWorkbookReader = (bytes, fileName): SpreadsheetWorkbookData => {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension !== 'xls' && extension !== 'xlsx') {
    throw new Error('Only .xls and .xlsx workbooks are supported by the workbook reader.');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error('Excel workbooks must be between 1 byte and 10 MB.');
  }

  if (extension === 'xlsx') {
    validateXlsxZipEnvelope(bytes);
  } else if (!hasOleCompoundFileSignature(bytes)) {
    throw new Error('The file contents do not match an Excel .xls workbook.');
  }

  const workbook = (() => {
    try {
      return XLSX.read(bytes, {
        type: 'array',
        cellFormula: true,
        cellHTML: false,
        cellStyles: false,
        cellDates: false,
        sheetRows: MAX_DATA_ROWS + 2,
        WTF: true,
      });
    } catch {
      throw new Error('The Excel workbook could not be parsed. Check that it is a valid, unencrypted XLS/XLSX file.');
    }
  })();

  if (workbook.SheetNames.length === 0) {
    throw new Error('The workbook does not contain any worksheets.');
  }
  if (workbook.SheetNames.length > MAX_WORKSHEETS) {
    throw new Error(`Workbooks are limited to ${MAX_WORKSHEETS} worksheets.`);
  }

  for (const worksheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[worksheetName];
    if (!worksheet) continue;

    const reference = worksheet['!fullref'] ?? worksheet['!ref'];
    if (reference) {
      const range = XLSX.utils.decode_range(reference);
      if (range.e.r + 1 > MAX_DATA_ROWS + 1) {
        throw new Error(`The selected worksheet exceeds the limit of ${MAX_DATA_ROWS.toLocaleString()} invoice rows plus a header row.`);
      }
      if (range.e.c + 1 > MAX_COLUMNS) {
        throw new Error(`Worksheets are limited to ${MAX_COLUMNS} columns.`);
      }
    }

    const rawRows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      range: 0,
      raw: false,
      defval: '',
      blankrows: true,
    }) as unknown[][];
    if (rawRows.length > MAX_DATA_ROWS + 1) {
      throw new Error(`Worksheets are limited to ${MAX_DATA_ROWS.toLocaleString()} invoice rows plus a header row.`);
    }
    if (rawRows.every((row) => row.every((cell) => cellToText(cell).trim() === ''))) {
      continue;
    }

    let formulaCellsExcluded = 0;
    const rows = rawRows.map((rawRow, rowIndex) => {
      if (rawRow.length > MAX_COLUMNS) {
        throw new Error(`Worksheets are limited to ${MAX_COLUMNS} columns.`);
      }
      return rawRow.map((rawCell, columnIndex) => {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const cell = worksheet[address];
        if (cell && (typeof cell.f === 'string' || typeof cell.F === 'string')) {
          formulaCellsExcluded += 1;
          return '';
        }
        const value = cellToText(rawCell);
        if (value.length > MAX_CELL_CHARS) {
          throw new Error('A workbook cell exceeds the 10,000-character safety limit.');
        }
        return value;
      });
    });

    return {
      rows,
      worksheetName,
      worksheetCount: workbook.SheetNames.length,
      formulaCellsExcluded,
    };
  }

  throw new Error('The workbook does not contain a non-empty worksheet.');
};


function hasOleCompoundFileSignature(bytes: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value);
}

/**
 * Bound the ZIP envelope before SheetJS inflates any XML. Storage has a compressed-size
 * limit already; this also caps aggregate expanded bytes and per-entry expansion.
 * Multi-disk and ZIP64 packages are rejected explicitly rather than trusting wrapped sizes.
 */
function validateXlsxZipEnvelope(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zipSignature = (offset: number, signature: number) =>
    offset >= 0 && offset + 4 <= bytes.length && view.getUint32(offset, true) === signature;

  if (!zipSignature(0, 0x04034b50)) {
    throw new Error('The file contents do not match an XLSX ZIP archive.');
  }

  const minimumEndRecord = Math.max(0, bytes.length - 22 - 65_535);
  let endRecord = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndRecord; offset -= 1) {
    if (
      zipSignature(offset, 0x06054b50) &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) {
    throw new Error('The XLSX archive is malformed or uses an unsupported ZIP format.');
  }

  const diskNumber = view.getUint16(endRecord + 4, true);
  const directoryDisk = view.getUint16(endRecord + 6, true);
  const entriesOnDisk = view.getUint16(endRecord + 8, true);
  const entryCount = view.getUint16(endRecord + 10, true);
  const directorySize = view.getUint32(endRecord + 12, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error('Multi-disk and ZIP64 XLSX archives are not supported.');
  }
  if (entryCount === 0 || entryCount > MAX_XLSX_ENTRIES) {
    throw new Error(`XLSX archives must contain between 1 and ${MAX_XLSX_ENTRIES.toLocaleString()} entries.`);
  }

  const directoryEnd = directoryOffset + directorySize;
  if (
    directoryOffset < 0 ||
    directoryEnd > endRecord ||
    directoryEnd < directoryOffset
  ) {
    throw new Error('The XLSX archive has an invalid central directory.');
  }

  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (!zipSignature(cursor, 0x02014b50) || cursor + 46 > directoryEnd) {
      throw new Error('The XLSX archive has a malformed central directory entry.');
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;

    if (entryEnd > directoryEnd || entryEnd < cursor) {
      throw new Error('The XLSX archive has an invalid entry length.');
    }
    if ((flags & 0x0001) !== 0) {
      throw new Error('Encrypted Excel workbooks are not supported.');
    }
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new Error('Multi-disk and ZIP64 XLSX entries are not supported.');
    }
    if (
      uncompressedSize > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES ||
      (compressedSize === 0 && uncompressedSize > 0)
    ) {
      throw new Error('An XLSX entry exceeds the uncompressed size limit.');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error('The XLSX archive exceeds the 32 MB expanded-size limit.');
    }
    cursor = entryEnd;
  }

  if (cursor !== directoryEnd) {
    throw new Error('The XLSX archive central directory is inconsistent.');
  }
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return '';
}
