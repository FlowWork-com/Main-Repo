import {
  createPlannerError,
  type PlannerAdapter,
  type PlannerErrorCode,
  type PlannerRequest,
  type PlannerResponse,
  type WorkflowPlan,
} from './planning';
import type { ToolMetadata } from '../tools/contracts';

export interface PlannerEnvironment {
  readonly FLOWWORK_PLANNER_PROVIDER?: string;
  readonly FLOWWORK_PLANNER_MODEL?: string;
  readonly FLOWWORK_PLANNER_API_KEY?: string;
}

export function createPlannerAdapterFromEnvironment(
  env: PlannerEnvironment = getRuntimeEnvironment(),
): PlannerAdapter | null {
  const providerName = (env.FLOWWORK_PLANNER_PROVIDER ?? '').trim().toLowerCase();
  if (!providerName) return null;
  if (providerName === 'mock') {
    return createMockPlannerAdapter({
      providerName: 'mock',
      modelName: env.FLOWWORK_PLANNER_MODEL || 'mock-model',
    });
  }
  return null;
}

export function createMockPlannerAdapter(
  config: {
    readonly providerName?: string;
    readonly modelName?: string;
  } = {},
): PlannerAdapter {
  const providerName = config.providerName ?? 'mock-planner';
  const modelName = config.modelName ?? 'mock-model';

  return {
    providerName,
    async generatePlan(request: PlannerRequest): Promise<PlannerResponse> {
      try {
        const toolCatalog = request.toolCatalog.length
          ? request.toolCatalog
          : [{
              id: 'echo',
              name: 'Echo',
              description: 'Return a JSON value without changing it.',
              version: '1.0.0',
              riskLevel: 'low',
              requiresApproval: false,
              inputSchema: { type: 'any-json-value' },
            } as ToolMetadata];

        const plan: WorkflowPlan = {
          id: `plan_${Date.now()}`,
          taskId: request.taskId,
          goal: request.goal,
          summary: `Plan for ${modelName}: ${request.goal.slice(0, 120)}`,
          steps: [
            {
              id: `step_1`,
              title: 'Transform the requested value',
              description: 'Use the available echo tool to capture and return the requested result.',
              toolId: toolCatalog[0]?.id ?? 'echo',
              toolVersion: toolCatalog[0]?.version ?? '1.0.0',
              input: { value: request.goal },
              dependencies: [],
              expectedOutcome: 'The requested goal is captured in a structured output.',
              verificationCriteria: 'The output includes the supplied goal text.',
              validation: { valid: true, blockingReasons: [] },
            },
          ],
          dependencies: [],
          createdAt: new Date().toISOString(),
          version: 1,
          validationStatus: 'valid',
          limitations: [],
        };

        return { success: true, plan };
      } catch (error) {
        throw createPlannerError(
          'PROVIDER_UNAVAILABLE',
          'The planner provider is unavailable.',
          error instanceof Error ? error.message : undefined,
        );
      }
    },
  };
}

export function adaptPlannerError(code: PlannerErrorCode, message: string): PlannerResponse {
  return {
    success: false,
    error: {
      code,
      message: sanitizePlannerMessage(message),
    },
  };
}

function sanitizePlannerMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function getRuntimeEnvironment(): PlannerEnvironment {
  const runtime = globalThis as typeof globalThis & {
    process?: { readonly env?: PlannerEnvironment };
  };
  return runtime.process?.env ?? {};
}
