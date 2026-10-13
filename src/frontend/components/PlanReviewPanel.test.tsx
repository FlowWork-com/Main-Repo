import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PlanReviewPanel } from './PlanReviewPanel';

afterEach(cleanup);

const taskId = '43000000-0000-4000-8000-000000000001';

function savedPlan(decision: 'proposed' | 'accepted' | 'rejected' = 'proposed') {
  return {
    id: '53000000-0000-4000-8000-000000000001',
    version: 1,
    decision,
    plan: {
      id: '53000000-0000-4000-8000-000000000001',
      taskId,
      goal: 'Uppercase hello.',
      summary: 'Convert the supplied text to uppercase.',
      steps: [{
        id: 'step_1',
        title: 'Transform text',
        description: 'Apply the text transform tool.',
        toolId: 'text-transform',
        toolVersion: '1.0.0',
        input: { operation: 'uppercase', text: 'hello' },
        dependencies: [],
        expectedOutcome: 'Uppercase output.',
        verificationCriteria: 'The result is uppercase.',
      }],
      dependencies: [],
      createdAt: '2026-10-13T10:00:00.000Z',
      version: 1,
      validationStatus: 'valid',
      limitations: [],
    },
  };
}

function createClient() {
  let record: ReturnType<typeof savedPlan> | null = savedPlan();
  const from = vi.fn(() => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: record, error: null })),
    };
    return query;
  });
  const invoke = vi.fn(async () => ({ data: null, error: null }));
  const rpc = vi.fn(async (_name: string, args: { p_decision: 'accepted' | 'rejected' }) => {
    if (record) record = { ...record, decision: args.p_decision };
    return { data: null, error: null };
  });
  return {
    client: { from, functions: { invoke }, rpc } as unknown as SupabaseClient,
    invoke,
    rpc,
  };
}

describe('PlanReviewPanel', () => {
  it('loads and retains the saved decision after the panel is remounted without executing tools', async () => {
    const { client, invoke, rpc } = createClient();
    const view = render(
      <PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />,
    );

    expect(await screen.findByText('Convert the supplied text to uppercase.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept plan' }));
    expect(await screen.findByText('Plan v1: accepted')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('decide_workflow_plan', {
      p_plan_id: '53000000-0000-4000-8000-000000000001',
      p_decision: 'accepted',
    });
    expect(invoke).not.toHaveBeenCalled();

    view.unmount();
    render(<PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />);
    expect(await screen.findByText('Plan v1: accepted')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('persists and reloads a rejected decision', async () => {
    const { client, rpc } = createClient();
    const view = render(
      <PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reject plan' }));
    expect(await screen.findByText('Plan v1: rejected')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('decide_workflow_plan', {
      p_plan_id: '53000000-0000-4000-8000-000000000001',
      p_decision: 'rejected',
    });
    view.unmount();
    render(<PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />);
    expect(await screen.findByText('Plan v1: rejected')).toBeInTheDocument();
  });

  it('sends only the task ID and goal and shows an honest configuration error', async () => {
    const { client, invoke } = createClient();
    invoke.mockResolvedValue({
      data: null,
      error: {
        context: new Response(JSON.stringify({ error: { code: 'PLANNER_NOT_CONFIGURED' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      },
    } as never);
    render(<PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />);
    fireEvent.change(await screen.findByLabelText('Goal'), { target: { value: 'Uppercase hello.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request plan' }));

    expect(await screen.findByText('Plan generation is not configured for this workspace.')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('plan-workflow', {
      body: { taskId, goal: 'Uppercase hello.' },
    });
  });

  it('rejects an invalid function response without rendering model data as trusted', async () => {
    const { client, invoke } = createClient();
    invoke.mockResolvedValue({ data: { plan: { summary: '<script>unsafe</script>' } }, error: null } as never);
    render(<PlanReviewPanel client={client} canAccessWorkspace taskId={taskId} taskStatus="Planning" taskTitle="Task" />);
    fireEvent.change(await screen.findByLabelText('Goal'), { target: { value: 'Uppercase hello.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request plan' }));

    expect(await screen.findByText('The planning service returned a plan that could not be validated.')).toBeInTheDocument();
    expect(screen.queryByText('<script>unsafe</script>')).not.toBeInTheDocument();
  });
});