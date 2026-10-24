import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleWorkspacePanel } from './GoogleWorkspacePanel';

const workspaceId = 'c2000000-0000-4000-8000-000000000001';

function createClient(responses: Array<{ data: unknown; error: unknown | null }> = []) {
  const invoke = vi.fn();
  for (const response of responses) invoke.mockResolvedValueOnce(response);
  const client = { functions: { invoke } } as unknown as SupabaseClient;
  return { client, invoke };
}

describe('GoogleWorkspacePanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('loads connection status and lists only safe Drive metadata', async () => {
    const { client, invoke } = createClient([
      { data: { connected: true, email: 'person@example.test', connectedAt: '2026-10-23T10:00:00.000Z', scopes: ['drive.file'] }, error: null },
      {
        data: {
          connected: true,
          files: [
            {
              id: 'drive-file-1',
              name: 'Invoice.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-10-22T10:00:00.000Z',
              webViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
            },
            {
              id: 'drive-file-2',
              name: 'Other file',
              mimeType: 'text/plain',
              modifiedTime: null,
              webViewLink: 'https://attacker.example/not-safe',
            },
          ],
          nextPageToken: 'next-token',
        },
        error: null,
      },
    ]);
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    expect(await screen.findByText(/Connected as/)).toHaveTextContent('person@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'List Drive files' }));

    expect(await screen.findByText('Invoice.pdf')).toHaveAttribute('href', 'https://drive.google.com/file/d/drive-file-1/view');
    expect(screen.getByText('Other file').tagName).toBe('STRONG');
    expect(screen.getByText('application/pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more files' })).toBeInTheDocument();
    expect(invoke).toHaveBeenNthCalledWith(1, 'google-workspace', {
      body: { action: 'status', workspaceId },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'google-workspace', {
      body: { action: 'list_files', workspaceId, pageSize: 20 },
    });
  });

  it('previews supported Drive text only after an explicit user click', async () => {
    const { client, invoke } = createClient([
      { data: { connected: true, email: 'person@example.test' }, error: null },
      {
        data: {
          connected: true,
          files: [{
            id: 'drive-doc-1',
            name: 'Invoice notes',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: null,
            webViewLink: null,
            canPreview: true,
          }],
          nextPageToken: null,
        },
        error: null,
      },
      {
        data: {
          connected: true,
          preview: {
            id: 'drive-doc-1',
            name: 'Invoice notes',
            mimeType: 'application/vnd.google-apps.document',
            content: 'Invoice total: 125.00',
          },
        },
        error: null,
      },
    ]);
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    fireEvent.click(await screen.findByRole('button', { name: 'List Drive files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview text' }));

    const preview = await screen.findByRole('region', { name: 'Drive text preview' });
    expect(preview).toHaveTextContent('Invoice notes');
    expect(preview).toHaveTextContent('Invoice total: 125.00');
    expect(invoke).toHaveBeenNthCalledWith(3, 'google-workspace', {
      body: { action: 'preview_file', workspaceId, fileId: 'drive-doc-1' },
    });
  });

  it('shows a connect action when no account is linked and access is available', async () => {
    const { client, invoke } = createClient([{ data: { connected: false }, error: null }]);
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    expect(await screen.findByRole('button', { name: 'Connect Google account' })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('google-workspace', { body: { action: 'status', workspaceId } });
  });

  it('does not offer a connection action without workspace access', async () => {
    const { client, invoke } = createClient();
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace={false} />);

    expect(await screen.findByText(/Workspace access is required to connect/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Google account' })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sanitizes function errors when connection status is unavailable', async () => {
    const { client } = createClient([{ data: null, error: { message: 'private internal details' } }]);
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Unable to check Google Workspace connection status/);
    expect(screen.getByRole('alert')).not.toHaveTextContent('private internal details');
  });

  it('removes a Google callback status from the URL after displaying a message', async () => {
    window.history.replaceState({}, '', '/?google_connection=connected&tab=workspace#top');
    const { client } = createClient([{ data: { connected: true, email: 'person@example.test' }, error: null }]);
    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    expect(await screen.findByRole('status')).toHaveTextContent(/Google Workspace is connected/);
    await waitFor(() => expect(window.location.search).toBe('?tab=workspace'));
    expect(window.location.hash).toBe('#top');
  });
});
