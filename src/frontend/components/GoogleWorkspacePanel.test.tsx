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

  it('imports selected Drive text into a user-selected Planning workflow', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ data: { connected: true, email: 'person@example.test' }, error: null })
      .mockResolvedValueOnce({
        data: {
          connected: true,
          files: [{
            id: 'drive-doc-2',
            name: 'Budget notes',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: null,
            webViewLink: null,
            canPreview: true,
          }],
          nextPageToken: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          connected: true,
          preview: {
            id: 'drive-doc-2',
            name: 'Budget notes',
            mimeType: 'application/vnd.google-apps.document',
            content: 'Total budget: 2400.00',
          },
        },
        error: null,
      });

    const taskChain = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
    };
    taskChain.select.mockReturnValue(taskChain);
    taskChain.eq.mockReturnValue(taskChain);
    taskChain.order.mockReturnValue(taskChain);
    taskChain.limit.mockResolvedValue({
      data: [{ id: 'planning-task-1', title: 'Review the budget', status: 'Planning' }],
      error: null,
    });
    const upload = vi.fn(async (storagePath: string, _file: File, _options: { contentType: string; upsert: boolean }) => ({
      data: { path: storagePath },
      error: null,
    }));
    const remove = vi.fn(async (_paths: string[]) => ({ data: [], error: null }));
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      data: 'registered-file-id',
      error: null,
    }));
    const client = {
      functions: { invoke },
      from: vi.fn(() => taskChain),
      storage: { from: vi.fn(() => ({ upload, remove })) },
      rpc,
    } as unknown as SupabaseClient;

    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);

    fireEvent.click(await screen.findByRole('button', { name: 'List Drive files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview text' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import to a Planning workflow' }));

    expect(await screen.findByRole('combobox', { name: 'Choose a Planning workflow' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import file' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Imported Budget notes\.txt into "Review the budget"/);
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(taskChain.eq).toHaveBeenCalledWith('workspace_id', workspaceId);
    expect(taskChain.eq).toHaveBeenCalledWith('status', 'Planning');
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp('^' + workspaceId + '/planning-task-1/[0-9a-f-]+/Budget notes\\.txt$')),
      expect.any(File),
      { contentType: 'text/plain', upsert: false },
    );
    const uploadedFile = upload.mock.calls[0][1] as File;
    expect(uploadedFile.name).toBe('Budget notes.txt');
    expect(await uploadedFile.text()).toBe('Total budget: 2400.00');
    expect(rpc).toHaveBeenCalledWith('register_task_file', expect.objectContaining({
      p_workspace_id: workspaceId,
      p_task_id: 'planning-task-1',
      p_file_name: 'Budget notes.txt',
      p_content_type: 'text/plain',
    }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes an uploaded Drive copy if secure attachment registration fails', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ data: { connected: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          connected: true,
          files: [{
            id: 'drive-sheet-1',
            name: 'Vendors',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: null,
            webViewLink: null,
            canPreview: true,
          }],
          nextPageToken: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          connected: true,
          preview: {
            id: 'drive-sheet-1',
            name: 'Vendors',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            content: 'Vendor,Total\\nAcme,100.00',
          },
        },
        error: null,
      });
    const taskChain = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
    };
    taskChain.select.mockReturnValue(taskChain);
    taskChain.eq.mockReturnValue(taskChain);
    taskChain.order.mockReturnValue(taskChain);
    taskChain.limit.mockResolvedValue({
      data: [{ id: 'planning-task-2', title: 'Review vendors', status: 'Planning' }],
      error: null,
    });
    const upload = vi.fn(async (storagePath: string, _file: File, _options: { contentType: string; upsert: boolean }) => ({
      data: { path: storagePath },
      error: null,
    }));
    const remove = vi.fn(async (_paths: string[]) => ({ data: [], error: null }));
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      data: null,
      error: { message: 'private detail' },
    }));
    const client = {
      functions: { invoke },
      from: vi.fn(() => taskChain),
      storage: { from: vi.fn(() => ({ upload, remove })) },
      rpc,
    } as unknown as SupabaseClient;

    render(<GoogleWorkspacePanel client={client} workspaceId={workspaceId} canAccessWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'List Drive files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview text' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import to a Planning workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import file' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cleanup was attempted/);
    expect(screen.getByRole('alert')).not.toHaveTextContent('private detail');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([expect.stringContaining(workspaceId + '/planning-task-2/')]);
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
