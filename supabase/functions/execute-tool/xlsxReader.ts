// @deno-types="https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import * as cptable from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/cpexcel.full.mjs';
import type { SpreadsheetWorkbookData, SpreadsheetWorkbookReader } from '../../../src/tools/mvpTools.ts';

XLSX.set_cptable(cptable);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
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

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
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

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return '';
}
