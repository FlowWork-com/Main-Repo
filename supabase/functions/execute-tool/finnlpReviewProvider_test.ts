import type { ToolExecutionContext } from '../../../src/tools/contracts.ts';
import {
  createFinnlpFinancialReviewerFromEnvironment,
  createOpenAICompatibleFinnlpFinancialReviewer,
} from './finnlpReviewProvider.ts';
import { FinnlpFinancialReviewProviderError } from '../../../src/tools/finnlpFinancialReview.ts';

const context: ToolExecutionContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  taskId: '33000000-0000-4000-8000-000000000001',
  executionId: '44000000-0000-4000-8000-000000000001',
  toolId: 'finnlp-financial-review',
  toolVersion: '1.0.0',
  requestId: '55000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const input = {
  claim: 'Revenue increased by 8% year over year.',
  draftAnswer: 'The company grew its sales by 8%.',
  sources: [{
    id: 'news-1',
    title: 'Quarterly report',
    url: 'https://news.example.test/story',
    publishedAt: '2026-10-20T00:00:00.000Z',
    excerpt: 'A report discusses year over year revenue.',
    sourceKind: 'finnhub_news' as const,
  }],
};

Deno.test('review provider uses only the configured HTTPS chat-completions endpoint and returns structured content', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const reviewer = createOpenAICompatibleFinnlpFinancialReviewer({
    baseUrl: 'https://review.example.test/v1/',
    modelName: 'configured-reviewer',
    apiKey: 'server-only-review-key',
    fetcher: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              reviewStatus: 'supported_by_sources',
              decodedMeaning: 'An annual comparison.',
              assessmentSummary: 'The supplied record supports the wording.',
              findings: [{
                statement: 'Comparable year-over-year periods are used.',
                assessment: 'supports_claim',
                explanation: 'The excerpt says year over year.',
                sourceIds: ['news-1'],
              }],
              ambiguities: [],
              questionsForMainAgent: [],
              nextStepForMainAgent: 'Confirm the basis before reporting the percentage.',
              confidence: 'moderate',
            }),
          },
        }],
      });
    },
  });
  const result = await reviewer.reviewFinancialClaim(context, input);
  assertEquals(capturedUrl, 'https://review.example.test/v1/chat/completions', 'Endpoint must be fixed from server config');
  assertEquals(capturedInit?.method, 'POST', 'Review uses a bounded POST to the configured model');
  assertEquals((capturedInit?.headers as Record<string, string>).authorization, 'Bearer server-only-review-key', 'Credential stays in server header');
  const body = JSON.parse(String(capturedInit?.body)) as { messages: Array<{ role: string; content: string }>; temperature?: number };
  assertEquals(body.temperature, undefined, 'Reviewer leaves temperature at the selected model default');
  assert(body.messages[0].content.includes('not the primary planner'), 'Prompt must establish verifier-only role');
  assert(body.messages[0].content.includes('Never invent a source'), 'Prompt must prohibit invented citations');
  assert(body.messages[1].content.includes('news-1'), 'Only supplied sources are passed');
  assert((result as { reviewStatus: string }).reviewStatus === 'supported_by_sources', 'Review JSON should be parsed');
});

Deno.test('Groq reviewer uses a strict schema for required FinNLP handoff fields', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const reviewer = createOpenAICompatibleFinnlpFinancialReviewer({
    baseUrl: 'https://api.groq.com/openai/v1',
    modelName: 'qwen/qwen3.8-27b',
    apiKey: 'server-only-review-key',
    fetcher: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              reviewStatus: 'insufficient_evidence',
              decodedMeaning: 'Year over year compares equivalent periods.',
              assessmentSummary: 'No primary evidence was provided.',
              findings: [],
              ambiguities: [{
                term: 'revenue growth',
                interpretations: ['Reported revenue growth', 'Organic revenue growth'],
                clarificationQuestion: 'Which revenue basis should be used?',
              }],
              questionsForMainAgent: ['What reporting period is intended?'],
              nextStepForMainAgent: 'Ask for the reporting basis and primary evidence.',
              confidence: 'moderate',
            }),
          },
        }],
      });
    },
  });

  const result = await reviewer.reviewFinancialClaim(context, input);
  const responseFormat = capturedBody?.response_format as {
    type: string;
    json_schema: {
      name: string;
      strict: boolean;
      schema: { required: string[]; additionalProperties: boolean };
    };
  };
  assertEquals(responseFormat.type, 'json_schema', 'Groq must use structured output, not JSON-object-only mode');
  assertEquals(responseFormat.json_schema.name, 'finnlp_financial_review', 'Schema name should identify the FinNLP review');
  assertEquals(responseFormat.json_schema.strict, true, 'Groq strict schema mode should be enabled');
  assertEquals(responseFormat.json_schema.schema.required, [
    'reviewStatus', 'decodedMeaning', 'assessmentSummary', 'findings',
    'ambiguities', 'questionsForMainAgent', 'nextStepForMainAgent', 'confidence',
  ], 'All fields consumed by the FinNLP normalizer must be required');
  assertEquals(responseFormat.json_schema.schema.additionalProperties, false, 'Unexpected response fields should be rejected');
  assert((result as { decodedMeaning: string }).decodedMeaning.includes('equivalent periods'), 'Structured review content should still be parsed');
});

Deno.test('environment configuration fails closed without all provider settings or with an insecure host', () => {
  assertEquals(createFinnlpFinancialReviewerFromEnvironment({}), undefined, 'Missing settings must not invent a provider');
  assertEquals(createFinnlpFinancialReviewerFromEnvironment({
    FLOWWORK_FINNLP_REVIEW_PROVIDER: 'openai-compatible',
    FLOWWORK_FINNLP_REVIEW_BASE_URL: 'http://review.example.test/v1',
    FLOWWORK_FINNLP_REVIEW_MODEL: 'reviewer',
    FLOWWORK_FINNLP_REVIEW_API_KEY: 'secret',
  }), undefined, 'Non-local HTTP must be rejected');
  assert(createFinnlpFinancialReviewerFromEnvironment({
    FLOWWORK_FINNLP_REVIEW_PROVIDER: 'openai-compatible',
    FLOWWORK_FINNLP_REVIEW_BASE_URL: 'https://review.example.test/v1',
    FLOWWORK_FINNLP_REVIEW_MODEL: 'reviewer',
    FLOWWORK_FINNLP_REVIEW_API_KEY: 'server-secret',
  }) !== undefined, 'Valid server-side provider settings should create a reviewer');
});

Deno.test('provider error bodies and response payloads are never exposed through classified errors', async () => {
  for (const item of [
    { status: 401, expected: 'UNAUTHORIZED' },
    { status: 429, expected: 'RATE_LIMITED' },
    { status: 503, expected: 'UNAVAILABLE' },
  ] as const) {
    const reviewer = createOpenAICompatibleFinnlpFinancialReviewer({
      baseUrl: 'https://review.example.test/v1',
      modelName: 'reviewer',
      apiKey: 'private-provider-key',
      fetcher: async () => Response.json({ error: 'token=private-provider-key' }, { status: item.status }),
    });
    let observed: unknown;
    try {
      await reviewer.reviewFinancialClaim(context, input);
    } catch (error) {
      observed = error;
    }
    assert(
      observed instanceof FinnlpFinancialReviewProviderError && observed.kind === item.expected,
      `HTTP ${item.status} must map to ${item.expected}`,
    );
    assert(!String(observed).includes('private-provider-key'), 'Provider credentials cannot leak in errors');
  }
});

Deno.test('provider timeout aborts the outgoing request', async () => {
  const reviewer = createOpenAICompatibleFinnlpFinancialReviewer({
    baseUrl: 'https://review.example.test/v1',
    modelName: 'reviewer',
    apiKey: 'server-only',
    timeoutMs: 5,
    fetcher: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  let observed: unknown;
  try {
    await reviewer.reviewFinancialClaim(context, input);
  } catch (error) {
    observed = error;
  }
  assert(observed instanceof FinnlpFinancialReviewProviderError && observed.kind === 'TIMEOUT', 'Provider deadline must be enforced');
});
