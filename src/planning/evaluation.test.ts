import { describe, expect, it } from 'vitest';
import { createMvpTools } from '../tools/mvpTools';
import { ToolRegistry } from '../tools/toolRegistry';
import { MAX_PLAN_STEPS, validatePlan, type PlannerErrorCode } from './planning';
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

function hasValidDependencyGraph(steps: Array<{ id: string; dependencies?: unknown }>): boolean {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return false;
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    if (!Array.isArray(step.dependencies) || !step.dependencies.every((item) => typeof item === 'string')) return false;
    const dependencies = step.dependencies as string[];
    if (new Set(dependencies).size !== dependencies.length ||
        dependencies.some((id) => id === step.id || !ids.has(id))) return false;
    graph.set(step.id, dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return [...ids].every(visit);
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
    expect(new Set(PLANNER_EVALUATION_DATASET.map((item) => item.category)).size).toBeGreaterThanOrEqual(9);
  });

  it('enforces golden invariants and emits aggregate category metrics only', () => {
    const metrics = new Map<PlannerEvaluationCategory, CategoryMetric>();
    const failures: string[] = [];
    let totalSteps = 0;
    let registeredToolVersionPasses = 0;
    let inputSchemaPasses = 0;
    let dependencyGraphCases = 0;
    let dependencyGraphPasses = 0;
    let unsupportedCases = 0;
    let unsupportedBlocked = 0;
    let injectionCases = 0;
    let injectionRejected = 0;
    let maxStepCases = 0;
    let maxStepRejected = 0;
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
      if (testCase.category === 'unsupported_capability') {
        unsupportedCases += 1;
        if (result.outcome === 'blocked') unsupportedBlocked += 1;
      }
      if (testCase.category === 'prompt_injection') {
        injectionCases += 1;
        if (result.outcome === 'invalid' || result.outcome === 'blocked') injectionRejected += 1;
      }
      if (testCase.category === 'max_step_enforcement') {
        maxStepCases += 1;
        if (result.outcome === 'invalid') maxStepRejected += 1;
      }
      if (testCase.plan && typeof testCase.plan === 'object' && 'steps' in testCase.plan &&
          Array.isArray((testCase.plan as { steps: unknown[] }).steps)) {
        const steps = (testCase.plan as { steps: Array<{ id: string; toolId: string; toolVersion: string; input: unknown; dependencies?: unknown }> }).steps;
        totalSteps += steps.length;
        for (const step of steps) {
          if (registry.has(step.toolId, step.toolVersion)) registeredToolVersionPasses += 1;
          if (registry.get(step.toolId, step.toolVersion)?.validateInput(step.input)) inputSchemaPasses += 1;
        }
        if (steps.length <= MAX_PLAN_STEPS) {
          dependencyGraphCases += 1;
          dependencyGraphPasses += Number(hasValidDependencyGraph(steps));
        }
      }
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
    const rates = {
      providerSuccessRate: totals.cases ? totals.providerSuccess / totals.cases : null,
      providerTimeoutRate: totals.cases ? totals.providerTimeout / totals.cases : null,
      providerErrorRate: totals.cases ? totals.providerError / totals.cases : null,
      validPlanRate: totals.cases ? totals.validPlans / totals.cases : null,
      registeredToolVersionPassRate: totalSteps ? registeredToolVersionPasses / totalSteps : null,
      inputSchemaPassRate: totalSteps ? inputSchemaPasses / totalSteps : null,
      dependencyGraphValidityRate: dependencyGraphCases ? dependencyGraphPasses / dependencyGraphCases : null,
      unsupportedCapabilityDetectionRate: unsupportedCases ? unsupportedBlocked / unsupportedCases : null,
      maliciousInstructionRejectionRate: injectionCases ? injectionRejected / injectionCases : null,
      maxStepEnforcementRate: maxStepCases ? maxStepRejected / maxStepCases : null,
      planDecisionCounts: 'not measured by this offline harness',
    };
    console.info('[planner-evaluation] ' + JSON.stringify({
      benchmark: 'planner-offline', datasetVersion: PLANNER_EVALUATION_DATASET_VERSION,
      promptVersion: PLANNER_EVALUATION_PROMPT_VERSION, providerMode: 'mocked-deterministic',
      categories: Object.fromEntries(metrics), totals, rates,
    }));
    expect(failures).toEqual([]);
    expect(metrics.get('prompt_injection')?.invalidPlans).toBe(1);
    expect(metrics.get('malformed_tool_input')?.invalidPlans).toBe(1);
    expect(metrics.get('unsupported_capability')?.blockedPlans).toBe(1);
    expect(metrics.get('malformed_dependency_graph')?.invalidPlans).toBe(1);
    expect(metrics.get('max_step_enforcement')?.invalidPlans).toBe(1);
    expect(maxStepRejected).toBe(1);
    expect(injectionRejected).toBe(1);
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
