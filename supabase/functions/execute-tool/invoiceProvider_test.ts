import {
  createGroqQwenInvoiceExtractor,
  createInvoiceDocumentExtractorFromEnvironment,
} from './invoiceProvider.ts';
import { InvoiceDocumentPageLimitError } from '../../../src/tools/invoiceDocumentExtraction.ts';
import type { TaskFileContent } from '../../../src/tools/mvpTools.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertStartsWith(value: string, prefix: string): void {
  if (!value.startsWith(prefix)) throw new Error(`Expected value to start with ${prefix}`);
}

function makePdf(pageCount = 1): TaskFileContent {
  const text = [
    'INVOICE',
    'Invoice Number: SYNTH-INV-0001',
    'Invoice Date: 2026-11-01',
    'Vendor: Synthetic Supply Co',
    'Description: Office stationery',
    'Currency: INR',
    'Subtotal: 1000.00',
    'Tax Amount (GST): 180.00',
    'Grand Total: 1180.00',
  ];
  const stream = [
    'BT',
    '/F1 12 Tf',
    '50 750 Td',
    ...text.flatMap((line) => [`(${pdfEscape(line)}) Tj`, '0 -24 Td']),
    'ET',
    '',
  ].join('\n');
  const firstPageObject = 3;
  const fontObject = firstPageObject + pageCount;
  const contentObject = fontObject + 1;
  const kids = Array.from({ length: pageCount }, (_, index) => `${firstPageObject + index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return {
    id: '85000000-0000-4000-8000-000000000001',
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    bytes: new TextEncoder().encode(pdf),
  };
}

function pdfEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function makeImage(): TaskFileContent {
  return {
    id: '85000000-0000-4000-8000-000000000002',
    fileName: 'invoice.jpg',
    contentType: 'image/jpeg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  };
}

const BASE_URL = 'https://api.groq.com/openai/v1';
const MODEL = 'qwen/qwen3.8-27b';

Deno.test('Groq invoice extractor converts all PDF pages to PNG image parts', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  const observations: unknown[] = [];
  const extractor = createGroqQwenInvoiceExtractor({
    baseUrl: BASE_URL,
    modelName: MODEL,
    apiKey: 'groq-server-only-test-key',
    fetcher: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          invoiceNumber: { value: 'SYNTH-INV-0001', confidence: 0.99 },
        }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
      });
    },
  });
  const result = await extractor(makePdf(2), undefined, (observation) => { observations.push(observation); });
  assertEquals(requestUrl, BASE_URL + '/chat/completions');
  assertEquals(requestBody['model'], MODEL);
  assertEquals(requestBody['reasoning_effort'], 'none');
  assertEquals(requestBody['response_format'], { type: 'json_object' });
  const messages = requestBody['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
  const userContent = messages[1]?.content ?? [];
  const imageParts = userContent.filter((part) => part['type'] === 'image_url');
  assertEquals(imageParts.length, 2);
  for (const part of imageParts) {
    const imageUrl = (part['image_url'] as { url: string }).url;
    assertStartsWith(imageUrl, 'data:image/png;base64,');
    const png = Uint8Array.from(atob(imageUrl.slice('data:image/png;base64,'.length)), (char) => char.charCodeAt(0));
    assertEquals(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assertEquals((result as Record<string, unknown>)['invoiceNumber'], { value: 'SYNTH-INV-0001', confidence: 0.99 });
  assertEquals(observations.length, 1);
  const observation = observations[0] as Record<string, unknown>;
  assertEquals(observation.stage, 'invoice_extraction');
  assertEquals(observation.providerId, 'api.groq.com');
  assertEquals(observation.modelId, MODEL);
  assertEquals(observation.outcome, 'succeeded');
  assertEquals(observation.inputTokens, 120);
  assertEquals(observation.outputTokens, 20);
  assertEquals(observation.totalTokens, 140);
  assertEquals(JSON.stringify(observations).includes('groq-server-only-test-key'), false);
});

Deno.test('Groq invoice extractor sends JPEG attachments as image_url parts', async () => {
  let requestBody: Record<string, unknown> = {};
  const extractor = createGroqQwenInvoiceExtractor({
    baseUrl: BASE_URL,
    modelName: MODEL,
    apiKey: 'groq-server-only-test-key',
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: '{"invoiceNumber":{"value":null,"confidence":0}}' } }] });
    },
  });
  await extractor(makeImage());
  const messages = requestBody['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
  const userContent = messages[1]?.content ?? [];
  const imagePart = userContent.find((part) => part['type'] === 'image_url');
  assert(imagePart, 'Expected an image_url part.');
  assertStartsWith((imagePart['image_url'] as { url: string }).url, 'data:image/jpeg;base64,');
});

Deno.test('Groq invoice extractor rejects PDFs over the provider image limit without sending them', async () => {
  let providerCalled = false;
  const extractor = createGroqQwenInvoiceExtractor({
    baseUrl: BASE_URL,
    modelName: MODEL,
    apiKey: 'groq-server-only-test-key',
    fetcher: async () => {
      providerCalled = true;
      return Response.json({});
    },
  });
  let error: unknown;
  try {
    await extractor(makePdf(4));
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof InvoiceDocumentPageLimitError, 'Expected a safe page-limit validation error.');
  assertEquals(providerCalled, false);
});

Deno.test('invoice environment factory only enables the dedicated Groq vision profile', () => {
  const valid = {
    FLOWWORK_INVOICE_PROVIDER: 'groq-qwen-vision',
    FLOWWORK_INVOICE_BASE_URL: BASE_URL,
    FLOWWORK_INVOICE_MODEL: MODEL,
    FLOWWORK_INVOICE_API_KEY: 'groq-test-key',
  };
  assertEquals(typeof createInvoiceDocumentExtractorFromEnvironment(valid), 'function');
  assertEquals(createInvoiceDocumentExtractorFromEnvironment({
    ...valid,
    FLOWWORK_INVOICE_PROVIDER: 'openai-compatible',
  }), undefined);
  assertEquals(createInvoiceDocumentExtractorFromEnvironment({
    ...valid,
    FLOWWORK_INVOICE_BASE_URL: 'https://attacker.example/v1',
  }), undefined);
  assertEquals(createInvoiceDocumentExtractorFromEnvironment({
    ...valid,
    FLOWWORK_INVOICE_MODEL: 'openai/gpt-oss-120b',
  }), undefined);
});

Deno.test('Groq rate limits are classified and provider response bodies are not surfaced', async () => {
  const observations: unknown[] = [];
  const extractor = createGroqQwenInvoiceExtractor({
    baseUrl: BASE_URL,
    modelName: MODEL,
    apiKey: 'groq-server-only-test-key',
    fetcher: async () => new Response('private provider error body', { status: 429 }),
  });
  let message = '';
  try {
    await extractor(makeImage(), undefined, (observation) => { observations.push(observation); });
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertEquals(message, 'Invoice provider is rate limited.');
  const observation = observations[0] as Record<string, unknown>;
  assertEquals(observation.failureCategory, 'rate_limited');
  assertEquals(JSON.stringify(observations).includes('private provider error body'), false);
  assertEquals(JSON.stringify(observations).includes('groq-server-only-test-key'), false);
});
