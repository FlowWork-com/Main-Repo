import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteToolResponse } from '../../backend/toolExecutionClient';
import type { PersistedTask } from '../../backend/workflowRepository';
import type { JsonValue } from '../../tools/contracts';
import {
  applyWorkflowCommand,
  createWorkflow,
  type WorkflowStatus,
} from '../../workflow/workflow';
import { TaskToolExecutionPanel } from './TaskToolExecutionPanel';

vi.mock('../../backend/toolExecutionClient', () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from '../../backend/toolExecutionClient';

const taskId = '43000000-0000-4000-8000-000000000001';
const workspaceId = '42000000-0000-4000-8000-000000000001';
const ownerId = '41000000-0000-4000-8000-000000000001';

interface HistoryQuery {
  readonly select: ReturnType<typeof vi.fn>;
  readonly eq: ReturnType<typeof vi.fn>;
  readonly order: ReturnType<typeof vi.fn>;
}

function createClient(rows: readonly Record<string, unknown>[] = []) {
  const query: HistoryQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockResolvedValue({ data: rows, error: null });
  const client = { from: vi.fn(() => query) } as unknown as SupabaseClient;
  return { client, query };
}

function taskWithStatus(status: WorkflowStatus): PersistedTask {
  const createdAt = '2026-10-11T10:00:00.000Z';
  let workflow = createWorkflow({
    task: { id: taskId, tenantId: workspaceId, ownerId },
    actorId: ownerId,
    actorTenantId: workspaceId,
    idempotencyKey: 'create-task',
    occurredAt: createdAt,
  });
  if (status === 'Running' || status === 'Verifying') {
    workflow = applyWorkflowCommand(workflow, {
      taskId,
      tenantId: workspaceId,
      ownerId,
      actorId: ownerId,
      actorTenantId: workspaceId,
      idempotencyKey: 'start-task',
      expectedSequence: workflow.events.length,
      occurredAt: '2026-10-11T10:01:00.000Z',
      type: 'start',
    });
  }
  if (status === 'Verifying') {
    workflow = applyWorkflowCommand(workflow, {
      taskId,
      tenantId: workspaceId,
      ownerId,
      actorId: ownerId,
      actorTenantId: workspaceId,
      idempotencyKey: 'begin-verification',
      expectedSequence: workflow.events.length,
      occurredAt: '2026-10-11T10:02:00.000Z',
      type: 'begin-verification',
    });
  }
  return {
    id: taskId,
    workspaceId,
    ownerId,
    title: 'Example task',
    details: '',
    workflow,
    createdAt,
    updatedAt: createdAt,
  };
}

function PanelHarness({
  client,
  initialStatus = 'Running',
  onRefresh = vi.fn(async () => taskWithStatus('Running')),
}: {
  readonly client: SupabaseClient;
  readonly initialStatus?: WorkflowStatus;
  readonly onRefresh?: () => Promise<PersistedTask>;
}) {
  const [task, setTask] = useState(() => taskWithStatus(initialStatus));
  return (
    <TaskToolExecutionPanel
      canAccessWorkspace
      client={client}
      onTaskRefresh={async () => {
        const refreshed = await onRefresh();
        setTask(refreshed);
        return refreshed;
      }}
      task={task}
    />
  );
}

function successfulResponse(output: JsonValue = { value: 'done' }): ExecuteToolResponse {
  return {
    result: { success: true, output },
    workflowStatus: 'Verifying',
  };
}

function inProgressResponse(): ExecuteToolResponse {
  return {
    result: {
      success: false,
      error: {
        code: 'EXECUTION_IN_PROGRESS',
        message: 'This execution request is already being processed.',
        retryable: true,
      },
    },
    workflowStatus: 'Running',
  };
}

describe('TaskToolExecutionPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows eligible tools, validates JSON locally, and changes examples when selected', async () => {
    const { client } = createClient();
    render(<PanelHarness client={client} />);

    expect(await screen.findByRole('combobox', { name: 'Tool' })).toBeInTheDocument();
    expect(screen.getByText('Return a JSON value without changing it. Version 1.0.0.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), {
      target: { value: 'text-transform' },
    });
    expect(screen.getByText(/"operation":"uppercase"/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Input (JSON)' })).toHaveValue(
      '{\n  "operation": "uppercase",\n  "text": "hello, FlowWork"\n}',
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Input (JSON)' }), {
      target: { value: '{broken' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Text transform' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter valid JSON');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('executes through the adapter, refreshes persisted task state, and shows the result', async () => {
    const { client } = createClient();
    const onRefresh = vi.fn(async () => taskWithStatus('Verifying'));
    vi.mocked(executeTool).mockResolvedValueOnce(successfulResponse({ value: { greeting: 'hi' } }));
    render(<PanelHarness client={client} onRefresh={onRefresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Echo' }));

    expect(await screen.findByRole('heading', { name: 'Latest result' })).toBeInTheDocument();
    expect(screen.getByText(/"greeting": "hi"/)).toBeInTheDocument();
    expect(await screen.findByText('Workflow: Verifying')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
    const [, request] = vi.mocked(executeTool).mock.calls[0];
    expect(Object.keys(request).sort()).toEqual([
      'executionId', 'input', 'requestId', 'taskId', 'toolId', 'toolVersion',
    ]);
    expect(request).toMatchObject({ taskId, toolId: 'echo', toolVersion: '1.0.0' });
    expect(screen.queryByRole('button', { name: 'Run Echo' })).not.toBeInTheDocument();
  });

  it('disables repeat submission while one request is pending', async () => {
    const { client } = createClient();
    let finish!: (response: ExecuteToolResponse) => void;
    vi.mocked(executeTool).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    render(<PanelHarness client={client} />);
    const runButton = await screen.findByRole('button', { name: 'Run Echo' });
    fireEvent.click(runButton);
    fireEvent.click(runButton);

    expect(vi.mocked(executeTool)).toHaveBeenCalledOnce();
    expect(runButton).toBeDisabled();
    finish(successfulResponse());
    await screen.findByRole('heading', { name: 'Latest result' });
  });

  it('retries an ambiguous request with the exact same execution and request IDs', async () => {
    const { client } = createClient();
    vi.mocked(executeTool)
      .mockRejectedValueOnce(new Error('database secret details'))
      .mockResolvedValueOnce(inProgressResponse());
    render(<PanelHarness client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Echo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to confirm tool execution');
    expect(screen.getByRole('alert')).not.toHaveTextContent('database secret details');
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('still in progress'),
    );

    const calls = vi.mocked(executeTool).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(screen.getByRole('button', { name: 'Retry same request' })).toBeInTheDocument();
  });

  it('loads scoped persisted history through the authenticated client and hides execution controls when ineligible', async () => {
    const { client, query } = createClient([{
      execution_id: '44000000-0000-4000-8000-000000000001',
      tool_id: 'echo',
      tool_version: '1.0.0',
      status: 'succeeded',
      output: { value: 'saved' },
      error: null,
      created_at: '2026-10-11T10:03:00.000Z',
      started_at: '2026-10-11T10:03:00.000Z',
      completed_at: '2026-10-11T10:03:01.000Z',
    }]);
    render(<PanelHarness client={client} initialStatus="Verifying" />);

    expect(await screen.findByText('Echo')).toBeInTheDocument();
    expect(screen.getByText('Echo').parentElement).toHaveTextContent(/v\s*1\.0\.0/);
    expect(screen.getByText(/"value": "saved"/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Tool' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run Echo' })).not.toBeInTheDocument();
    expect(client.from).toHaveBeenCalledWith('task_tool_executions');
    expect(query.select).toHaveBeenCalledWith(
      'execution_id, tool_id, tool_version, status, output, error, created_at, started_at, completed_at',
    );
    expect(query.eq).toHaveBeenNthCalledWith(1, 'workspace_id', workspaceId);
    expect(query.eq).toHaveBeenNthCalledWith(2, 'task_id', taskId);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('shows a safe message for an invalid Edge Function response', async () => {
    const { client } = createClient();
    vi.mocked(executeTool).mockRejectedValueOnce(
      new Error('The tool execution service returned an invalid response.'),
    );
    render(<PanelHarness client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Echo' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('response could not be verified'),
    );
    expect(screen.getByRole('button', { name: 'Retry same request' })).toBeInTheDocument();
  });

  it('displays tool failures using safe messages instead of raw server text', async () => {
    const { client } = createClient();
    vi.mocked(executeTool).mockResolvedValueOnce({
      result: {
        success: false,
        error: {
          code: 'INVALID_TOOL_INPUT',
          message: 'Internal parser details with secret data',
          retryable: false,
        },
      },
      workflowStatus: 'Failed',
    });
    render(<PanelHarness client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Echo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The input does not match this tool’s requirements.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Internal parser details');
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret data');
  });
});