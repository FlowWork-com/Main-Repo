import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptTemplatesPanel } from './PromptTemplatesPanel';

const workspaceId = 'b2000000-0000-4000-8000-000000000001';
const templateId = 'b3000000-0000-4000-8000-000000000001';

const templateRows = [{
  id: templateId,
  name: 'Weekly KPI Summary',
  category: 'Finance',
  current_version: 2,
  updated_at: '2026-10-23T10:00:00.000Z',
  archived_at: null,
}];

const versionRows = [
  {
    template_id: templateId,
    version: 2,
    prompt_text: 'Summarize revenue and costs. Highlight variances and open questions.',
  },
  {
    template_id: templateId,
    version: 1,
    prompt_text: 'Summarize weekly revenue and costs.',
  },
];

function createClient(options: {
  readonly templates?: Record<string, unknown>[];
  readonly versions?: Record<string, unknown>[];
  readonly rpcError?: { readonly code?: string; readonly message?: string } | null;
} = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    workspace_prompt_templates: options.templates ?? templateRows,
    workspace_prompt_template_versions: options.versions ?? versionRows,
  };
  const queries: Record<string, {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = {};
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.is.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockResolvedValue({ data: tables[table] ?? [], error: null });
    queries[table] = query;
    return query;
  });
  const rpc = vi.fn().mockResolvedValue({
    data: { id: templateId, version: 3 },
    error: options.rpcError ?? null,
  });
  const client = { from, rpc } as unknown as SupabaseClient;
  return { client, from, rpc, queries };
}

describe('PromptTemplatesPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('loads the current immutable version and copies it into the request composer', async () => {
    const { client, queries } = createClient();
    const onUseTemplate = vi.fn();
    render(
      <PromptTemplatesPanel
        client={client}
        workspaceId={workspaceId}
        canAccessWorkspace
        onUseTemplate={onUseTemplate}
      />,
    );

    expect(await screen.findByText('Weekly KPI Summary')).toBeInTheDocument();
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
    expect(screen.getByText(/Highlight variances and open questions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(onUseTemplate).toHaveBeenCalledWith(versionRows[0].prompt_text);
    expect(await screen.findByRole('status')).toHaveTextContent(/Loaded/);
    expect(queries['workspace_prompt_template_versions'].order).toHaveBeenCalledWith(
      'version',
      { ascending: false },
    );
  });

  it('creates a versioned workspace template through the guarded RPC', async () => {
    const { client, rpc } = createClient({ templates: [], versions: [] });
    render(
      <PromptTemplatesPanel
        client={client}
        workspaceId={workspaceId}
        canAccessWorkspace
        onUseTemplate={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), {
      target: { value: 'Meeting notes' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Category Optional' }), {
      target: { value: 'Operations' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt text' }), {
      target: { value: 'Summarize the decisions, owners, and follow-up items from these meeting notes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Prompt template saved/);
    expect(rpc).toHaveBeenCalledWith('save_workspace_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: null,
      p_expected_version: null,
      p_name: 'Meeting notes',
      p_category: 'Operations',
      p_prompt_text: 'Summarize the decisions, owners, and follow-up items from these meeting notes.',
    });
  });

  it('saves edits as a new version and uses the optimistic version number', async () => {
    const { client, rpc } = createClient();
    render(
      <PromptTemplatesPanel
        client={client}
        workspaceId={workspaceId}
        canAccessWorkspace
        onUseTemplate={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt text' }), {
      target: { value: 'Summarize revenue. Flag variances, owners, and open questions for follow-up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('save_workspace_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: templateId,
      p_expected_version: 2,
      p_name: 'Weekly KPI Summary',
      p_category: 'Finance',
      p_prompt_text: 'Summarize revenue. Flag variances, owners, and open questions for follow-up.',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(/new prompt template version was saved/);
  });

  it('archives a template through the guarded soft-archive RPC', async () => {
    const { client, rpc } = createClient();
    render(
      <PromptTemplatesPanel
        client={client}
        workspaceId={workspaceId}
        canAccessWorkspace
        onUseTemplate={vi.fn()}
      />,
    );

    expect(await screen.findByText('Weekly KPI Summary')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('archive_workspace_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: templateId,
      p_expected_version: 2,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Prompt template archived/);
  });
});
