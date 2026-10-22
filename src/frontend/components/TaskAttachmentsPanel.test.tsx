import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersistedTask } from '../../backend/workflowRepository';
import { TaskAttachmentsPanel } from './TaskAttachmentsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const userId = '81000000-0000-4000-8000-000000000001';
const workspaceId = '82000000-0000-4000-8000-000000000001';
const taskId = '83000000-0000-4000-8000-000000000001';

function makeTask(status: 'Planning' | 'Running' = 'Planning'): PersistedTask {
  return {
    id: taskId,
    workspaceId,
    ownerId: userId,
    title: 'Review an invoice',
    details: 'Read the attached invoice.',
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    workflow: {
      task: { id: taskId, tenantId: workspaceId, ownerId: userId, status, attempt: 1 },
      events: [],
    },
  } as unknown as PersistedTask;
}

function createClient(initialFiles: Record<string, unknown>[] = []) {
  let files = [...initialFiles];
  const from = vi.fn(() => {
    const query: Record<string, unknown> = {};
    query['select'] = vi.fn(() => query);
    query['eq'] = vi.fn(() => query);
    query['order'] = vi.fn(async () => ({ data: [...files], error: null }));
    query['delete'] = vi.fn(() => query);
    query['then'] = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
    return query;
  });

  const upload = vi.fn(async (path: string, _file: File, _options: unknown) => ({
    data: { path },
    error: null,
  }));
  const remove = vi.fn(async (_paths: string[]) => ({ data: [], error: null }));
  const download = vi.fn(async () => ({ data: new Blob(['evidence']), error: null }));
  const storageFrom = vi.fn(() => ({ upload, remove, download }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'register_task_file') {
      files = [...files, {
        id: 'task-file-1',
        workspace_id: args['p_workspace_id'],
        task_id: args['p_task_id'],
        file_name: args['p_file_name'],
        storage_path: args['p_storage_path'],
        content_type: args['p_content_type'],
        uploaded_by: userId,
        created_at: '2026-10-22T10:01:00.000Z',
      }];
    }
    return { data: 'task-file-1', error: null };
  });

  const client = {
    from,
    rpc,
    storage: { from: storageFrom },
  } as unknown as SupabaseClient;

  return { client, from, rpc, upload, remove, download, storageFrom };
}

describe('TaskAttachmentsPanel', () => {
  it('uploads and registers an allowed attachment before showing it in the saved list', async () => {
    const { client, upload, rpc } = createClient();
    render(
      <TaskAttachmentsPanel
        client={client}
        task={makeTask()}
        userId={userId}
        canAccessWorkspace
      />,
    );

    const attachButton = await screen.findByRole('button', { name: 'Attach file' });
    const file = new File(['invoice text'], 'invoice.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file] } });

    expect(await screen.findByText('Uploaded invoice.txt.')).toBeInTheDocument();
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${workspaceId}/${taskId}/[0-9a-f-]+/invoice\\.txt$`)),
      file,
      { contentType: 'text/plain', upsert: false },
    );
    expect(rpc).toHaveBeenCalledWith('register_task_file', {
      p_workspace_id: workspaceId,
      p_task_id: taskId,
      p_file_name: 'invoice.txt',
      p_storage_path: expect.stringMatching(new RegExp(`^${workspaceId}/${taskId}/[0-9a-f-]+/invoice\\.txt$`)),
      p_content_type: 'text/plain',
    });
    expect(await screen.findByText('invoice.txt')).toBeInTheDocument();
    expect(attachButton).toBeEnabled();
  });

  it('rejects unsupported files before contacting Storage', async () => {
    const { client, upload } = createClient();
    render(
      <TaskAttachmentsPanel
        client={client}
        task={makeTask()}
        userId={userId}
        canAccessWorkspace
      />,
    );

    await screen.findByRole('button', { name: 'Attach file' });
    fireEvent.change(screen.getByLabelText('Choose attachment'), {
      target: { files: [new File(['bad'], 'payload.exe', { type: 'application/octet-stream' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a PDF/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not offer upload when the workflow is no longer in Planning', async () => {
    const { client, upload } = createClient();
    render(
      <TaskAttachmentsPanel
        client={client}
        task={makeTask('Running')}
        userId={userId}
        canAccessWorkspace
      />,
    );

    expect(await screen.findByText('No attachments yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not offer upload when workspace access is false', async () => {
    const { client } = createClient();
    render(
      <TaskAttachmentsPanel
        client={client}
        task={makeTask()}
        userId={userId}
        canAccessWorkspace={false}
      />,
    );

    expect(await screen.findByText('No attachments yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach file' })).not.toBeInTheDocument();
  });
});
