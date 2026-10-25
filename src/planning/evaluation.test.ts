import { describe, expect, it } from 'vitest';
import { createMvpTools } from '../tools/mvpTools';
import { ToolRegistry } from '../tools/toolRegistry';
import { validatePlan, type PlannerErrorCode } from './planning';
import {
  PLANNER_EVALUATION_DATASET,
  PLANNER_EVALUATION_DATASET_VERSION,
  PLANNER_EVALUATION_PROMPT_VERSION,
  type PlannerEvaluationCategory,
} from './evaluationDataset';

const registry = new ToolRegistry();
for (const tool of createMvpTools({
  async getTaskFileMetadata() { return null; },
})) registry.register(tool);

interface CategoryMetric {
  cases: number; providerSuccess: number; providerTimeout: number; providerError: number;
  validPlans: number; blockedPlans: number; invalidPlans: number;
}

function evaluateCase(testCase: (typeof PLANNER_EVALUATION_DATASET)[number]) {
  if (testCase.mockProvider === 'timeout') return { outcome: 'blocked' as const, errorCode: 'PROVIDER_TIMEOUT' };
  if (testCase.mockProvider === 'error') return { outcome: 'blocked' as const, errorCode: 'PROVIDER_UNAVAILABLE' };
  if (!testCase.plan) return { outcome: 'blocked' as const, errorCode: undefined };
  try {
    const validated = validatePlan(testCase.plan, registry, {
      taskId: '43000000-0000-4000-8000-000000000001', goal: testCase.goal,
    });
    return { outcome: validated.validationStatus === 'valid' ? 'valid' as const : 'blocked' as const, errorCode: undefined };
  } catch (error) {
    return {
      outcome: 'invalid' as const,
      errorCode: typeof error === 'object' && error && 'code' in error
        ? String((error as { code: PlannerErrorCode }).code) : 'UNCLASSIFIED',
    };
  }
}

describe('offline planner evaluation benchmark', () => {
  it('uses a versioned deterministic dataset with unique case IDs', () => {
    expect(PLANNER_EVALUATION_DATASET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PLANNER_EVALUATION_PROMPT_VERSION).toBeTruthy();
    expect(new Set(PLANNER_EVALUATION_DATASET.map((item) => item.id)).size).toBe(PLANNER_EVALUATION_DATASET.length);
    expect(new Set(PLANNER_EVALUATION_DATASET.map((item) => item.category)).size).toBeGreaterThanOrEqual(7);
  });

  it('enforces golden invariants and emits aggregate category metrics only', () => {
    const metrics = new Map<PlannerEvaluationCategory, CategoryMetric>();
    const failures: string[] = [];
    for (const testCase of PLANNER_EVALUATION_DATASET) {
      const metric = metrics.get(testCase.category) ?? {
        cases: 0, providerSuccess: 0, providerTimeout: 0, providerError: 0,
        validPlans: 0, blockedPlans: 0, invalidPlans: 0,
      };
      metric.cases += 1;
      if (testCase.mockProvider === 'success') metric.providerSuccess += 1;
      if (testCase.mockProvider === 'timeout') metric.providerTimeout += 1;
      if (testCase.mockProvider === 'error') metric.providerError += 1;
      const result = evaluateCase(testCase);
      if (result.outcome === 'valid') metric.validPlans += 1;
      if (result.outcome === 'blocked') metric.blockedPlans += 1;
      if (result.outcome === 'invalid') metric.invalidPlans += 1;
      if (result.outcome !== testCase.expected) failures.push(testCase.id);
      metrics.set(testCase.category, metric);
    }
    const totals = [...metrics.values()].reduce((total, metric) => ({
      cases: total.cases + metric.cases,
      providerSuccess: total.providerSuccess + metric.providerSuccess,
      providerTimeout: total.providerTimeout + metric.providerTimeout,
      providerError: total.providerError + metric.providerError,
      validPlans: total.validPlans + metric.validPlans,
      blockedPlans: total.blockedPlans + metric.blockedPlans,
      invalidPlans: total.invalidPlans + metric.invalidPlans,
    }), { cases: 0, providerSuccess: 0, providerTimeout: 0, providerError: 0, validPlans: 0, blockedPlans: 0, invalidPlans: 0 });
    console.info('[planner-evaluation] ' + JSON.stringify({
      benchmark: 'planner-offline', datasetVersion: PLANNER_EVALUATION_DATASET_VERSION,
      promptVersion: PLANNER_EVALUATION_PROMPT_VERSION, providerMode: 'mocked-deterministic',
      categories: Object.fromEntries(metrics), totals,
    }));
    expect(failures).toEqual([]);
    expect(metrics.get('prompt_injection')?.invalidPlans).toBe(1);
    expect(metrics.get('malformed_tool_input')?.invalidPlans).toBe(1);
    expect(metrics.get('unsupported_capability')?.blockedPlans).toBe(1);
  });

  it('ignores model-supplied validation flags and canonically checks tool ID/version/input/graph', () => {
    const malicious = PLANNER_EVALUATION_DATASET.find((item) => item.id === 'prompt-injection-v1');
    expect(() => validatePlan(malicious?.plan, registry, {
      taskId: '43000000-0000-4000-8000-000000000001', goal: malicious?.goal,
    })).toThrow(/unknown tool/i);
    const invalidInput = PLANNER_EVALUATION_DATASET.find((item) => item.id === 'malformed-tool-input-v1');
    expect(() => validatePlan(invalidInput?.plan, registry, {
      taskId: '43000000-0000-4000-8000-000000000001', goal: invalidInput?.goal,
    })).toThrow(/input.*invalid/i);
  });
});
