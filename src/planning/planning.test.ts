import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/toolRegistry';
import { createMvpTools } from '../tools/mvpTools';
import {
  createPlannerError,
  planFromModelResponse,
  validatePlan,
} from './planning';

describe('planning contracts', () => {
  const registry = new ToolRegistry();
  for (const tool of createMvpTools({
    async getTaskFileMetadata() {
      return null;
    },
  })) {
    registry.register(tool);
  }

  it('accepts a valid structured plan', () => {
    const plan = {
      id: 'plan_123',
      taskId: 'task_123',
      goal: 'Rewrite hello as uppercase text.',
      summary: 'Convert input text to uppercase.',
      steps: [
        {
          id: 'step_1',
          title: 'Transform text',
          description: 'Apply the text transform tool.',
          toolId: 'text-transform',
          toolVersion: '1.0.0',
          input: { operation: 'uppercase', text: 'hello world' },
          dependencies: [],
          expectedOutcome: 'The output is uppercase text.',
          verificationCriteria: 'Result text should match uppercase text.',
          validation: { valid: true, blockingReasons: [] },
        },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'valid',
      limitations: [],
    };

    expect(() => validatePlan(plan, registry)).not.toThrow();
  });

  it('rejects malformed provider payloads', () => {
    expect(() =>
      planFromModelResponse({
        id: 'plan_1',
        taskId: 'task_1',
        steps: [
          {
            id: 'step_1',
            title: 'Fake step',
            toolId: 'not-a-tool',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects unknown tool ids and versions', () => {
    const plan = {
      id: 'plan_1',
      taskId: 'task_1',
      goal: 'Do something unexpected.',
      summary: 'Unexpected',
      steps: [
        {
          id: 'step_1',
          title: 'Unexpected tool',
          description: 'Uses a missing tool.',
          toolId: 'missing-tool',
          toolVersion: '9.9.9',
          input: { value: 'hello' },
          dependencies: [],
          expectedOutcome: 'Fails validation.',
          verificationCriteria: 'Should not allow',
          validation: { valid: false, blockingReasons: ['tool invalid'] },
        },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'invalid',
      limitations: ['Tool not available'],
    };

    expect(() => validatePlan(plan, registry)).toThrow(/unknown tool/i);
  });

  it('rejects duplicate IDs and cyclic dependencies', () => {
    const plan = {
      id: 'plan_1',
      taskId: 'task_1',
      goal: 'Trace dependency cycle.',
      summary: 'Cycle',
      steps: [
        {
          id: 'step_1',
          title: 'First',
          description: 'First dependency',
          toolId: 'echo',
          toolVersion: '1.0.0',
          input: { value: 'a' },
          dependencies: ['step_2'],
          expectedOutcome: 'a',
          verificationCriteria: 'It exists',
          validation: { valid: true, blockingReasons: [] },
        },
        {
          id: 'step_2',
          title: 'Second',
          description: 'Second dependency',
          toolId: 'echo',
          toolVersion: '1.0.0',
          input: { value: 'b' },
          dependencies: ['step_1'],
          expectedOutcome: 'b',
          verificationCriteria: 'It exists',
          validation: { valid: true, blockingReasons: [] },
        },
        {
          id: 'step_1',
          title: 'Duplicate',
          description: 'Duplicate id',
          toolId: 'echo',
          toolVersion: '1.0.0',
          input: { value: 'c' },
          dependencies: [],
          expectedOutcome: 'c',
          verificationCriteria: 'It exists',
          validation: { valid: true, blockingReasons: [] },
        },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'invalid',
      limitations: [],
    };

    expect(() => validatePlan(plan as never, registry)).toThrow();
  });

  it('detects credential-like values and disallows unsupported capabilities', () => {
    const plan = {
      id: 'plan_1',
      taskId: 'task_1',
      goal: 'Use browser automation to fill in a form.',
      summary: 'Requires unsupported browser automation.',
      steps: [
        {
          id: 'step_1',
          title: 'Browser automation',
          description: 'This should be blocked as unsupported.',
          toolId: 'echo',
          toolVersion: '1.0.0',
          input: { token: 'ghp_1234567890abcdef1234567890abcdef1234' },
          dependencies: [],
          expectedOutcome: 'Not allowed',
          verificationCriteria: 'No unsupported automation',
          validation: { valid: true, blockingReasons: [] },
        },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'invalid',
      limitations: ['Browser automation is unavailable.'],
    };

    expect(() => validatePlan(plan, registry)).toThrow(/credential|unsupported|tool/i);
  });

  it('preserves explicit clarification and missing-input blockers without executable steps', () => {
    const blocked = {
      id: 'plan_blocked',
      taskId: 'task_123',
      goal: 'Make this better.',
      summary: 'Needs clarification.',
      steps: [],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'invalid',
      limitations: ['Clarification is required before proposing an executable plan.'],
    };
    expect(validatePlan(blocked, registry).validationStatus).toBe('invalid');
    expect(validatePlan(blocked, registry).steps).toEqual([]);
  });

  it('does not block harmless mentions of email or automation words', () => {
    const harmless = {
      id: 'plan_text',
      taskId: 'task_123',
      goal: 'Lowercase the word email.',
      summary: 'Transform a string.',
      steps: [{
        id: 'step_1', title: 'Lowercase text', description: 'Use text transform.',
        toolId: 'text-transform', toolVersion: '1.0.0',
        input: { operation: 'lowercase', text: 'EMAIL' }, dependencies: [],
        expectedOutcome: 'email', verificationCriteria: 'Output is lowercase.',
        validation: { valid: false, blockingReasons: ['Model supplied flags are untrusted.'] },
      }],
      dependencies: [],
      createdAt: new Date().toISOString(),
      version: 1,
      validationStatus: 'invalid',
      limitations: [],
    };
    expect(validatePlan(harmless, registry).validationStatus).toBe('valid');
    expect(validatePlan(harmless, registry).steps[0]?.validation.valid).toBe(true);
  });

  it('returns a sanitized planner error when no provider is configured', () => {
    const error = createPlannerError('PLANNER_NOT_CONFIGURED', 'No provider configured');
    expect(error.code).toBe('PLANNER_NOT_CONFIGURED');
    expect(error.message).toContain('not configured');
    expect(error.details).toBeUndefined();
  });
});
