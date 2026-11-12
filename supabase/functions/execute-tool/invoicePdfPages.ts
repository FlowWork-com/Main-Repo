import { PDFiumLibrary } from '@hyzyla/pdfium';
import { InvoiceDocumentPageLimitError } from '../../../src/tools/invoiceDocumentExtraction.ts';

export const MAX_INVOICE_PDF_PAGES = 3;
export const MAX_INVOICE_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_RENDERED_IMAGE_DATA_URL_CHARS = 20 * 1024 * 1024;
const MAX_PAGE_WIDTH = 1_800;
const MAX_PAGE_HEIGHT = 2_400;
const MAX_PAGE_PIXELS = 2_200_000;
const MIN_RENDER_SCALE = 0.25;

type PdfiumLibraryInstance = Awaited<ReturnType<typeof PDFiumLibrary.init>>;

let libraryPromise: Promise<PdfiumLibraryInstance> | null = null;

async function getPdfiumLibrary(): Promise<PdfiumLibraryInstance> {
  libraryPromise ??= PDFiumLibrary.init().catch((error: unknown) => {
    libraryPromise = null;
    throw error;
  });
  return await libraryPromise;
}

/**
 * Render every page in a small PDF locally inside the Edge Function.
 * No PDF content is sent to the renderer's publisher or to a separate conversion service.
 * The returned PNGs are then suitable for the configured vision provider.
 */
export async function renderInvoicePdfPagesToPng(bytes: Uint8Array): Promise<Uint8Array[]> {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_INVOICE_PDF_BYTES ||
    !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    throw new Error('The invoice PDF is empty, too large, or has an invalid PDF signature.');
  }

  const library = await getPdfiumLibrary();
  const document = await library.loadDocument(bytes);
  try {
    const pageCount = document.getPageCount();
    if (pageCount < 1) {
      throw new Error('The invoice PDF does not contain any pages.');
    }
    if (pageCount > MAX_INVOICE_PDF_PAGES) {
      throw new InvoiceDocumentPageLimitError();
    }

    const renderedPages: Uint8Array[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      const page = document.getPage(index);
      try {
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const scale = chooseRenderScale(originalWidth, originalHeight);
        const rendered = await page.render({ scale, colorSpace: 'RGBA' });
        const png = await encodeRgbaPng(rendered.data, rendered.width, rendered.height);
        const dataUrlChars = 'data:image/png;base64,'.length + base64Length(png.byteLength);
        if (dataUrlChars > MAX_RENDERED_IMAGE_DATA_URL_CHARS) {
          throw new Error('A rendered invoice page exceeds the vision provider image-size limit.');
        }
        renderedPages.push(png);
      } finally {
        page.close();
      }
    }
    return renderedPages;
  } finally {
    document.destroy();
  }
}

function chooseRenderScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The invoice PDF contains a page with invalid dimensions.');
  }
  const scale = Math.min(
    2,
    MAX_PAGE_WIDTH / width,
    MAX_PAGE_HEIGHT / height,
    Math.sqrt(MAX_PAGE_PIXELS / (width * height)),
  );
  if (!Number.isFinite(scale) || scale < MIN_RENDER_SCALE) {
    throw new Error('The invoice PDF contains a page that exceeds the rendering size limit.');
  }
  return scale;
}

async function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (
    width <= 0 || height <= 0 ||
    width * height > MAX_PAGE_PIXELS ||
    rgba.byteLength !== width * height * 4
  ) {
    throw new Error('The rendered invoice page has invalid image dimensions.');
  }

  const rowBytes = width * 4;
  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (rowBytes + 1);
    scanlines[outputOffset] = 0;
    scanlines.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), outputOffset + 1);
  }

  const compressedStream = new Blob([scanlines])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());

  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  return joinBytes(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk('IHDR', header),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', new Uint8Array()),
  );
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  writeUint32(chunk, 0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.byteLength, crc32(chunk.subarray(4, 8 + data.byteLength)));
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}
