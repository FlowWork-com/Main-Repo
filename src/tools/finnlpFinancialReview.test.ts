import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from './contracts';
import {
  createFinnlpFinancialReviewTool,
  isFinnlpFinancialReviewInput,
  type FinnlpFinancialReviewInput,
} from './finnlpFinancialReview';
import { FinnlpNewsProviderError } from './finnlpCompanyNews';

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

const validInput: FinnlpFinancialReviewInput = {
  claim: 'Revenue increased 8% year over year. Does the draft explain that correctly?',
  draftAnswer: 'The company experienced year-over-year revenue growth.',
};

function reviewResult(sourceIds: string[] = ['provided-1']) {
  return {
    reviewStatus: 'supported_by_sources',
    decodedMeaning: 'Year over year compares a period with the same period one year earlier.',
    assessmentSummary: 'The phrasing is consistent with the supplied evidence, but the excerpt has not been independently verified.',
    findings: [{
      statement: 'The percentage compares comparable annual periods.',
      assessment: 'supports_claim',
      explanation: 'The supplied description states a year-over-year comparison.',
      sourceIds,
    }],
    ambiguities: [{
      term: 'Revenue increased',
      interpretations: ['Nominal revenue increased.', 'Revenue increased after currency or inflation adjustment.'],
      clarificationQuestion: 'Does the claim mean reported nominal revenue or a currency-adjusted figure?',
    }],
    questionsForMainAgent: ['Confirm the accounting basis and reporting period.'],
    nextStepForMainAgent: 'Keep the limitation in the final result until the reporting basis is confirmed.',
    confidence: 'moderate',
  };
}

describe('FinNLP financial review sidecar', () => {
  it('validates the narrow input contract and rejects arbitrary URLs or keys', () => {
    expect(isFinnlpFinancialReviewInput(validInput)).toBe(true);
    expect(isFinnlpFinancialReviewInput({ ...validInput, endpoint: 'https://attacker.test' })).toBe(false);
    expect(isFinnlpFinancialReviewInput({ ...validInput, ticker: 'AAPL' })).toBe(false);
    expect(isFinnlpFinancialReviewInput({
      claim: 'Is this statement supported?',
      evidence: [{
        id: 'source-1',
        title: 'Article',
        excerpt: 'Snippet',
        url: 'javascript:alert(1)',
      }],
    })).toBe(false);
    expect(isFinnlpFinancialReviewInput({ claim: 'Use key Bearer abcdefghijklmnop to inspect this.' })).toBe(false);
    expect(isFinnlpFinancialReviewInput({
      claim: 'Is the report clear?',
      ticker: 'AAPL',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    })).toBe(false);
    expect(isFinnlpFinancialReviewInput({
      claim: 'Is this supported?',
      evidence: Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        title: 'Evidence',
        excerpt: 'Content',
      })),
    })).toBe(false);
  });

  it('returns a durable advisory handoff and labels user-supplied sources as unverified', async () => {
    const reviewer = {
      reviewFinancialClaim: vi.fn(async (_ctx, request) => {
        expect(request.sources[0]).toMatchObject({
          id: 'provided-1',
          sourceKind: 'user_provided_unverified',
          url: 'https://example.test/source',
        });
        return reviewResult();
      }),
    };
    const tool = createFinnlpFinancialReviewTool(undefined, reviewer);
    const result = await tool.execute(context, {
      ...validInput,
      evidence: [{
        id: 'source-1',
        title: 'Quarterly report excerpt',
        url: 'https://example.test/source',
        excerpt: 'Revenue grew 8% year over year.',
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toMatchObject({
        reviewer: 'FinNLP financial verification sidecar',
        role: 'specialist_verifier_not_primary_agent',
        reviewStatus: 'insufficient_evidence',
        requiresHumanReview: true,
        financialAdvice: false,
        executionApproval: false,
      });
      expect(result.output).toHaveProperty('handoffMessage');
      expect(result.evidence?.type).toBe('financial-review');
      expect(result.evidence?.reference).toContain(context.taskId);
    }
    expect(reviewer.reviewFinancialClaim).toHaveBeenCalledTimes(1);
  });

  it('uses company news only when a ticker and complete bounded date range are supplied', async () => {
    const news = {
      fetchCompanyNews: vi.fn(async (_ctx, input) => {
        expect(input.ticker).toBe('AAPL');
        return [{
          id: 'article-1',
          headline: 'Reported revenue rises',
          summary: 'A source report discusses quarterly revenue.',
          source: 'Example News',
          url: 'https://news.example.test/item',
          publishedAt: '2026-10-20T00:00:00.000Z',
        }];
      }),
    };
    const reviewer = {
      reviewFinancialClaim: vi.fn(async (_ctx, request) => {
        expect(request.sources).toHaveLength(1);
        expect(request.sources[0]).toMatchObject({
          id: 'news-1',
          sourceKind: 'finnhub_news',
          url: 'https://news.example.test/item',
        });
        return reviewResult(['news-1']);
      }),
    };
    const tool = createFinnlpFinancialReviewTool(news, reviewer);
    const result = await tool.execute(context, {
      claim: 'Did the source support the revenue statement?',
      ticker: 'aapl',
      startDate: '2026-10-01',
      endDate: '2026-10-26',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toMatchObject({
        reviewStatus: 'supported_by_sources',
        sources: [{ id: 'news-1', sourceKind: 'finnhub_news' }],
      });
    }
    expect(news.fetchCompanyNews).toHaveBeenCalledTimes(1);
  });

  it('fails closed when provider citations are invented or provider retrieval fails', async () => {
    const fakeReviewer = {
      reviewFinancialClaim: vi.fn(async () => reviewResult(['invented-source-id'])),
    };
    const tool = createFinnlpFinancialReviewTool(undefined, fakeReviewer);
    await expect(tool.execute(context, {
      ...validInput,
      evidence: [{ id: 'source-1', title: 'Report', excerpt: 'A bounded source excerpt.' }],
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTION_FAILED' },
    });

    const news = { fetchCompanyNews: vi.fn(async () => { throw new FinnlpNewsProviderError('NOT_CONNECTED'); }) };
    const reviewer = { reviewFinancialClaim: vi.fn() };
    const withNews = createFinnlpFinancialReviewTool(news, reviewer);
    await expect(withNews.execute(context, {
      claim: 'Check this financial claim.',
      ticker: 'AAPL',
      startDate: '2026-10-01',
      endDate: '2026-10-26',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_UNAVAILABLE' },
    });
    expect(reviewer.reviewFinancialClaim).not.toHaveBeenCalled();
  });

  it('fails closed when no reviewer provider is configured', async () => {
    const tool = createFinnlpFinancialReviewTool();
    await expect(tool.execute(context, validInput)).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_UNAVAILABLE' },
    });
  });
});
