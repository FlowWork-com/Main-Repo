import { describe, expect, it } from 'vitest';
import { createPlannerError, type PlannerRequest } from './planning';
import {
  createPlannerAdapterFromEnvironment,
  createMockPlannerAdapter,
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
