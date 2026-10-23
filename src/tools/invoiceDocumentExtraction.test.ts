import { describe, expect, it, vi } from 'vitest';
import type { TaskFileContent, TaskFileContentSource } from './mvpTools';
import type { ToolExecutionContext } from './contracts';
import {
  createInvoiceDocumentExtractionTool,
  normalizeInvoiceExtraction,
  validateInvoiceDocumentBytes,
} from './invoiceDocumentExtraction';

const context: ToolExecutionContext = {
  userId: '81000000-0000-4000-8000-000000000001',
  workspaceId: '82000000-0000-4000-8000-000000000001',
  taskId: '83000000-0000-4000-8000-000000000001',
  executionId: '84000000-0000-4000-8000-000000000001',
  toolId: 'invoice-document-extract',
  toolVersion: '1.0.0',
  requestId: 'invoice-document-request',
  signal: new AbortController().signal,
};

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: { value: 'INV-220', confidence: 0.96 },
    invoiceDate: { value: '2026-10-22', confidence: 0.92 },
    vendor: { value: 'Acme Ltd', confidence: 0.95 },
    description: { value: 'Office supplies', confidence: 0.89 },
    currency: { value: 'INR', confidence: 0.97 },
    subtotal: { value: 1000, confidence: 0.95 },
    taxAmount: { value: 180, confidence: 0.92 },
    totalAmount: { value: 1180, confidence: 0.98 },
    ...overrides,
  };
}

function pdfFile(overrides: Partial<TaskFileContent> = {}): TaskFileContent {
  return {
    id: '85000000-0000-4000-8000-000000000001',
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.7 invoice bytes'),
    ...overrides,
  };
}

function sourceFor(file: TaskFileContent): TaskFileContentSource {
  return {
    getTaskFileContent: vi.fn(async (_ctx, _id) => file),
  };
}

describe('invoice document validation', () => {
  it('accepts matching PDF, JPEG, and PNG signatures', () => {
    expect(validateInvoiceDocumentBytes(pdfFile())).toBeNull();
    expect(validateInvoiceDocumentBytes(pdfFile({
      fileName: 'scan.jpg',
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
    }))).toBeNull();
    expect(validateInvoiceDocumentBytes(pdfFile({
      fileName: 'scan.png',
      contentType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    }))).toBeNull();
  });

  it('rejects type mismatches, spoofed signatures, and oversized documents', () => {
    expect(validateInvoiceDocumentBytes(pdfFile({
      fileName: 'invoice.pdf',
      contentType: 'image/jpeg',
      bytes: new TextEncoder().encode('%PDF-1.7'),
    })).toMatch(/matching file type/);
    expect(validateInvoiceDocumentBytes(pdfFile({
      fileName: 'invoice.png',
      contentType: 'image/png',
      bytes: new TextEncoder().encode('not a png'),
    })).toMatch(/do not match a PNG/);
    expect(validateInvoiceDocumentBytes(pdfFile({
      bytes: new Uint8Array(10 * 1024 * 1024 + 1),
    })).toMatch(/10 MB/);
  });
});

describe('normalizeInvoiceExtraction', () => {
  it('returns fields with confidence estimates and always requires human review', () => {
    const report = normalizeInvoiceExtraction(pdfFile(), extraction());
    expect(report).toMatchObject({
      fileId: '85000000-0000-4000-8000-000000000001',
      fileName: 'invoice.pdf',
      sourceFormat: 'pdf',
      reviewRequired: true,
      validationStatus: 'needs_review',
      fields: {
        invoiceNumber: { value: 'INV-220', confidenceEstimate: 0.96, needsReview: false },
        vendor: { value: 'Acme Ltd', confidenceEstimate: 0.95, needsReview: false },
        subtotal: { value: 1000, confidenceEstimate: 0.95, needsReview: false },
        totalAmount: { value: 1180, confidenceEstimate: 0.98, needsReview: false },
      },
    });
    expect(report.interpretationNotes.join(' ')).toMatch(/not been calibrated/i);
    expect(report.interpretationNotes.join(' ')).toMatch(/human review/i);
  });

  it('flags missing and low-confidence fields without substituting zero', () => {
    const report = normalizeInvoiceExtraction(pdfFile(), extraction({
      vendor: { value: null, confidence: 0.12 },
      invoiceDate: { value: 'not a date', confidence: 0.92 },
      totalAmount: { value: null, confidence: 0.01 },
    }));
    expect(report.fields.vendor.value).toBeNull();
    expect(report.fields.vendor.needsReview).toBe(true);
    expect(report.fields.totalAmount.value).toBeNull();
    expect(report.warnings.join(' ')).toMatch(/Vendor or supplier name is missing/i);
    expect(report.warnings.join(' ')).toMatch(/YYYY-MM-DD/i);
  });

  it('flags arithmetic inconsistencies without silently changing amounts', () => {
    const report = normalizeInvoiceExtraction(pdfFile(), extraction({
      totalAmount: { value: 1400, confidence: 0.99 },
    }));
    expect(report.fields.totalAmount.value).toBe(1400);
    expect(report.fields.totalAmount.needsReview).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/Subtotal plus tax does not match/i);
  });

  it('marks reports insufficient when too few required fields were found', () => {
    const report = normalizeInvoiceExtraction(pdfFile(), extraction({
      invoiceNumber: { value: null, confidence: 0 },
      invoiceDate: { value: null, confidence: 0 },
      vendor: { value: null, confidence: 0 },
      totalAmount: { value: null, confidence: 0 },
    }));
    expect(report.validationStatus).toBe('insufficient_data');
  });
});

describe('createInvoiceDocumentExtractionTool', () => {
  it('requires approval because the original document is sent to a provider', async () => {
    const file = pdfFile();
    const source = sourceFor(file);
    const extractor = vi.fn(async () => extraction());
    const tool = createInvoiceDocumentExtractionTool(source, extractor);
    expect(tool.riskLevel).toBe('high');
    expect(tool.requiresApproval).toBe(true);

    const result = await tool.execute(context, { fileId: file.id });
    expect(result).toMatchObject({
      success: true,
      output: { reviewRequired: true, validationStatus: 'needs_review' },
      evidence: { type: 'invoice-document-extraction', reference: file.id },
    });
    expect(source.getTaskFileContent).toHaveBeenCalledWith(context, file.id);
    expect(extractor).toHaveBeenCalledWith(file);
  });

  it('rejects invalid bytes before provider calls', async () => {
    const file = pdfFile({ bytes: new TextEncoder().encode('not a PDF') });
    const source = sourceFor(file);
    const extractor = vi.fn(async () => extraction());
    const tool = createInvoiceDocumentExtractionTool(source, extractor);
    const result = await tool.execute(context, { fileId: file.id });
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_TOOL_INPUT' } });
    expect(extractor).not.toHaveBeenCalled();
    expect(tool.validateInput({ fileId: file.id, storagePath: 'other/workspace/file.pdf' })).toBe(false);
  });

  it('does not claim extraction is available without provider configuration', async () => {
    const tool = createInvoiceDocumentExtractionTool(sourceFor(pdfFile()));
    await expect(tool.execute(context, { fileId: pdfFile().id })).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_UNAVAILABLE' },
    });
  });
});
