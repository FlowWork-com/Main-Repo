function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) throw new Error(`Expected string to include ${expected}`);
}
import { createOpenAICompatibleInvoiceExtractor } from './invoiceProvider.ts';
import type { TaskFileContent } from '../../../src/tools/mvpTools.ts';

function makePdf(): TaskFileContent {
  return {
    id: '85000000-0000-4000-8000-000000000001',
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.7'),
  };
}

Deno.test('invoice provider sends PDF as a file part and returns bounded JSON content', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  const observations: unknown[] = [];
  const extractor = createOpenAICompatibleInvoiceExtractor({
    baseUrl: 'https://provider.example/v1',
    modelName: 'vision-model',
    apiKey: 'server-only-key',
    fetcher: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          invoiceNumber: { value: 'INV-1', confidence: 0.9 },
        }) } }],
        usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
      });
    },
  });
  const result = await extractor(makePdf(), undefined, (observation) => { observations.push(observation); });
  assertEquals(requestUrl, 'https://provider.example/v1/chat/completions');
  assertEquals(requestBody['model'], 'vision-model');
  assertEquals(requestBody['temperature'], undefined);
  assertEquals(requestBody['max_completion_tokens'], 1800);
  assertEquals(requestBody['max_tokens'], undefined);
  assertEquals(requestBody['response_format'], { type: 'json_object' });
  const messages = requestBody['messages'] as Array<Record<string, unknown>>;
  const user = messages[1] as { content: Array<Record<string, unknown>> };
  const filePart = user.content[1] as { type: string; file: { filename: string; file_data: string } };
  assertEquals(filePart.type, 'file');
  assertEquals(filePart.file.filename, 'invoice.pdf');
  assertEquals(filePart.file.file_data, 'data:application/pdf;base64,JVBERi0xLjc=');
  assertEquals((result as Record<string, unknown>)['invoiceNumber'], { value: 'INV-1', confidence: 0.9 });
  assertEquals(observations.length, 1);
  const observation = observations[0] as Record<string, unknown>;
  assertEquals(observation.stage, 'invoice_extraction');
  assertEquals(observation.providerId, 'provider.example');
  assertEquals(observation.modelId, 'vision-model');
  assertEquals(observation.outcome, 'succeeded');
  assertEquals(observation.retryCount, 0);
  assertEquals(observation.inputTokens, 50);
  assertEquals(observation.outputTokens, 12);
  assertEquals(observation.totalTokens, 62);
  assertEquals(JSON.stringify(observations).includes('invoice bytes'), false);
  assertEquals(JSON.stringify(observations).includes('server-only-key'), false);
});

Deno.test('invoice provider sends JPEG as an image URL part', async () => {
  let requestBody: Record<string, unknown> = {};
  const extractor = createOpenAICompatibleInvoiceExtractor({
    baseUrl: 'https://provider.example/v1/',
    modelName: 'vision-model',
    apiKey: 'server-only-key',
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: '{"invoiceNumber":{"value":null,"confidence":0}}' } }] });
    },
  });
  const result = await extractor({
    ...makePdf(),
    fileName: 'invoice.jpg',
    contentType: 'image/jpeg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  });
  assertEquals((result as Record<string, unknown>)['invoiceNumber'], { value: null, confidence: 0 });
  const messages = requestBody['messages'] as Array<Record<string, unknown>>;
  const user = messages[1] as { content: Array<Record<string, unknown>> };
  const imagePart = user.content[1] as { type: string; image_url: { url: string; detail: string } };
  assertEquals(imagePart.type, 'image_url');
  assertStringIncludes(imagePart.image_url.url, 'data:image/jpeg;base64,');
  assertEquals(imagePart.image_url.detail, 'high');
});

Deno.test('invoice provider rejects HTTP errors and does not expose provider response text', async () => {
  const extractor = createOpenAICompatibleInvoiceExtractor({
    baseUrl: 'https://provider.example/v1',
    modelName: 'vision-model',
    apiKey: 'server-only-key',
    fetcher: async () => new Response('secret body', { status: 500 }),
  });
  let message = '';
  try { await extractor(makePdf()); } catch (error) { message = error instanceof Error ? error.message : ''; }
  assertEquals(message, 'Invoice provider request failed.');
  assertEquals(message.includes('secret body'), false);
});
