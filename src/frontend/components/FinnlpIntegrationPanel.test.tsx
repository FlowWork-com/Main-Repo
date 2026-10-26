import { fireEvent, render, screen } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinnlpIntegrationPanel } from './FinnlpIntegrationPanel';

const workspaceId = 'a2000000-0000-4000-8000-000000000001';
const apiKey = 'finnhub-private-test-key-0123456789';

function createClient(responses: Array<{ data: unknown; error: unknown | null }>) {
  const invoke = vi.fn();
  for (const response of responses) invoke.mockResolvedValueOnce(response);
  return {
    client: { functions: { invoke } } as unknown as SupabaseClient,
    invoke,
  };
}

describe('FinnlpIntegrationPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('connects through the authenticated function, clears the key, and disconnects', async () => {
    const { client, invoke } = createClient([
      { data: { connected: false }, error: null },
      { data: { connected: true, connectedAt: '2026-10-26T10:00:00.000Z' }, error: null },
      { data: { connected: false }, error: null },
    ]);
    const { container } = render(
      <FinnlpIntegrationPanel client={client} workspaceId={workspaceId} canAccessWorkspace />,
    );

    const keyInput = await screen.findByLabelText('Finnhub API key');
    fireEvent.change(keyInput, { target: { value: apiKey } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect FinNLP' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/connected for read-only company-news retrieval/i);
    expect(invoke).toHaveBeenNthCalledWith(2, 'finnlp-integration', {
      body: { action: 'connect', workspaceId, apiKey },
    });
    expect(screen.queryByDisplayValue(apiKey)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(apiKey);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/credential was removed/i);
    expect(invoke).toHaveBeenNthCalledWith(3, 'finnlp-integration', {
      body: { action: 'disconnect', workspaceId },
    });
    expect(container).not.toHaveTextContent(apiKey);
  });

  it('does not offer credential changes without workspace access', async () => {
    const { client, invoke } = createClient([]);
    render(
      <FinnlpIntegrationPanel client={client} workspaceId={workspaceId} canAccessWorkspace={false} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Workspace access is required/);
    expect(screen.queryByLabelText('Finnhub API key')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
