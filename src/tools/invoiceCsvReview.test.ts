import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from './contracts';
import { createInvoiceCsvReviewTool, reviewInvoiceCsv } from './invoiceCsvReview';

const context: ToolExecutionContext = {
  userId: '81000000-0000-4000-8000-000000000001',
  workspaceId: '82000000-0000-4000-8000-000000000001',
  taskId: '83000000-0000-4000-8000-000000000001',
  executionId: '84000000-0000-4000-8000-000000000001',
  toolId: 'invoice-csv-review',
  toolVersion: '1.0.0',
  requestId: 'request-csv-review',
  signal: new AbortController().signal,
};

describe('reviewInvoiceCsv', () => {
  it('summarizes totals by currency without combining currencies', () => {
    const report = reviewInvoiceCsv([
      'Invoice Number,Vendor,Date,Grand Total,Currency',
      'INV-1,Acme,2026-03-31,1180.00,INR',
      'INV-2,Acme,2026-04-01,20.00,USD',
    ].join('\n'), 'invoices.csv');

    expect(report).toMatchObject({
      rowsRead: 2,
      rowsWithUsableAmounts: 2,
      rowsIncludedInCurrencyTotals: 2,
      distinctVendors: 1,
      currencies: ['INR', 'USD'],
      totalsByCurrency: [
        { currency: 'INR', amount: 1180, rows: 1 },
        { currency: 'USD', amount: 20, rows: 1 },
      ],
      flaggedRowCount: 0,
    });
  });

  it('flags missing, invalid, ambiguous amounts and does not count them as zero', () => {
    const report = reviewInvoiceCsv([
      'Invoice No,Vendor,Amount,Currency',
      'INV-1,Acme,,INR',
      'INV-2,Acme,N/A,INR',
      'INV-3,Acme,1.234,INR',
      'INV-4,Acme,0,INR',
    ].join('\n'), 'invoices.csv');

    expect(report.rowsWithUsableAmounts).toBe(1);
    expect(report.totalsByCurrency).toEqual([{ currency: 'INR', amount: 0, rows: 1 }]);
    expect(report.flaggedRowCount).toBe(3);
    expect(report.previewRows.map((row) => row.issues[0])).toEqual([
      'Missing amount',
      'Invalid amount',
      'Ambiguous amount separator; excluded from totals',
    ]);
  });

  it('keeps duplicate invoice rows in totals and flags them for review', () => {
    const report = reviewInvoiceCsv([
      'Invoice Number,Vendor,Amount,Currency',
      'INV-1,Acme,10.00,USD',
      'INV-1,Acme,10.00,USD',
    ].join('\n'), 'duplicates.csv');

    expect(report.totalsByCurrency).toEqual([{ currency: 'USD', amount: 20, rows: 2 }]);
    expect(report.flaggedRowCount).toBe(1);
    expect(report.previewRows[0]?.issues).toContain('Duplicate invoice number; first seen on row 2 (retained in totals)');
    expect(report.previewRows[0]?.issues).toContain('Duplicate of row 2; retained in totals');
  });

  it('supports quoted delimiters and multi-line escaped quotes', () => {
    const report = reviewInvoiceCsv([
      'Invoice Number,Vendor,Description,Amount,Currency',
      'INV-1,"Acme, Inc.","Line 1',
      'Line ""2""","1,234.00",INR',
    ].join('\n'), 'invoices.csv');

    expect(report.rowsRead).toBe(1);
    expect(report.previewRows).toHaveLength(0);
    expect(report.totalsByCurrency).toEqual([{ currency: 'INR', amount: 1234, rows: 1 }]);
  });

  it('rejects unsupported files, malformed quoting, and excessive rows', () => {
    expect(() => reviewInvoiceCsv('Vendor,Amount\nAcme,10', 'invoices.xlsx')).toThrow(/CSV and TSV/);
    expect(() => reviewInvoiceCsv('Invoice Number,Vendor,Amount\n"INV-1,Acme,10', 'invoices.csv')).toThrow(/unfinished quoted/i);
    const rows = ['Invoice Number,Vendor,Amount,Currency', ...Array.from({ length: 2501 }, (_, i) => `INV-${i},Acme,10,INR`)];
    expect(() => reviewInvoiceCsv(rows.join('\n'), 'invoices.csv')).toThrow(/2,500/);
  });

  it('uses only a registered file ID and returns evidence without altering files', async () => {
    const source = {
      getTaskFileContent: vi.fn(async (receivedContext: ToolExecutionContext, fileId: string) => {
        expect(receivedContext.workspaceId).toBe(context.workspaceId);
        expect(receivedContext.taskId).toBe(context.taskId);
        expect(fileId).toBe('85000000-0000-4000-8000-000000000001');
        return {
          id: fileId,
          fileName: 'invoices.csv',
          contentType: 'text/csv',
          text: 'Invoice Number,Vendor,Amount,Currency\nINV-1,Acme,10.00,USD',
        };
      }),
    };
    const tool = createInvoiceCsvReviewTool(source);
    const result = await tool.execute(context, { fileId: '85000000-0000-4000-8000-000000000001' });
    expect(result).toMatchObject({
      success: true,
      evidence: { type: 'invoice-csv-review', reference: '85000000-0000-4000-8000-000000000001' },
    });
    expect(source.getTaskFileContent).toHaveBeenCalledOnce();
    expect(tool.validateInput({ storagePath: 'other-workspace/invoice.csv' })).toBe(false);
    expect(tool.validateInput({ fileId: '85000000-0000-4000-8000-000000000001', path: 'unsafe' })).toBe(false);
  });

  it('does not claim to execute when content access is unavailable', async () => {
    const tool = createInvoiceCsvReviewTool();
    await expect(tool.execute(context, { fileId: '85000000-0000-4000-8000-000000000001' })).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_UNAVAILABLE' },
    });
  });
});
