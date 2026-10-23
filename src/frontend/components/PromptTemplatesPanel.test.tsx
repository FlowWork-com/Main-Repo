import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptTemplatesPanel } from './PromptTemplatesPanel';

const workspaceId = 'b2000000-0000-4000-8000-000000000001';
const templateId = 'b3000000-0000-4000-8000-000000000001';

const template = {
  id: templateId,
  name: 'Daily invoice review',
  prompt: 'Review invoices and flag missing fields.',
  current_version: 2,
  updated_at: '2026-10-23T10:00:00.000Z',
};

const versions = [
  {
    version: 2,
    name: 'Daily invoice review',
    prompt: 'Review invoices and flag missing fields.',
    change_kind: 'updated',
    created_at: '2026-10-23T10:00:00.000Z',
  },
  {
    version: 1,
    name: 'Daily invoice review',
    prompt: 'Review the invoices.',
    change_kind: 'created',
    created_at: '2026-10-22T10:00:00.000Z',
  },
];

function createClient(options: {
  readonly templates?: readonly Record<string, unknown>[];
  readonly versions?: readonly Record<string, unknown>[];
  readonly rpcError?: { code: string; message?: string } | null;
} = {}) {
  const from = vi.fn((tableName: string) => {
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
    query.order.mockImplementation(() => {
      if (tableName === 'workflow_prompt_templates') {
        return Promise.resolve({ data: options.templates ?? [], error: null });
      }
      return query;
    });
    query.limit.mockResolvedValue({ data: options.versions ?? [], error: null });
    return query;
  });
  const rpc = vi.fn().mockResolvedValue({
    data: { id: templateId, version: 3 },
    error: options.rpcError ?? null,
  });
  return {
    client: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
  };
}

describe('PromptTemplatesPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates a workspace prompt through the guarded RPC', async () => {
    const { client, rpc } = createClient();
    render(<PromptTemplatesPanel client={client} workspaceId={workspaceId} onUseTemplate={vi.fn()} />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Template name' }), {
      target: { value: 'Daily invoice review' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt text' }), {
      target: { value: 'Review invoices and flag missing fields.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('save_workflow_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: null,
      p_name: 'Daily invoice review',
      p_prompt: 'Review invoices and flag missing fields.',
      p_expected_version: null,
    }));
  });

  it('lets the user reuse a saved prompt in the request composer', async () => {
    const { client } = createClient({ templates: [template] });
    const onUseTemplate = vi.fn();
    render(<PromptTemplatesPanel client={client} workspaceId={workspaceId} onUseTemplate={onUseTemplate} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use template' }));
    expect(onUseTemplate).toHaveBeenCalledWith(template.prompt);
  });

  it('shows immutable version history and lets a user reuse a prior version', async () => {
    const { client } = createClient({ templates: [template], versions });
    const onUseTemplate = vi.fn();
    render(<PromptTemplatesPanel client={client} workspaceId={workspaceId} onUseTemplate={onUseTemplate} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Version history' }));
    expect(await screen.findByText(/Version 1 · created/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this version' })[1]);
    expect(onUseTemplate).toHaveBeenCalledWith('Review the invoices.');
  });

  it('uses an expected version when saving edits and surfaces stale edits safely', async () => {
    const { client, rpc } = createClient({ templates: [template], rpcError: { code: '40001' } });
    render(<PromptTemplatesPanel client={client} workspaceId={workspaceId} onUseTemplate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt text' }), {
      target: { value: 'Review invoices with tax checks.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('save_workflow_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: templateId,
      p_name: 'Daily invoice review',
      p_prompt: 'Review invoices with tax checks.',
      p_expected_version: 2,
    }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed in another session/);
  });

  it('archives a prompt without a direct client-side delete', async () => {
    const { client, rpc } = createClient({ templates: [template] });
    render(<PromptTemplatesPanel client={client} workspaceId={workspaceId} onUseTemplate={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('archive_workflow_prompt_template', {
      p_workspace_id: workspaceId,
      p_template_id: templateId,
      p_expected_version: 2,
    }));
  });
});
