import { cleanup, render, screen } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel';

afterEach(cleanup);

const taskId = '43000000-0000-4000-8000-000000000001';

const savedPlan = {
  id: '53000000-0000-4000-8000-000000000001',
  version: 1,
  decision: 'proposed',
  plan: {
    id: '53000000-0000-4000-8000-000000000001',
    taskId,
    goal: 'Reconcile October and September gross profit.',
    summary: 'Review gross-profit amounts and reporting periods.',
    steps: [{
      id: 'step_1',
      title: 'Calculate October gross profit',
      description: 'Calculate gross profit using the October figures.',
      toolId: 'echo',
      toolVersion: '1.0.0',
      input: { review: 'October 2026' },
      dependencies: [],
      expectedOutcome: 'The calculated amount is ₹38,000.',
      verificationCriteria: 'Compare the calculation with the manager report.',
    }],
    dependencies: [],
    createdAt: '2026-11-24T08:30:00.000Z',
    version: 1,
    validationStatus: 'valid',
    limitations: [
      'FinNLP review status: insufficient_evidence.',
      'FinNLP deterministic arithmetic: Gross profit mismatch. Correct amount: ₹38,000; reported amount: ₹42,000 (₹4,000 overstated).',
      'FinNLP clarification: For September 2026, provide its own same-period net sales and cost of goods sold source figures. Do not reuse amounts from another period.',
      'FinNLP next step: Keep October 2026 and September 2026 separate and obtain September source figures.',
    ],
  },
};

const execution = {
  executionId: '63000000-0000-4000-8000-000000000001',
  toolId: 'financial-arithmetic',
  toolVersion: '1.0.0',
  status: 'succeeded',
  input: {
    calculation: 'gross-profit',
    currency: 'INR',
    reportingPeriod: 'October 2026',
    netSales: 96000,
    costOfGoodsSold: 58000,
    reportedGrossProfit: 42000,
  },
  output: {
    label: 'Gross profit',
    status: 'mismatch_detected',
    formula: 'net sales − cost of goods sold',
    calculatedAmount: 38000,
    reportedAmount: 42000,
    difference: 4000,
    differenceDirection: 'overstated',
    currency: 'INR',
    reportingPeriod: 'October 2026',
    sourceVerification: 'not_performed',
    requiresHumanReview: true,
  },
  error: null,
  createdAt: '2026-11-24T08:37:47.000Z',
  startedAt: '2026-11-24T08:37:47.000Z',
  completedAt: '2026-11-24T08:37:48.000Z',
};

function createClient() {
  const from = vi.fn((table: string) => {
    let query: Record<string, (...args: unknown[]) => unknown>;
    query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => {
        if (table === 'task_tool_executions') {
          return Promise.resolve({ data: [execution], error: null });
        }
        return query;
      }),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (table === 'workflow_plans') return { data: savedPlan, error: null };
        if (table === 'workflow_plan_runs') return { data: null, error: null };
        return { data: null, error: null };
      }),
    };
    return query;
  });
  return { from } as unknown as SupabaseClient;
}

describe('FindingsPanel', () => {
  it('shows the saved FinNLP handoff and persisted financial-arithmetic outcome', async () => {
    render(
      <FindingsPanel
        client={createClient()}
        workspaceId="33000000-0000-4000-8000-000000000001"
        tasks={[{ id: taskId, title: 'Reporting-period reconciliation' }]}
        selectedTaskId={taskId}
        onTaskChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'FinNLP result' })).toBeInTheDocument();
    expect(screen.getByText('Review status')).toBeInTheDocument();
    expect(screen.getByText('insufficient_evidence.')).toBeInTheDocument();
    expect(screen.getByText(/September 2026, provide its own same-period net sales and cost of goods sold/)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Actual outcomes' })).toBeInTheDocument();
    expect(screen.getByText('Gross profit: mismatch_detected')).toBeInTheDocument();
    expect(screen.getByText('₹38,000')).toBeInTheDocument();
    expect(screen.getByText('₹42,000')).toBeInTheDocument();
    expect(screen.getByText('₹4,000')).toBeInTheDocument();
  });
});
