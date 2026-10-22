import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersistedTask } from '../../backend/workflowRepository';
import {
  MAX_TASK_ATTACHMENT_BYTES,
  TASK_ATTACHMENT_ACCEPT,
  TASK_ATTACHMENT_BUCKET,
  sanitizeTaskAttachmentFileName,
  taskAttachmentMimeType,
  taskAttachmentValidationError,
} from '../taskAttachments';

interface TaskFileRecord {
  readonly id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly file_name: string;
  readonly storage_path: string;
  readonly content_type: string | null;
  readonly uploaded_by: string;
  readonly created_at: string;
}

interface TaskAttachmentsPanelProps {
  readonly client: SupabaseClient;
  readonly task: PersistedTask;
  readonly userId: string;
  readonly canAccessWorkspace: boolean;
}

export function TaskAttachmentsPanel({
  client,
  task,
  userId,
  canAccessWorkspace,
}: TaskAttachmentsPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<TaskFileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canUpload = canAccessWorkspace && task.workflow.task.status === 'Planning';

  useEffect(() => {
    let active = true;

    async function loadFiles() {
      try {
        const { data, error: queryError } = await client
          .from('task_files')
          .select('id, workspace_id, task_id, file_name, storage_path, content_type, uploaded_by, created_at')
          .eq('workspace_id', task.workspaceId)
          .eq('task_id', task.id)
          .order('created_at', { ascending: false });
        if (!active) return;
        if (queryError) {
          setError('Could not load task attachments. Retry or check workspace access.');
          setFiles([]);
          return;
        }
        setFiles((data ?? []) as unknown as TaskFileRecord[]);
      } catch {
        if (!active) return;
        setError('Could not load task attachments. Retry or check workspace access.');
        setFiles([]);
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadFiles();
    return () => {
      active = false;
    };
  }, [client, task.id, task.workspaceId]);

  async function refreshFiles() {
    const { data, error: queryError } = await client
      .from('task_files')
      .select('id, workspace_id, task_id, file_name, storage_path, content_type, uploaded_by, created_at')
      .eq('workspace_id', task.workspaceId)
      .eq('task_id', task.id)
      .order('created_at', { ascending: false });
    if (queryError) throw new Error('The attachment was saved, but the file list could not be refreshed.');
    setFiles((data ?? []) as unknown as TaskFileRecord[]);
  }

  async function uploadFile(file: File) {
    const validationError = taskAttachmentValidationError(file.name, file.size);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!canUpload) {
      setError('Attachments can only be added to workflows in Planning.');
      return;
    }

    const mimeType = taskAttachmentMimeType(file.name);
    if (!mimeType) {
      setError('This file type is not supported.');
      return;
    }

    const fileName = sanitizeTaskAttachmentFileName(file.name);
    const storagePath = `${task.workspaceId}/${task.id}/${crypto.randomUUID()}/${fileName}`;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const uploaded = await client.storage
        .from(TASK_ATTACHMENT_BUCKET)
        .upload(storagePath, file, { contentType: mimeType, upsert: false });
      if (uploaded.error) {
        throw new Error('Upload failed. Check your connection, file size, and workspace access.');
      }

      const registered = await client.rpc('register_task_file', {
        p_workspace_id: task.workspaceId,
        p_task_id: task.id,
        p_file_name: fileName,
        p_storage_path: storagePath,
        p_content_type: mimeType,
      });
      if (registered.error) {
        // Best-effort compensation: do not knowingly leave an unregistered upload behind.
        await client.storage.from(TASK_ATTACHMENT_BUCKET).remove([storagePath]);
        throw new Error('The file could not be registered securely. The temporary upload was removed; please retry.');
      }

      await refreshFiles();
      setNotice(`Uploaded ${fileName}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not upload this attachment.');
    } finally {
      setBusy(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (selected) void uploadFile(selected);
  }

  async function copyFileId(file: TaskFileRecord) {
    setError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(file.id);
      setNotice(`Copied the ID for ${file.file_name}. Choose Invoice CSV review and paste it into the fileId field to run the analysis.`);
    } catch {
      setError(`Could not copy the file ID. Use this ID manually: ${file.id}`);
    }
  }

  async function downloadFile(file: TaskFileRecord) {
    if (!canAccessWorkspace || activeFileId || busy) return;
    setActiveFileId(file.id);
    setError('');
    setNotice('');
    try {
      const result = await client.storage.from(TASK_ATTACHMENT_BUCKET).download(file.storage_path);
      if (result.error || !result.data) throw new Error('Could not download this file. Check workspace access and retry.');
      const objectUrl = URL.createObjectURL(result.data);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = file.file_name;
      anchor.rel = 'noreferrer';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(`Downloading ${file.file_name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not download this attachment.');
    } finally {
      setActiveFileId(null);
    }
  }

  async function removeFile(file: TaskFileRecord) {
    if (!canAccessWorkspace || file.uploaded_by !== userId || activeFileId || busy) return;
    if (!window.confirm(`Remove ${file.file_name} from this workflow?`)) return;
    setActiveFileId(file.id);
    setError('');
    setNotice('');
    try {
      const removed = await client.storage.from(TASK_ATTACHMENT_BUCKET).remove([file.storage_path]);
      if (removed.error) throw new Error('Could not remove the stored file. Please retry.');
      const deleted = await client
        .from('task_files')
        .delete()
        .eq('id', file.id)
        .eq('workspace_id', task.workspaceId)
        .eq('task_id', task.id)
        .eq('uploaded_by', userId);
      if (deleted.error) {
        throw new Error('The stored file was removed, but its metadata could not be cleaned up. Refresh the workflow and retry.');
      }
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setNotice(`Removed ${file.file_name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove this attachment.');
    } finally {
      setActiveFileId(null);
    }
  }

  return (
    <section className="attachments-panel" aria-labelledby="attachments-heading">
      <div className="attachments-panel__heading">
        <div>
          <h3 id="attachments-heading">Task attachments</h3>
          <p>Private files saved with this workflow.</p>
        </div>
        {canUpload && (
          <>
            <input
              ref={input}
              type="file"
              accept={TASK_ATTACHMENT_ACCEPT}
              aria-label="Choose attachment"
              className="attachments-panel__input"
              disabled={busy || loading}
              onChange={handleFileChange}
            />
            <button
              className="button button--secondary"
              type="button"
              disabled={busy || loading}
              onClick={() => input.current?.click()}
            >
              {busy ? 'Uploading…' : 'Attach file'}
            </button>
          </>
        )}
      </div>
      <p className="attachments-panel__hint">
        PDF, TXT, CSV, TSV, XLS, or XLSX · Up to {MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)} MB per file
        {task.workflow.task.status !== 'Planning' && ' · Uploads are available while the workflow is in Planning'}
      </p>
      {error && <p role="alert" className="error-message">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {loading ? (
        <p className="attachments-panel__empty" role="status">Loading attachments…</p>
      ) : files.length === 0 ? (
        <p className="attachments-panel__empty">No attachments yet.</p>
      ) : (
        <ul className="attachments-list">
          {files.map((file) => (
            <li className="attachments-list__item" key={file.id}>
              <div className="attachments-list__file">
                <span className="attachments-list__icon" aria-hidden="true">↳</span>
                <div className="attachments-list__details">
                  <strong>{file.file_name}</strong>
                  <span>
                    {(file.content_type ?? 'File').replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel workbook')}
                    {' · '}
                    {new Date(file.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="attachments-list__actions">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => void copyFileId(file)}
                  aria-label={`Copy ID for ${file.file_name}`}
                >
                  Copy ID
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={Boolean(activeFileId) || busy}
                  onClick={() => void downloadFile(file)}
                >
                  {activeFileId === file.id ? 'Working…' : 'Download'}
                </button>
                {file.uploaded_by === userId && (
                  <button
                    className="button button--quiet attachments-list__remove"
                    type="button"
                    disabled={Boolean(activeFileId) || busy}
                    onClick={() => void removeFile(file)}
                    aria-label={`Remove ${file.file_name}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
