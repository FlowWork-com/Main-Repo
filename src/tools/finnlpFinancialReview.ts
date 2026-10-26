import {
  isCredentialLikeString,
  isPersistableJson,
  toolFailure,
  type ToolDefinition,
  type ToolExecutionContext,
} from './contracts';
import {
  FinnlpNewsProviderError,
  type FinnlpCompanyNewsInput,
  type FinnlpCompanyNewsProvider,
  type FinnlpNewsArticle,
} from './finnlpCompanyNews';

export const FINNLP_FINANCIAL_REVIEW_TOOL_ID = 'finnlp-financial-review';
export const FINNLP_FINANCIAL_REVIEW_TOOL_VERSION = '1.0.0';
export const FINNLP_FINANCIAL_REVIEW_DESCRIPTION =
  'Use FinNLP as a specialist financial-language verifier for a claim or another agent’s draft answer. It decodes ambiguous terms, separates facts from assumptions, reports source support or contradictions, and returns follow-up questions and a handoff for the main agent. Optionally retrieves bounded Finnhub company-news evidence for a ticker and date range. Advisory only: it is not the main planner, financial advice, trade execution, or approval to act.';

const maxInputBytes = 16_384;
const maxUserEvidence = 5;
const maxNewsSources = 10;

export interface FinnlpFinancialReviewEvidenceInput {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly excerpt: string;
}

export interface FinnlpFinancialReviewInput {
  readonly claim: string;
  readonly draftAnswer?: string;
  readonly ticker?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly evidence?: readonly FinnlpFinancialReviewEvidenceInput[];
}

export interface FinnlpReviewSource {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly excerpt: string;
  readonly sourceKind: 'finnhub_news' | 'user_provided_unverified';
}

export interface FinnlpFinancialReviewRequest {
  readonly claim: string;
  readonly draftAnswer?: string;
  readonly sources: readonly FinnlpReviewSource[];
}

export interface FinnlpFinancialReviewer {
  reviewFinancialClaim(
    context: ToolExecutionContext,
    request: FinnlpFinancialReviewRequest,
  ): Promise<unknown>;
}

type ReviewStatus =
  | 'supported_by_sources'
  | 'contradicted_by_sources'
  | 'mixed_evidence'
  | 'insufficient_evidence'
  | 'clarification_needed';

type FindingAssessment =
  | 'supports_claim'
  | 'contradicts_claim'
  | 'mixed'
  | 'not_verifiable';

interface FinnlpFinancialReviewFinding {
  readonly statement: string;
  readonly assessment: FindingAssessment;
  readonly explanation: string;
  readonly sourceIds: readonly string[];
}

interface FinnlpFinancialAmbiguity {
  readonly term: string;
  readonly interpretations: readonly string[];
  readonly clarificationQuestion: string;
}

interface FinnlpFinancialReviewOutput {
  readonly reviewer: 'FinNLP financial verification sidecar';
  readonly role: 'specialist_verifier_not_primary_agent';
  readonly reviewStatus: ReviewStatus;
  readonly decodedMeaning: string;
  readonly assessmentSummary: string;
  readonly findings: readonly FinnlpFinancialReviewFinding[];
  readonly ambiguities: readonly FinnlpFinancialAmbiguity[];
  readonly questionsForMainAgent: readonly string[];
  readonly nextStepForMainAgent: string;
  readonly handoffMessage: string;
  readonly sources: readonly FinnlpReviewSource[];
  readonly confidence: 'low' | 'moderate' | 'high';
  readonly confidenceNote: string;
  readonly requiresHumanReview: true;
  readonly financialAdvice: false;
  readonly executionApproval: false;
}

export function isFinnlpFinancialReviewInput(value: unknown): value is FinnlpFinancialReviewInput {
  if (!isRecord(value)) return false;
  const allowed = ['claim', 'draftAnswer', 'ticker', 'startDate', 'endDate', 'evidence'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (typeof value.claim !== 'string' || !isSafeInputText(value.claim, 2_000, true)) return false;
  if (value.draftAnswer !== undefined &&
    (typeof value.draftAnswer !== 'string' || !isSafeInputText(value.draftAnswer, 4_000, false))) {
    return false;
  }

  const hasTicker = value.ticker !== undefined;
  const hasStart = value.startDate !== undefined;
  const hasEnd = value.endDate !== undefined;
  if (hasTicker || hasStart || hasEnd) {
    if (!hasTicker || !hasStart || !hasEnd) return false;
    if (typeof value.ticker !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(value.ticker.trim())) {
      return false;
    }
    if (typeof value.startDate !== 'string' || !isCalendarDate(value.startDate)) return false;
    if (typeof value.endDate !== 'string' || !isCalendarDate(value.endDate)) return false;
    if (value.startDate > value.endDate || value.endDate > new Date().toISOString().slice(0, 10)) {
      return false;
    }
    const days = Math.floor((Date.parse(value.endDate) - Date.parse(value.startDate)) / 86_400_000) + 1;
    if (days < 1 || days > 31) return false;
  }

  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence) || value.evidence.length > maxUserEvidence) return false;
    const ids = new Set<string>();
    for (const evidence of value.evidence) {
      if (!isRecord(evidence) ||
        Object.keys(evidence).some((key) => !['id', 'title', 'url', 'excerpt'].includes(key)) ||
        typeof evidence.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(evidence.id) ||
        ids.has(evidence.id) ||
        typeof evidence.title !== 'string' ||
        !isSafeInputText(evidence.title, 160, true) ||
        typeof evidence.excerpt !== 'string' ||
        !isSafeInputText(evidence.excerpt, 1_500, true)) {
        return false;
      }
      if (evidence.url !== undefined &&
        (typeof evidence.url !== 'string' || !isSafeHttpsUrl(evidence.url))) {
        return false;
      }
      ids.add(evidence.id);
    }
  }

  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxInputBytes;
  } catch {
    return false;
  }
}

export function createFinnlpFinancialReviewTool(
  newsProvider?: FinnlpCompanyNewsProvider,
  reviewer?: FinnlpFinancialReviewer,
): ToolDefinition {
  return {
    id: FINNLP_FINANCIAL_REVIEW_TOOL_ID,
    name: 'FinNLP financial review',
    description: FINNLP_FINANCIAL_REVIEW_DESCRIPTION,
    version: FINNLP_FINANCIAL_REVIEW_TOOL_VERSION,
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      required: ['claim'],
      additionalProperties: false,
      properties: {
        claim: { type: 'string', minLength: 1, maxLength: 2_000 },
        draftAnswer: { type: 'string', maxLength: 4_000 },
        ticker: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,9}$' },
        startDate: { type: 'string', format: 'date' },
        endDate: { type: 'string', format: 'date' },
        evidence: {
          type: 'array',
          maxItems: maxUserEvidence,
          items: {
            type: 'object',
            required: ['id', 'title', 'excerpt'],
            additionalProperties: false,
          },
        },
      },
      maxInputBytes,
      maxNewsSources,
    },
    validateInput: isFinnlpFinancialReviewInput,
    async execute(context, input) {
      if (!isFinnlpFinancialReviewInput(input)) {
        return toolFailure(
          'INVALID_TOOL_INPUT',
          'Provide a short financial claim or draft answer, with optional bounded evidence and an all-or-none ticker/date range.',
        );
      }
      if (!reviewer) {
        return toolFailure(
          'EXECUTOR_UNAVAILABLE',
          'The FinNLP financial reviewer is not configured for this environment.',
          false,
        );
      }

      const sources: FinnlpReviewSource[] = [];
      for (const [index, evidence] of (input.evidence ?? []).entries()) {
        sources.push({
          id: `provided-${index + 1}`,
          title: cleanText(evidence.title, 160),
          url: evidence.url ? safeSourceUrl(evidence.url) : null,
          publishedAt: null,
          excerpt: cleanText(evidence.excerpt, 600),
          sourceKind: 'user_provided_unverified',
        });
      }

      if (input.ticker && input.startDate && input.endDate) {
        if (!newsProvider) {
          return toolFailure(
            'EXECUTOR_UNAVAILABLE',
            'Finnhub evidence retrieval is not configured. No provider-backed verification was performed.',
            false,
          );
        }
        const newsInput: FinnlpCompanyNewsInput = {
          ticker: input.ticker.trim().toUpperCase(),
          startDate: input.startDate,
          endDate: input.endDate,
        };
        let articles: readonly FinnlpNewsArticle[];
        try {
          articles = await newsProvider.fetchCompanyNews(context, newsInput);
        } catch (error) {
          return toolFailure(
            'EXECUTOR_UNAVAILABLE',
            newsProviderErrorMessage(error),
            error instanceof FinnlpNewsProviderError &&
              (error.kind === 'RATE_LIMITED' || error.kind === 'TIMEOUT' || error.kind === 'UNAVAILABLE'),
          );
        }
        for (const article of articles.slice(0, maxNewsSources)) {
          const title = cleanText(article.headline, 260);
          const excerpt = cleanText(article.summary, 600);
          if (!title && !excerpt) continue;
          sources.push({
            id: `news-${sources.filter((source) => source.sourceKind === 'finnhub_news').length + 1}`,
            title: title || 'Company news article',
            url: article.url ? safeSourceUrlOrNull(article.url) : null,
            publishedAt: normalizeTimestamp(article.publishedAt),
            excerpt: excerpt || title,
            sourceKind: 'finnhub_news',
          });
        }
      }

      let rawReview: unknown;
      try {
        rawReview = await reviewer.reviewFinancialClaim(context, {
          claim: input.claim.trim(),
          ...(input.draftAnswer ? { draftAnswer: input.draftAnswer.trim() } : {}),
          sources,
        });
      } catch (error) {
        return toolFailure(
          error instanceof FinnlpFinancialReviewProviderError && error.kind === 'TIMEOUT'
            ? 'EXECUTION_TIMEOUT'
            : 'EXECUTOR_UNAVAILABLE',
          reviewProviderErrorMessage(error),
          error instanceof FinnlpFinancialReviewProviderError &&
            (error.kind === 'TIMEOUT' || error.kind === 'RATE_LIMITED' || error.kind === 'UNAVAILABLE'),
        );
      }

      const output = normalizeReview(rawReview, sources);
      if (!output || !isPersistableJson(output)) {
        return toolFailure(
          'EXECUTION_FAILED',
          'The financial review could not be validated safely. No verification result was recorded.',
        );
      }
      return {
        success: true,
        output,
        evidence: {
          type: 'financial-review',
          reference: `finnlp-review://task/${context.taskId}/execution/${context.executionId}`,
          summary: `FinNLP financial review: ${output.reviewStatus}; human review required.`,
        },
      };
    },
  };
}

export class FinnlpFinancialReviewProviderError extends Error {
  constructor(
    readonly kind: 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE' | 'INVALID_RESPONSE',
  ) {
    super(kind);
  }
}

function normalizeReview(
  value: unknown,
  sources: readonly FinnlpReviewSource[],
): FinnlpFinancialReviewOutput | null {
  if (!isRecord(value)) return null;
  const statuses: readonly ReviewStatus[] = [
    'supported_by_sources',
    'contradicted_by_sources',
    'mixed_evidence',
    'insufficient_evidence',
    'clarification_needed',
  ];
  const assessments: readonly FindingAssessment[] = [
    'supports_claim',
    'contradicts_claim',
    'mixed',
    'not_verifiable',
  ];
  const confidenceLevels = ['low', 'moderate', 'high'] as const;
  if (typeof value.reviewStatus !== 'string' || !statuses.includes(value.reviewStatus as ReviewStatus)) {
    return null;
  }

  const knownSourceIds = new Set(sources.map((source) => source.id));
  const rawFindings = value.findings === undefined ? [] : value.findings;
  if (!Array.isArray(rawFindings) || rawFindings.length > 8) return null;
  const findings: FinnlpFinancialReviewFinding[] = [];
  for (const finding of rawFindings) {
    if (!isRecord(finding) ||
      typeof finding.statement !== 'string' ||
      typeof finding.assessment !== 'string' ||
      !assessments.includes(finding.assessment as FindingAssessment) ||
      typeof finding.explanation !== 'string' ||
      !Array.isArray(finding.sourceIds) ||
      finding.sourceIds.length > 6 ||
      !finding.sourceIds.every((id) => typeof id === 'string' && knownSourceIds.has(id))) {
      return null;
    }
    const statement = safeOutputText(finding.statement, 400);
    const explanation = safeOutputText(finding.explanation, 700);
    if (!statement || !explanation) return null;
    const sourceIds = [...new Set(finding.sourceIds as string[])];
    findings.push({
      statement,
      assessment: sourceIds.length ? finding.assessment as FindingAssessment : 'not_verifiable',
      explanation,
      sourceIds,
    });
  }

  const rawAmbiguities = value.ambiguities === undefined ? [] : value.ambiguities;
  if (!Array.isArray(rawAmbiguities) || rawAmbiguities.length > 4) return null;
  const ambiguities: FinnlpFinancialAmbiguity[] = [];
  for (const ambiguity of rawAmbiguities) {
    if (!isRecord(ambiguity) ||
      typeof ambiguity.term !== 'string' ||
      !Array.isArray(ambiguity.interpretations) ||
      ambiguity.interpretations.length > 4 ||
      !ambiguity.interpretations.every((item) => typeof item === 'string') ||
      typeof ambiguity.clarificationQuestion !== 'string') return null;
    const term = safeOutputText(ambiguity.term, 100);
    const interpretations = ambiguity.interpretations.map((item) => safeOutputText(item, 260));
    const clarificationQuestion = safeOutputText(ambiguity.clarificationQuestion, 400);
    if (!term || !clarificationQuestion || interpretations.some((item) => !item)) return null;
    ambiguities.push({
      term,
      interpretations: interpretations.filter(Boolean) as string[],
      clarificationQuestion,
    });
  }

  const questionsForMainAgent = readTextList(value.questionsForMainAgent, 4, 320);
  const decodedMeaning = safeOutputText(value.decodedMeaning, 1_000);
  const assessmentSummary = safeOutputText(value.assessmentSummary, 1_000);
  const nextStepForMainAgent = safeOutputText(value.nextStepForMainAgent, 500);
  if (!decodedMeaning || !assessmentSummary || !nextStepForMainAgent ||
    !questionsForMainAgent) return null;

  let reviewStatus = value.reviewStatus as ReviewStatus;
  const hasProviderSource = sources.some((source) => source.sourceKind === 'finnhub_news');
  const hasLinkedFinding = findings.some((finding) => finding.sourceIds.length > 0);
  if (reviewStatus !== 'clarification_needed' && (!hasProviderSource || !hasLinkedFinding)) {
    reviewStatus = 'insufficient_evidence';
  }
  if (!hasProviderSource && findings.length > 0) {
    for (let index = 0; index < findings.length; index += 1) {
      findings[index] = { ...findings[index], assessment: 'not_verifiable' };
    }
  }

  const confidence = confidenceLevels.includes(value.confidence as typeof confidenceLevels[number])
    ? value.confidence as typeof confidenceLevels[number]
    : 'low';
  const handoffMessage = [
    `FinNLP review status: ${reviewStatus}.`,
    assessmentSummary,
    ambiguities.length ? `Ambiguities to resolve: ${ambiguities.map((item) => item.term).join(', ')}.` : '',
    questionsForMainAgent.length ? `Questions: ${questionsForMainAgent.join(' ')}` : '',
    `Next step: ${nextStepForMainAgent}`,
    'Advisory evidence triage only; not financial advice, execution approval, or proof of factual correctness.',
  ].filter(Boolean).join(' ');

  return {
    reviewer: 'FinNLP financial verification sidecar',
    role: 'specialist_verifier_not_primary_agent',
    reviewStatus,
    decodedMeaning,
    assessmentSummary,
    findings,
    ambiguities,
    questionsForMainAgent,
    nextStepForMainAgent,
    handoffMessage: safeOutputText(handoffMessage, 2_800) ?? 'FinNLP provided a structured review. Human review remains required; do not treat it as financial advice or execution approval.',
    sources: sources.slice(0, maxUserEvidence + maxNewsSources),
    confidence,
    confidenceNote: 'Qualitative model estimate, not a calibrated probability. Source citations do not independently establish truth.',
    requiresHumanReview: true,
    financialAdvice: false,
    executionApproval: false,
  };
}

function readTextList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string')) {
    return null;
  }
  const values = value.map((item) => safeOutputText(item, maxLength));
  return values.some((item) => !item) ? null : values;
}

function newsProviderErrorMessage(error: unknown): string {
  if (!(error instanceof FinnlpNewsProviderError)) {
    return 'Company-news evidence could not be retrieved. No provider-backed review was performed.';
  }
  switch (error.kind) {
    case 'NOT_CONNECTED':
      return 'Connect FinNLP/Finnhub for this workspace before requesting provider-backed review.';
    case 'UNAUTHORIZED':
      return 'The connected news credential was rejected. Reconnect or rotate it before retrying.';
    case 'RATE_LIMITED':
      return 'The news provider is rate limiting requests. Try again shortly.';
    case 'TIMEOUT':
      return 'Company-news retrieval timed out. No provider-backed review was performed.';
    case 'INVALID_RESPONSE':
      return 'The news provider returned an invalid response. No provider-backed review was performed.';
    case 'UNAVAILABLE':
      return 'The news provider is temporarily unavailable. No provider-backed review was performed.';
  }
}

function reviewProviderErrorMessage(error: unknown): string {
  if (!(error instanceof FinnlpFinancialReviewProviderError)) {
    return 'The FinNLP financial reviewer is temporarily unavailable.';
  }
  switch (error.kind) {
    case 'NOT_CONFIGURED':
      return 'Configure the server-side FinNLP review provider before using this tool.';
    case 'UNAUTHORIZED':
      return 'The configured FinNLP review provider rejected its server-side credential.';
    case 'RATE_LIMITED':
      return 'The FinNLP review provider is rate limiting requests. Try again shortly.';
    case 'TIMEOUT':
      return 'The FinNLP financial review timed out. Try again with a shorter claim or less evidence.';
    case 'INVALID_RESPONSE':
      return 'The FinNLP review provider returned an invalid response.';
    case 'UNAVAILABLE':
      return 'The FinNLP review provider is temporarily unavailable.';
  }
}

function isSafeInputText(value: string, maxLength: number, required: boolean): boolean {
  if (value.length > maxLength || (required && !value.trim()) || isCredentialLikeString(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code === 0x7f) return false;
  }
  return true;
}

function safeOutputText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || isCredentialLikeString(value)) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
    if (code === 0x7f) return null;
  }
  return value.trim();
}

function cleanText(value: string, maxLength: number): string {
  if (isCredentialLikeString(value)) return '[source text redacted]';
  let safe = '';
  for (let index = 0; index < value.length && safe.length < maxLength; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20 && code !== 0x7f) {
      safe += value[index];
    } else {
      safe += ' ';
    }
  }
  return safe.trim();
}

function safeSourceUrl(value: string): string {
  if (!isSafeHttpsUrl(value)) throw new Error('Invalid source URL');
  return new URL(value).toString();
}

function safeSourceUrlOrNull(value: string): string | null {
  try {
    return safeSourceUrl(value);
  } catch {
    return null;
  }
}

function isSafeHttpsUrl(value: string): boolean {
  if (value.length > 512 || isCredentialLikeString(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    for (const key of url.searchParams.keys()) {
      if (/(token|secret|api.?key|auth|credential|password)/i.test(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
