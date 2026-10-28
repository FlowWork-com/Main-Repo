import { buildToolCatalogForPlanner, createPlannerError, validatePlan, type PlannerAdapter, type PlannerRequest, type WorkflowPlan } from '../../../src/planning/planning.ts';
import { createPlannerAdapterFromEnvironment, type PlannerEnvironment } from '../../../src/planning/provider.ts';
import { isCredentialLikeString } from '../../../src/tools/contracts.ts';
import { normalizeFinnlpFinancialReview, type FinnlpFinancialReviewer } from '../../../src/tools/finnlpFinancialReview.ts';
import { createMvpTools } from '../../../src/tools/mvpTools.ts';
import { ToolRegistry } from '../../../src/tools/toolRegistry.ts';

const maxRequestBytes = 65_536;
const allowedRequestKeys = new Set(['taskId', 'goal']);

export interface AuthenticatedCaller<Context> {
  readonly userId: string;
  readonly context: Context;
}

export interface PlanWorkflowPayload {
  readonly taskId: string;
  readonly goal: string;
}

export interface PlanWorkflowDependencies<Context> {
  readonly origins: ReadonlySet<string>;
  readonly plannerEnvironment?: PlannerEnvironment;
  readonly createPlannerAdapter?: (environment: PlannerEnvironment) => PlannerAdapter | null;
  readonly financialReviewer?: FinnlpFinancialReviewer;
  readonly authenticate: (
    accessToken: string,
  ) => Promise<AuthenticatedCaller<Context> | null>;
  readonly loadTask: (
    caller: AuthenticatedCaller<Context>,
    taskId: string,
  ) => Promise<{
    readonly id: string;
    readonly workspaceId: string;
    readonly ownerId: string;
    readonly title: string;
    readonly details: string;
    readonly availableAttachments?: readonly {
      readonly id: string;
      readonly fileName: string;
      readonly contentType: string | null;
    }[];
  } | null>;
  readonly persistPlan: (
    caller: AuthenticatedCaller<Context>,
    task: { readonly id: string; readonly workspaceId: string },
    plan: WorkflowPlan,
  ) => Promise<WorkflowPlan>;
  readonly logFailure?: (code: string) => void;
}

export class PlanRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createPlanWorkflowHandler<Context>(
  dependencies: PlanWorkflowDependencies<Context>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get('origin');
    if (origin && !dependencies.origins.has(origin)) {
      return jsonResponse(403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed.' } });
    }
    const corsHeaders = origin ? createCorsHeaders(origin) : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported.', corsHeaders);
    }

    let payload: PlanWorkflowPayload;
    try {
      payload = await readPayload(request);
    } catch (error) {
      const failure = error instanceof PlanRequestError ? error : new PlanRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
      return errorResponse(failure.status, failure.code, failure.publicMessage, corsHeaders);
    }

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return errorResponse(401, 'AUTHENTICATION_REQUIRED', 'A valid sign-in is required.', corsHeaders);
    }

    let caller: AuthenticatedCaller<Context> | null;
    try {
      caller = await dependencies.authenticate(match[1]);
    } catch {
      dependencies.logFailure?.('AUTHENTICATION_UNAVAILABLE');
      return errorResponse(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication is temporarily unavailable.', corsHeaders);
    }
    if (!caller || !isUuid(caller.userId)) {
      return errorResponse(401, 'INVALID_AUTHENTICATION', 'A valid sign-in is required.', corsHeaders);
    }

    let task: {
      readonly id: string;
      readonly workspaceId: string;
      readonly ownerId: string;
      readonly title: string;
      readonly details: string;
      readonly availableAttachments?: readonly {
        readonly id: string;
        readonly fileName: string;
        readonly contentType: string | null;
      }[];
    } | null;
    try {
      task = await dependencies.loadTask(caller, payload.taskId);
    } catch {
      return errorResponse(403, 'PERMISSION_DENIED', 'Workspace access is required to generate a plan.', corsHeaders);
    }
    if (!task || task.id !== payload.taskId) {
      return errorResponse(403, 'PERMISSION_DENIED', 'Workspace access is required to generate a plan.', corsHeaders);
    }

    const registry = new ToolRegistry();
    for (const tool of createMvpTools({ async getTaskFileMetadata() { return null; } })) {
      registry.register(tool);
    }

    const plannerEnvironment = dependencies.plannerEnvironment ?? {};
    const plannerAdapter = dependencies.createPlannerAdapter
      ? dependencies.createPlannerAdapter(plannerEnvironment)
      : createPlannerAdapterFromEnvironment(plannerEnvironment);
    if (!plannerAdapter) {
      return errorResponse(503, 'PLANNER_NOT_CONFIGURED', 'The planner is not configured.', corsHeaders);
    }

    const requestBody: PlannerRequest = {
      taskId: task.id,
      goal: payload.goal,
      toolCatalog: buildToolCatalogForPlanner(registry),
      availableAttachments: task.availableAttachments ?? [],
    };

    try {
      const providerResponse = await plannerAdapter.generatePlan(requestBody);
      if (!providerResponse.success) {
        return errorResponse(502, providerResponse.error.code, providerResponse.error.message, corsHeaders);
      }
      let plan = validatePlan(providerResponse.plan, registry, { taskId: task.id, goal: payload.goal });
      if (isFinanciallyRelevant(payload.goal, plan)) {
        plan = await applyFinnlpReviewAndRefinePlan(
          dependencies,
          plannerAdapter,
          requestBody,
          registry,
          plan,
          payload.goal,
        );
      }
      if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > maxRequestBytes) {
        throw createPlannerError('INVALID_PLAN', 'The proposed plan is too large to save.');
      }
      let persistedPlan: WorkflowPlan;
      try {
        persistedPlan = await dependencies.persistPlan(caller, {
          id: task.id,
          workspaceId: task.workspaceId,
        }, plan);
      } catch {
        dependencies.logFailure?.('PLAN_PERSISTENCE_FAILED');
        return errorResponse(503, 'PLAN_PERSISTENCE_FAILED', 'Unable to save the proposed plan. Try again.', corsHeaders);
      }
      return jsonResponse(200, { plan: persistedPlan }, corsHeaders);
    } catch (error) {
      if (error instanceof Error && error.name === 'PlannerError') {
        const plannerError = error as Error & { code?: string; details?: string };
        return errorResponse(400, plannerError.code ?? 'INVALID_PLAN', plannerError.message, corsHeaders);
      }
      dependencies.logFailure?.('PLAN_PROVIDER_UNAVAILABLE');
      return errorResponse(503, 'PROVIDER_UNAVAILABLE', 'The planner provider is temporarily unavailable.', corsHeaders);
    }
  };
}

function isFinanciallyRelevant(goal: string, plan: WorkflowPlan): boolean {
  const reviewText = [
    goal,
    plan.summary,
    ...plan.steps.map((step) => `${step.title} ${step.description} ${step.expectedOutcome}`),
  ].join(' ');
  if (plan.steps.some((step) => step.toolId === 'finnlp-financial-review')) return true;
  return /\b(?:financial|finance|accounting|accountant|invoice|revenue|sales|earnings|profit|loss|cash flow|balance sheet|income statement|ebitda|net income|gross margin|operating margin|fiscal|quarterly|year.over.year|yoy|eps|roi|roe|debt|credit|interest rate|yield|currency|exchange rate|forex|stock|share price|market cap|valuation|dividend|portfolio|accounts payable|accounts receivable)\b/i.test(reviewText);
}

async function applyFinnlpReviewAndRefinePlan<Context>(
  dependencies: PlanWorkflowDependencies<Context>,
  plannerAdapter: PlannerAdapter,
  requestBody: PlannerRequest,
  registry: ToolRegistry,
  initialPlan: WorkflowPlan,
  goal: string,
): Promise<WorkflowPlan> {
  if (!dependencies.financialReviewer) {
    return appendPlanLimitations(initialPlan, [
      'FinNLP sidecar is not configured; financial language and claims were not reviewed by the specialist verifier.',
    ]);
  }

  const draftAnswer = [
    `Initial plan summary: ${initialPlan.summary}`,
    ...initialPlan.steps.slice(0, 10).map((step, index) =>
      `${index + 1}. ${step.title}: ${step.description}. Expected outcome: ${step.expectedOutcome}`),
    ...initialPlan.limitations.slice(0, 3).map((limitation) => `Existing limitation: ${limitation}`),
  ].join('\n').slice(0, 3_500);
  if (isCredentialLikeString(goal) || isCredentialLikeString(draftAnswer)) {
    return appendPlanLimitations(initialPlan, [
      'FinNLP review was skipped because credential-like text was detected; no specialist review or financial verification was performed.',
    ]);
  }

  let review: ReturnType<typeof normalizeFinnlpFinancialReview>;
  try {
    const rawReview = await dependencies.financialReviewer.reviewFinancialClaim(
      { signal: new AbortController().signal },
      { claim: goal, draftAnswer, sources: [] },
    );
    review = normalizeFinnlpFinancialReview(rawReview, []);
  } catch {
    dependencies.logFailure?.('FINNLP_REVIEW_UNAVAILABLE');
    return appendPlanLimitations(initialPlan, [
      'FinNLP sidecar could not complete its review; the original plan was retained without specialist feedback and no financial verification was performed.',
    ]);
  }
  if (!review) {
    dependencies.logFailure?.('FINNLP_REVIEW_INVALID');
    return appendPlanLimitations(initialPlan, [
      'FinNLP sidecar returned an invalid review; the original plan was retained and no financial verification was performed.',
    ]);
  }

  const reviewNotes = createFinNlpPlanNotes(review);
  try {
    const refinedResponse = await plannerAdapter.generatePlan({
      ...requestBody,
      reviewerFeedback: review.handoffMessage,
    });
    if (!refinedResponse.success) {
      dependencies.logFailure?.('FINNLP_PLAN_REFINEMENT_FAILED');
      return appendPlanLimitations(initialPlan, [
        'FinNLP supplied feedback, but the main planner could not revise its draft; the original plan is retained and needs human review.',
        ...reviewNotes,
      ]);
    }
    const refinedPlan = validatePlan(refinedResponse.plan, registry, {
      taskId: requestBody.taskId,
      goal: requestBody.goal,
    });
    return appendPlanLimitations(refinedPlan, reviewNotes);
  } catch {
    dependencies.logFailure?.('FINNLP_PLAN_REFINEMENT_INVALID');
    return appendPlanLimitations(initialPlan, [
      'FinNLP supplied feedback, but the main planner produced an invalid or unavailable revision; the original plan is retained and needs human review.',
      ...reviewNotes,
    ]);
  }
}

function createFinNlpPlanNotes(
  review: NonNullable<ReturnType<typeof normalizeFinnlpFinancialReview>>,
): string[] {
  const ambiguitySummary = review.ambiguities.slice(0, 3)
    .map((item) => `${item.term}: ${item.clarificationQuestion}`)
    .join(' | ');
  const questionSummary = review.questionsForMainAgent.slice(0, 3).join(' | ');
  return [
    `FinNLP review status: ${review.reviewStatus}. Human review is still required; model confidence is a qualitative self-assessment only.`,
    `FinNLP decoded meaning: ${review.decodedMeaning}`,
    `FinNLP evidence assessment: ${review.assessmentSummary}`,
    ambiguitySummary || questionSummary
      ? `FinNLP clarification: ${[ambiguitySummary, questionSummary].filter(Boolean).join(' | ')}`
      : 'FinNLP clarification: no specific ambiguity was returned; verify material financial claims against primary evidence.',
    `FinNLP next step: ${review.nextStepForMainAgent}.`,
    'No independent source snippets were supplied during planning review, so this is not factual verification.',
  ];
}

function appendPlanLimitations(plan: WorkflowPlan, notes: readonly string[]): WorkflowPlan {
  const noEvidenceCaveat =
    'No independent source snippets were supplied during planning review, so this is not factual verification.';
  const normalizedNotes = notes
    .map((note) => note.replace(/\s+/g, ' ').trim().slice(0, 390))
    .filter(Boolean);
  const includesMandatoryCaveat = normalizedNotes.includes(noEvidenceCaveat);
  const mandatoryNotes = includesMandatoryCaveat ? [noEvidenceCaveat] : [];
  const additions = normalizedNotes
    .filter((note) => note !== noEvidenceCaveat)
    .slice(0, 5 - mandatoryNotes.length);
  let limitations = [...plan.limitations];
  if (limitations.length + additions.length + mandatoryNotes.length > 20) {
    const keep = Math.max(0, 20 - additions.length - mandatoryNotes.length - 1);
    limitations = [
      ...limitations.slice(0, keep),
      'Some original plan limitations were omitted to preserve the bounded FinNLP review handoff.',
    ];
  }
  return {
    ...plan,
    limitations: [...limitations, ...additions, ...mandatoryNotes].slice(0, 20),
  };
}

async function readPayload(request: Request): Promise<PlanWorkflowPayload> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxRequestBytes) {
    throw new PlanRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
  }
  if (!request.body) {
    throw new PlanRequestError(400, 'INVALID_REQUEST', 'Request body is required.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxRequestBytes) {
        await reader.cancel();
        throw new PlanRequestError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PlanRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PlanRequestError(400, 'INVALID_REQUEST', 'Request body is invalid.');
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedRequestKeys.has(key))) {
    throw new PlanRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  }
  const taskId = value.taskId;
  const goal = value.goal;
  if (!isUuid(taskId) || typeof goal !== 'string' || !goal.trim() || goal.length > 2000) {
    throw new PlanRequestError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  }
  return { taskId, goal: goal.trim() };
}

function errorResponse(status: number, code: string, message: string, headers: HeadersInit): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function createCorsHeaders(origin: string): HeadersInit {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
