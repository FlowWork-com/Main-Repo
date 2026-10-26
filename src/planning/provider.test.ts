import { describe, expect, it } from 'vitest';
import { createPlannerError, type PlannerRequest } from './planning';
import {
  createPlannerAdapterFromEnvironment,
  createMockPlannerAdapter,
  createOpenAICompatiblePlannerAdapter,
} from './provider';

describe('planner provider adapter', () => {
  it('returns a sanitized configuration error when disabled', () => {
    const provider = createPlannerAdapterFromEnvironment({
      FLOWWORK_PLANNER_PROVIDER: '',
      FLOWWORK_PLANNER_MODEL: '',
      FLOWWORK_PLANNER_API_KEY: '',
    });
    expect(provider).toBeNull();
  });

  it('creates a mock provider when explicitly configured', async () => {
    const provider = createMockPlannerAdapter({
      providerName: 'mock-planner',
    });
    const request: PlannerRequest = {
      taskId: '43000000-0000-4000-8000-000000000001',
      goal: 'Uppercase hello.',
      toolCatalog: [],
    };
    const response = await provider.generatePlan(request);
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.plan.goal).toContain('hello');
      expect(response.plan.steps.length).toBeGreaterThan(0);
    }
  });

  it('requires complete secure configuration for the real provider', () => {
    expect(createPlannerAdapterFromEnvironment({ FLOWWORK_PLANNER_PROVIDER: 'mock' })).toBeNull();
    expect(createPlannerAdapterFromEnvironment({
      FLOWWORK_PLANNER_PROVIDER: 'openai-compatible',
      FLOWWORK_PLANNER_BASE_URL: 'http://api.example.test/v1',
      FLOWWORK_PLANNER_MODEL: 'planner',
      FLOWWORK_PLANNER_API_KEY: 'server-only',
    })).toBeNull();
  });

  it('uses structured JSON mode and returns a model-generated plan', async () => {
    let capturedUrl = '';
    let capturedRequest: RequestInit | undefined;
    const adapter = createOpenAICompatiblePlannerAdapter({
      baseUrl: 'https://api.example.test/v1/',
      modelName: 'configured-model',
      apiKey: 'server-only-key',
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedRequest = init;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            summary: 'Transform the text.',
            steps: [{
              id: 'step_1',
              title: 'Transform text',
              description: 'Apply a text transformation.',
              toolId: 'text-transform',
              toolVersion: '1.0.0',
              input: { operation: 'uppercase', text: 'hello' },
              dependencies: [],
              expectedOutcome: 'Uppercase output.',
              verificationCriteria: 'Output is uppercase.',
            }],
            limitations: [],
          }) } }],
        });
      },
    });
    const response = await adapter.generatePlan({
      taskId: '43000000-0000-4000-8000-000000000001',
      goal: 'Uppercase hello.',
      toolCatalog: [],
      availableAttachments: [{
        id: '55000000-0000-4000-8000-000000000001',
        fileName: 'invoices.csv',
        contentType: 'text/csv',
      }],
    });
    expect(capturedUrl).toBe('https://api.example.test/v1/chat/completions');
    const sentBody = JSON.parse(String(capturedRequest?.body)) as {
      response_format: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages[0]?.content).toContain('55000000-0000-4000-8000-000000000001');
    expect(sentBody.messages[0]?.content).toContain('untrusted data');
    expect(sentBody.messages[0]?.content).toContain('XLS, or XLSX');
    expect(sentBody.messages[0]?.content).toContain('formula cells are excluded');
    expect(capturedRequest?.headers).toMatchObject({ authorization: 'Bearer server-only-key' });
    expect(response.success).toBe(true);
    if (response.success) expect(response.plan.summary).toBe('Transform the text.');
  });

  it('passes bounded FinNLP feedback to the primary planner as separate untrusted context', async () => {
    let capturedRequest: RequestInit | undefined;
    const adapter = createOpenAICompatiblePlannerAdapter({
      baseUrl: 'https://api.example.test/v1',
      modelName: 'planner',
      apiKey: 'server-only',
      fetcher: async (_input, init) => {
        capturedRequest = init;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            summary: 'Acknowledge missing revenue evidence.',
            steps: [{
              id: 'step_1',
              title: 'Clarify revenue basis',
              description: 'Ask for reporting period and primary evidence.',
              toolId: 'echo',
              toolVersion: '1.0.0',
              input: { label: 'Clarification required' },
              dependencies: [],
              expectedOutcome: 'Missing basis is explicit.',
              verificationCriteria: 'The plan does not claim a verified figure.',
            }],
            limitations: ['No source evidence was supplied.'],
          }) } }],
        });
      },
    });

    const feedback = 'FinNLP review status: insufficient_evidence. No independent source snippets were supplied.';
    const response = await adapter.generatePlan({
      taskId: '43000000-0000-4000-8000-000000000001',
      goal: 'Explain revenue growth.',
      toolCatalog: [],
      reviewerFeedback: feedback,
    });
    const sentBody = JSON.parse(String(capturedRequest?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(sentBody.messages).toHaveLength(3);
    expect(sentBody.messages[2]?.role).toBe('user');
    expect(sentBody.messages[2]?.content).toContain(feedback);
    expect(sentBody.messages[2]?.content).toContain('untrusted advisory data');
    expect(sentBody.messages[2]?.content).not.toContain('Bearer server-only');
    expect(response.success).toBe(true);
  });

  it('sanitizes rate limits and HTTP failures', async () => {
    const adapter = (status: number) => createOpenAICompatiblePlannerAdapter({
      baseUrl: 'https://api.example.test/v1',
      modelName: 'planner',
      apiKey: 'server-only',
      fetcher: async () => new Response('sensitive provider response', { status }),
    });
    const request: PlannerRequest = { taskId: 'task', goal: 'Goal', toolCatalog: [] };
    expect(await adapter(429).generatePlan(request)).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(await adapter(500).generatePlan(request)).toMatchObject({
      success: false,
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it('sanitizes malformed provider output and bounds request time', async () => {
    const malformed = createOpenAICompatiblePlannerAdapter({
      baseUrl: 'https://api.example.test/v1',
      modelName: 'planner',
      apiKey: 'server-only',
      fetcher: async () => Response.json({ choices: [{ message: { content: '{' } }] }),
    });
    const request: PlannerRequest = { taskId: 'task', goal: 'Goal', toolCatalog: [] };
    expect(await malformed.generatePlan(request)).toMatchObject({
      success: false,
      error: { code: 'INVALID_RESPONSE' },
    });

    const timedOut = createOpenAICompatiblePlannerAdapter({
      baseUrl: 'https://api.example.test/v1',
      modelName: 'planner',
      apiKey: 'server-only',
      timeoutMs: 1,
      fetcher: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    });
    expect(await timedOut.generatePlan(request)).toMatchObject({
      success: false,
      error: { code: 'PROVIDER_TIMEOUT' },
    });
  });

  it('sanitizes provider exceptions', async () => {
    const provider = {
      providerName: 'broken',
      async generatePlan(request: { taskId: string; goal: string; toolCatalog: unknown[] }) {
        void request;
        throw new Error('secret stack trace');
      },
    };
    await expect(
      (async () => {
        try {
          return await provider.generatePlan({ taskId: 'id', goal: 'goal', toolCatalog: [] });
        } catch (error) {
          throw createPlannerError('PROVIDER_UNAVAILABLE', 'Provider is unavailable.', String(error));
        }
      })(),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
