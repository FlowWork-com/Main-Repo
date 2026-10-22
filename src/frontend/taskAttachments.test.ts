import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_ATTACHMENT_BYTES,
  sanitizeTaskAttachmentFileName,
  taskAttachmentMimeType,
  taskAttachmentValidationError,
} from './taskAttachments';

describe('task attachment validation', () => {
  it('maps supported extensions to the bucket allowlist MIME types', () => {
    expect(taskAttachmentMimeType('invoice.PDF')).toBe('application/pdf');
    expect(taskAttachmentMimeType('records.csv')).toBe('text/csv');
    expect(taskAttachmentMimeType('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(taskAttachmentMimeType('legacy.xls')).toBe('application/vnd.ms-excel');
    expect(taskAttachmentMimeType('notes.tsv')).toBe('text/tab-separated-values');
    expect(taskAttachmentMimeType('notes.txt')).toBe('text/plain');
  });

  it('rejects unsupported file types and files over the configured size limit', () => {
    expect(taskAttachmentValidationError('malware.exe', 10)).toMatch(/Choose a PDF/);
    expect(taskAttachmentValidationError('report.pdf', MAX_TASK_ATTACHMENT_BYTES + 1)).toMatch(/10 MB/);
    expect(taskAttachmentValidationError('report.pdf', MAX_TASK_ATTACHMENT_BYTES)).toBeNull();
  });

  it('rejects impossible sizes and sanitizes path separators from display names', () => {
    expect(taskAttachmentValidationError('report.pdf', Number.NaN)).toMatch(/invalid size/i);
    expect(sanitizeTaskAttachmentFileName('../private\\evidence.txt')).toBe('.._private_evidence.txt');
  });
});
