import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_TASK_ATTACHMENT_BYTES,
  TASK_ATTACHMENT_BUCKET,
  sanitizeTaskAttachmentFileName,
  taskAttachmentValidationError,
} from '../taskAttachments';

interface GoogleDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string | null;
  readonly webViewLink: string | null;
  readonly canPreview: boolean;
}

interface GoogleDriveFilePreview {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly content: string;
}

interface PlanningTaskOption {
  readonly id: string;
  readonly title: string;
}

interface GoogleConnectionStatus {
  readonly connected: boolean;
  readonly email: string | null;
  readonly connectedAt: string | null;
  readonly scopes: readonly string[];
}

interface GoogleWorkspacePanelProps {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly canAccessWorkspace: boolean;
}

export function GoogleWorkspacePanel({
  client,
  workspaceId,
  canAccessWorkspace,
}: GoogleWorkspacePanelProps) {
  const [connection, setConnection] = useState<GoogleConnectionStatus>({
    connected: false,
    email: null,
    connectedAt: null,
    scopes: [],
  });
  const [files, setFiles] = useState<GoogleDriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<GoogleDriveFilePreview | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const [planningTasks, setPlanningTasks] = useState<PlanningTaskOption[]>([]);
  const [planningTasksLoading, setPlanningTasksLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [importing, setImporting] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [filesLoading, setFilesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => {
    const result = new URL(window.location.href).searchParams.get('google_connection');
    if (!result) return '';
    const messages: Record<string, string> = {
      connected: 'Google Workspace is connected. You can list accessible Drive file metadata.',
      denied: 'Google authorization was cancelled.',
      expired: 'The Google authorization link expired or was already used. Start a new connection attempt.',
      error: 'Google authorization could not be completed. Check configuration and try again.',
    };
    return messages[result] ?? 'Google authorization returned an unknown status.';
  });

  const refreshStatus = useCallback(async () => {
    if (!canAccessWorkspace) return;
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'status', workspaceId },
      });
      if (invokeError || !isRecord(data) || typeof data.connected !== 'boolean') {
        throw new Error('Google status unavailable.');
      }
      setConnection({
        connected: data.connected,
        email: typeof data.email === 'string' ? data.email : null,
        connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : null,
        scopes: Array.isArray(data.scopes) && data.scopes.every((scope) => typeof scope === 'string')
          ? data.scopes
          : [],
      });
    } catch {
      setError('Unable to check Google Workspace connection status. Check configuration and workspace access.');
    } finally {
      setStatusLoading(false);
    }
  }, [canAccessWorkspace, client, workspaceId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('google_connection')) {
      url.searchParams.delete('google_connection');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    void Promise.resolve().then(refreshStatus);
  }, [refreshStatus]);

  async function connect() {
    if (!canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'connect', workspaceId },
      });
      if (invokeError || !isRecord(data) || typeof data.authorizationUrl !== 'string') {
        throw new Error('Google authorization is unavailable.');
      }
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
        throw new Error('Google authorization endpoint is invalid.');
      }
      window.location.assign(authorizationUrl.toString());
    } catch {
      setError('Unable to start Google authorization. Confirm the server-side OAuth client and redirect URI are configured.');
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'disconnect', workspaceId },
      });
      if (invokeError || !isRecord(data) || data.connected !== false) {
        throw new Error('Google disconnect failed.');
      }
      setConnection({ connected: false, email: null, connectedAt: null, scopes: [] });
      setFiles([]);
      setNextPageToken(null);
      setPreview(null);
      setImportPanelOpen(false);
      setPlanningTasks([]);
      setSelectedTaskId('');
      setNotice(data.credentialCleanupPending === true
        ? 'Google disconnected. Credential cleanup is pending on the server.'
        : 'Google Workspace disconnected.');
    } catch {
      setError('Unable to disconnect Google Workspace. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function loadFiles(pageToken?: string | null) {
    if (!canAccessWorkspace || !connection.connected || filesLoading) return;
    setFilesLoading(true);
    setError('');
    try {
      const body: Record<string, unknown> = { action: 'list_files', workspaceId, pageSize: 20 };
      if (pageToken) body.pageToken = pageToken;
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', { body });
      if (invokeError || !isRecord(data) || data.connected !== true || !Array.isArray(data.files)) {
        throw new Error('Drive list is unavailable.');
      }
      const parsed = data.files.flatMap((candidate): GoogleDriveFile[] => {
        if (!isRecord(candidate) ||
          typeof candidate.id !== 'string' || !candidate.id ||
          typeof candidate.name !== 'string' ||
          typeof candidate.mimeType !== 'string') return [];
        return [{
          id: candidate.id,
          name: candidate.name,
          mimeType: candidate.mimeType,
          modifiedTime: typeof candidate.modifiedTime === 'string' ? candidate.modifiedTime : null,
          webViewLink: typeof candidate.webViewLink === 'string' && isSafeGoogleFileUrl(candidate.webViewLink)
            ? candidate.webViewLink
            : null,
          canPreview: candidate.canPreview === true,
        }];

      });
      setFiles((current) => pageToken ? [...current, ...parsed] : parsed);
      setNextPageToken(typeof data.nextPageToken === 'string' ? data.nextPageToken : null);
    } catch {
      setError('Unable to list Google Drive file metadata. Reconnect if authorization has expired.');
    } finally {
      setFilesLoading(false);
    }
  }

  async function loadPreview(file: GoogleDriveFile) {
    if (!canAccessWorkspace || !connection.connected || !file.canPreview || previewLoadingId) return;
    setPreviewLoadingId(file.id);
    setError('');
    setNotice('');
    setPreview(null);
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'preview_file', workspaceId, fileId: file.id },
      });
      if (invokeError || !isRecord(data) || data.connected !== true || !isRecord(data.preview) ||
        data.preview.id !== file.id || typeof data.preview.name !== 'string' ||
        typeof data.preview.mimeType !== 'string' || typeof data.preview.content !== 'string' ||
        data.preview.content.length > 256 * 1024) {
        throw new Error('Drive preview is unavailable.');
      }
      setPreview({
        id: file.id,
        name: data.preview.name.slice(0, 1000),
        mimeType: data.preview.mimeType,
        content: data.preview.content,
      });
    } catch {
      setError('Unable to preview this Drive file. Open it in Google Drive if preview is unsupported.');
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function openImportPicker() {
    if (!canAccessWorkspace || !connection.connected || !preview || importing || planningTasksLoading) return;
    setImportPanelOpen(true);
    setError('');
    setNotice('');
    setPlanningTasksLoading(true);
    try {
      const { data, error: queryError } = await client
        .from('tasks')
        .select('id, title, status')
        .eq('workspace_id', workspaceId)
        .eq('status', 'Planning')
        .order('created_at', { ascending: false })
        .limit(50);
      if (queryError || !Array.isArray(data)) {
        throw new Error('Could not load Planning workflows.');
      }
      const options = data.flatMap((value): PlanningTaskOption[] => {
        if (!isRecord(value) || typeof value.id !== 'string' ||
          typeof value.title !== 'string' || value.status !== 'Planning') return [];
        return [{ id: value.id, title: value.title.slice(0, 200) }];
      });
      setPlanningTasks(options);
      setSelectedTaskId((current) => options.some((task) => task.id === current) ? current : (options[0]?.id ?? ''));
      if (options.length === 0) setNotice('There are no Planning workflows in this workspace yet. Create a workflow first, then import the Drive content.');
    } catch {
      setError('Unable to load Planning workflows. Check workspace access and retry.');
      setImportPanelOpen(false);
    } finally {
      setPlanningTasksLoading(false);
    }
  }

  async function importPreviewToTask() {
    if (!canAccessWorkspace || !connection.connected || !preview || importing || !selectedTaskId) return;
    const target = planningTasks.find((task) => task.id === selectedTaskId);
    if (!target) {
      setError('Choose a Planning workflow before importing.');
      return;
    }
    const fileKind = getImportFileKind(preview.mimeType);
    if (!fileKind) {
      setError('This Drive file type cannot be imported as a workflow attachment.');
      return;
    }

    const stem = preview.name.replace(/[.][^.]*$/, '').trim() || 'google-drive-file';
    const fileName = sanitizeTaskAttachmentFileName(`${stem}${fileKind.extension}`);
    const file = new File([preview.content], fileName, { type: fileKind.contentType });
    const validationError = taskAttachmentValidationError(fileName, file.size);
    if (validationError || file.size > MAX_TASK_ATTACHMENT_BYTES) {
      setError(validationError ?? 'The imported text is too large.');
      return;
    }

    setImporting(true);
    setError('');
    setNotice('');
    const storagePath = `${workspaceId}/${target.id}/${crypto.randomUUID()}/${fileName}`;
    try {
      const uploaded = await client.storage.from(TASK_ATTACHMENT_BUCKET)
        .upload(storagePath, file, { contentType: fileKind.contentType, upsert: false });
      if (uploaded.error) throw new Error('The Drive content could not be copied into private task storage.');

      const registered = await client.rpc('register_task_file', {
        p_workspace_id: workspaceId,
        p_task_id: target.id,
        p_file_name: fileName,
        p_storage_path: storagePath,
        p_content_type: fileKind.contentType,
      });
      if (registered.error) {
        try {
          await client.storage.from(TASK_ATTACHMENT_BUCKET).remove([storagePath]);
        } catch {
          // Best-effort compensation; never expose storage/provider details to the UI.
        }
        throw new Error('The import could not be registered securely. Temporary-copy cleanup was attempted.');
      }
      setImportPanelOpen(false);
      setNotice(`Imported ${fileName} into "${target.title}". Open that Planning workflow to review its attachment.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import the selected Drive file.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="google-workspace panel" aria-labelledby="google-workspace-title">
      <header className="google-workspace__heading">
        <div>
          <p className="eyebrow">Connected services</p>
          <h3 id="google-workspace-title">Google Workspace</h3>
        </div>
        {connection.connected && <span className="status-pill">Connected</span>}
      </header>
      <p className="google-workspace__description">
Connect Google to list Drive metadata and preview supported text. When you explicitly import a preview, its text is copied into a selected Planning workflow as a private attachment; the Google Drive source remains unchanged. Nothing is imported or sent to the planner without your click. This integration does not edit, create, or share files in Google Drive and does not access Gmail.
      </p>

      {canAccessWorkspace && statusLoading ? (
        <p role="status">Checking Google connection…</p>
      ) : canAccessWorkspace && connection.connected ? (
        <div className="google-workspace__connection">
          <p>
            Connected as <strong>{connection.email ?? 'Google account'}</strong>
            {connection.connectedAt && (
              <span className="google-workspace__date">
                {' · '}Connected {new Date(connection.connectedAt).toLocaleString()}
              </span>
            )}
          </p>
          {canAccessWorkspace && (
            <div className="task-actions">
              <button className="button button--secondary" disabled={busy || filesLoading} onClick={() => void loadFiles(null)} type="button">
                {filesLoading ? 'Loading files…' : 'List Drive files'}
              </button>
              <button className="button button--quiet" disabled={busy} onClick={() => void disconnect()} type="button">
                Disconnect
              </button>
            </div>
          )}
          {files.length > 0 && (
            <ul className="google-workspace__files">
              {files.map((file) => (
                <li key={file.id} className="google-workspace__file">
                  <div className="google-workspace__file-main">
                    {file.webViewLink ? (
                      <a href={file.webViewLink} rel="noopener noreferrer" target="_blank">{file.name || 'Untitled file'}</a>
                    ) : (
                      <strong>{file.name || 'Untitled file'}</strong>
                    )}
                    <span>{file.mimeType}</span>
                    {file.modifiedTime && <small>Modified {new Date(file.modifiedTime).toLocaleString()}</small>}
                    {file.canPreview && (
                      <button
                        className="button button--quiet"
                        disabled={Boolean(previewLoadingId) || busy || importing}
                        onClick={() => void loadPreview(file)}
                        type="button"
                      >
                        {previewLoadingId === file.id ? 'Loading preview…' : 'Preview text'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {files.length === 0 && !filesLoading && (
            <p className="google-workspace__empty">No Drive files loaded yet. Listing returns metadata for files that Google makes available to this app.</p>
          )}
          {preview && (
            <section className="google-workspace__preview" aria-label="Drive text preview">
              <header>
                <strong>{preview.name}</strong>
                <span>{preview.mimeType}</span>
                <button className="button button--quiet" onClick={() => setPreview(null)} type="button">Close preview</button>
              </header>
              <pre>{preview.content || '(This file is empty.)'}</pre>
              <p className="google-workspace__scope-note">Temporary preview. Google Sheets exports show the first worksheet only.</p>
              {!importPanelOpen ? (
                <button
                  className="button button--secondary"
                  disabled={!canAccessWorkspace || importing || busy}
                  onClick={() => void openImportPicker()}
                  type="button"
                >
                  Import to a Planning workflow
                </button>
              ) : (
                <div className="google-workspace__import">
                  {planningTasksLoading ? (
                    <p role="status">Loading Planning workflows…</p>
                  ) : planningTasks.length > 0 ? (
                    <>
                      <label htmlFor="google-drive-import-task">Choose a Planning workflow</label>
                      <select
                        id="google-drive-import-task"
                        value={selectedTaskId}
                        onChange={(event) => setSelectedTaskId(event.target.value)}
                        disabled={importing}
                      >
                        {planningTasks.map((task) => (
                          <option key={task.id} value={task.id}>{task.title}</option>
                        ))}
                      </select>
                      <p className="google-workspace__scope-note">This copies the exported text into private FlowWork storage as a task attachment. The source in Google Drive is unchanged, and no workflow action is executed.</p>
                      <div className="task-actions">
                        <button
                          className="button"
                          disabled={!selectedTaskId || importing}
                          onClick={() => void importPreviewToTask()}
                          type="button"
                        >
                          {importing ? 'Importing…' : 'Import file'}
                        </button>
                        <button
                          className="button button--quiet"
                          disabled={importing}
                          onClick={() => setImportPanelOpen(false)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="button button--quiet" onClick={() => setImportPanelOpen(false)} type="button">
                      Close
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {nextPageToken && (
            <button className="button button--secondary" disabled={filesLoading} onClick={() => void loadFiles(nextPageToken)} type="button">
              {filesLoading ? 'Loading…' : 'Load more files'}
            </button>
          )}
        </div>
      ) : (
        <div className="google-workspace__connect">
          <p className="google-workspace__empty">
            {canAccessWorkspace
              ? 'Connect a Google account to list metadata for files available to this app.'
              : 'Workspace access is required to connect an account.'}
          </p>
          {canAccessWorkspace && (
            <button className="button" disabled={busy} onClick={() => void connect()} type="button">
              {busy ? 'Connecting…' : 'Connect Google account'}
            </button>
          )}
        </div>
      )}

      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <p className="google-workspace__scope-note">
        Google OAuth credentials and refresh tokens are server-only. File listing uses the limited Drive `drive.file` scope; no credentials are placed in the browser.
      </p>
    </section>
  );
}

function getImportFileKind(mimeType: string): { readonly extension: string; readonly contentType: string } | null {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
    case 'application/vnd.google-apps.presentation':
    case 'text/plain':
    case 'text/markdown':
      return { extension: '.txt', contentType: 'text/plain' };
    case 'application/vnd.google-apps.spreadsheet':
    case 'text/csv':
      return { extension: '.csv', contentType: 'text/csv' };
    case 'text/tab-separated-values':
      return { extension: '.tsv', contentType: 'text/tab-separated-values' };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeGoogleFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com', 'forms.google.com'].includes(url.hostname) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}
