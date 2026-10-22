export const TASK_ATTACHMENT_BUCKET = 'workflow-files';
export const MAX_TASK_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const TASK_ATTACHMENT_ACCEPT = '.pdf,.txt,.csv,.tsv,.xls,.xlsx';

export function taskAttachmentMimeType(fileName: string): string | null {
  const extension = fileExtension(fileName);
  return extension ? MIME_TYPES_BY_EXTENSION[extension] ?? null : null;
}

export function taskAttachmentValidationError(
  fileName: string,
  sizeBytes: number,
): string | null {
  if (!taskAttachmentMimeType(fileName)) {
    return 'Choose a PDF, TXT, CSV, TSV, XLS, or XLSX file.';
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return 'The selected file has an invalid size.';
  }
  if (sizeBytes > MAX_TASK_ATTACHMENT_BYTES) {
    return 'Files must be 10 MB or smaller.';
  }
  const safeName = sanitizeTaskAttachmentFileName(fileName);
  if (!safeName || safeName.length > 255) {
    return 'The file name must be between 1 and 255 characters.';
  }
  return null;
}

export function sanitizeTaskAttachmentFileName(fileName: string): string {
  const sanitized = Array.from(fileName, (character) => {
    const code = character.charCodeAt(0);
    return character === '/' || character === '\\' || code <= 31 || code === 127
      ? '_'
      : character;
  }).join('');

  return sanitized.trim().replace(/[. ]+$/g, '').slice(0, 255);
}

function fileExtension(fileName: string): string | null {
  const baseName = fileName.split(/[\\/]/).pop() ?? '';
  const dot = baseName.lastIndexOf('.');
  if (dot <= 0 || dot === baseName.length - 1) return null;
  return baseName.slice(dot + 1).toLowerCase();
}
