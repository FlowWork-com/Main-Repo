import { buildToolCatalogForPlanner, createPlannerError, validatePlan, type PlannerRequest, type WorkflowPlan } from '../../../src/planning/planning.ts';
import { createPlannerAdapterFromEnvironment, type PlannerEnvironment } from '../../../src/planning/provider.ts';
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

    const plannerAdapter = createPlannerAdapterFromEnvironment(dependencies.plannerEnvironment ?? {});
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
      const plan = validatePlan(providerResponse.plan, registry, { taskId: task.id, goal: payload.goal });
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
