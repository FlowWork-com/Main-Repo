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

interface GoogleGmailMessageSummary {
  readonly id: string;
  readonly threadId: string | null;
  readonly subject: string;
  readonly from: string;
  readonly date: string | null;
  readonly snippet: string;
  readonly labelIds: readonly string[];
}

interface GoogleGmailMessagePreview extends GoogleGmailMessageSummary {
  readonly content: string;
  readonly contentSource: 'text/plain' | 'snippet';
}

interface GoogleConnectionStatus {
  readonly connected: boolean;
  readonly email: string | null;
  readonly connectedAt: string | null;
  readonly scopes: readonly string[];
}

const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

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
  const [gmailMessages, setGmailMessages] = useState<GoogleGmailMessageSummary[]>([]);
  const [gmailNextPageToken, setGmailNextPageToken] = useState<string | null>(null);
  const [gmailMessagesLoading, setGmailMessagesLoading] = useState(false);
  const [gmailPreview, setGmailPreview] = useState<GoogleGmailMessagePreview | null>(null);
  const [gmailPreviewLoadingId, setGmailPreviewLoadingId] = useState<string | null>(null);
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
      connected: 'Google Workspace is connected. Return to the panel to use the services you authorized.',
      gmail_connected: 'Gmail read-only access connected. You can now list and preview messages.',
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

  async function connectGmail() {
    if (!canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'connect_gmail', workspaceId },
      });
      if (invokeError || !isRecord(data) || typeof data.authorizationUrl !== 'string') {
        throw new Error('Gmail authorization is unavailable.');
      }
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
        throw new Error('Google authorization endpoint is invalid.');
      }
      window.location.assign(authorizationUrl.toString());
    } catch {
      setError('Unable to start Gmail read-only authorization. Confirm Google OAuth configuration and try again.');
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
      setGmailMessages([]);
      setGmailNextPageToken(null);
      setGmailPreview(null);
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

  async function loadGmailMessages(pageToken?: string | null) {
    if (!canAccessWorkspace || !connection.connected ||
      !connection.scopes.includes(GOOGLE_GMAIL_READONLY_SCOPE) || gmailMessagesLoading) return;
    setGmailMessagesLoading(true);
    setError('');
    try {
      const body: Record<string, unknown> = { action: 'list_gmail', workspaceId, pageSize: 10 };
      if (pageToken) body.pageToken = pageToken;
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', { body });
      if (invokeError || !isRecord(data) || data.connected !== true || !Array.isArray(data.messages)) {
        throw new Error('Gmail list is unavailable.');
      }
      const parsed = data.messages.flatMap((candidate): GoogleGmailMessageSummary[] => {
        if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id ||
          typeof candidate.subject !== 'string' || typeof candidate.from !== 'string' ||
          typeof candidate.snippet !== 'string') return [];
        return [{
          id: candidate.id,
          threadId: typeof candidate.threadId === 'string' ? candidate.threadId : null,
          subject: candidate.subject.slice(0, 500),
          from: candidate.from.slice(0, 500),
          date: typeof candidate.date === 'string' ? candidate.date : null,
          snippet: candidate.snippet.slice(0, 1200),
          labelIds: Array.isArray(candidate.labelIds)
            ? candidate.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 25)
            : [],
        }];
      });
      setGmailMessages((current) => pageToken ? [...current, ...parsed] : parsed);
      setGmailNextPageToken(typeof data.nextPageToken === 'string' ? data.nextPageToken : null);
    } catch {
      setError('Unable to list Gmail messages. Connect Gmail read-only access or reconnect if authorization has expired.');
    } finally {
      setGmailMessagesLoading(false);
    }
  }

  async function loadGmailPreview(message: GoogleGmailMessageSummary) {
    if (!canAccessWorkspace || !connection.connected ||
      !connection.scopes.includes(GOOGLE_GMAIL_READONLY_SCOPE) || gmailPreviewLoadingId) return;
    setGmailPreviewLoadingId(message.id);
    setError('');
    setNotice('');
    setGmailPreview(null);
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('google-workspace', {
        body: { action: 'preview_gmail_message', workspaceId, messageId: message.id },
      });
      if (invokeError || !isRecord(data) || data.connected !== true || !isRecord(data.preview) ||
        data.preview.id !== message.id || typeof data.preview.subject !== 'string' ||
        typeof data.preview.from !== 'string' || typeof data.preview.content !== 'string' ||
        data.preview.content.length > 64 * 1024 ||
        (data.preview.contentSource !== 'text/plain' && data.preview.contentSource !== 'snippet')) {
        throw new Error('Gmail preview is unavailable.');
      }
      setGmailPreview({
        id: message.id,
        threadId: typeof data.preview.threadId === 'string' ? data.preview.threadId : null,
        subject: data.preview.subject.slice(0, 500),
        from: data.preview.from.slice(0, 500),
        date: typeof data.preview.date === 'string' ? data.preview.date : null,
        snippet: typeof data.preview.snippet === 'string' ? data.preview.snippet.slice(0, 1200) : '',
        labelIds: Array.isArray(data.preview.labelIds)
          ? data.preview.labelIds.filter((label): label is string => typeof label === 'string').slice(0, 25)
          : [],
        content: data.preview.content,
        contentSource: data.preview.contentSource,
      });
    } catch {
      setError('Unable to preview this Gmail message. Reconnect Gmail read-only access and try again.');
    } finally {
      setGmailPreviewLoadingId(null);
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
              {connection.scopes.includes(GOOGLE_DRIVE_SCOPE) ? (
                <button className="button button--secondary" disabled={busy || filesLoading} onClick={() => void loadFiles(null)} type="button">
                  {filesLoading ? 'Loading files…' : 'List Drive files'}
                </button>
              ) : (
                <button className="button button--secondary" disabled={busy} onClick={() => void connect()} type="button">
                  Connect Drive access
                </button>
              )}
              {!connection.scopes.includes(GOOGLE_GMAIL_READONLY_SCOPE) && (
                <button className="button button--secondary" disabled={busy} onClick={() => void connectGmail()} type="button">
                  Connect Gmail read-only
                </button>
              )}
              <button className="button button--quiet" disabled={busy} onClick={() => void disconnect()} type="button">
                Disconnect all Google access
              </button>
            </div>
          )}
          {connection.scopes.includes(GOOGLE_DRIVE_SCOPE) && files.length > 0 && (
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
          {connection.scopes.includes(GOOGLE_DRIVE_SCOPE) && files.length === 0 && !filesLoading && (
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
          {connection.scopes.includes(GOOGLE_GMAIL_READONLY_SCOPE) ? (
            <section className="google-workspace__gmail" aria-label="Gmail read-only">
              <div className="google-workspace__gmail-heading">
                <div>
                  <h4>Gmail</h4>
                  <p className="google-workspace__scope-note">Read-only access. FlowWork will not send, edit, label, archive, or delete email.</p>
                </div>
                <button className="button button--secondary" disabled={gmailMessagesLoading || busy || Boolean(gmailPreviewLoadingId)} onClick={() => void loadGmailMessages(null)} type="button">
                  {gmailMessagesLoading ? 'Loading messages…' : 'List recent Gmail messages'}
                </button>
              </div>
              {gmailMessages.length > 0 && (
                <ul className="google-workspace__files">
                  {gmailMessages.map((message) => (
                    <li key={message.id} className="google-workspace__file">
                      <div className="google-workspace__file-main">
                        <strong>{message.subject || '(No subject)'}</strong>
                        <span>{message.from}</span>
                        {message.date && <small>{new Date(message.date).toLocaleString()}</small>}
                        {message.snippet && <p className="google-workspace__scope-note">{message.snippet}</p>}
                        <button className="button button--quiet" disabled={Boolean(gmailPreviewLoadingId) || busy} onClick={() => void loadGmailPreview(message)} type="button">
                          {gmailPreviewLoadingId === message.id ? 'Loading message…' : 'Preview message'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {gmailMessages.length === 0 && !gmailMessagesLoading && (
                <p className="google-workspace__empty">No recent inbox messages loaded. Choose “List recent Gmail messages” to fetch metadata.</p>
              )}
              {gmailNextPageToken && (
                <button className="button button--secondary" disabled={gmailMessagesLoading} onClick={() => void loadGmailMessages(gmailNextPageToken)} type="button">
                  {gmailMessagesLoading ? 'Loading…' : 'Load more Gmail messages'}
                </button>
              )}
              {gmailPreview && (
                <section className="google-workspace__preview" aria-label="Gmail message preview">
                  <header>
                    <strong>{gmailPreview.subject}</strong>
                    <span>{gmailPreview.from}</span>
                    <button className="button button--quiet" onClick={() => setGmailPreview(null)} type="button">Close message</button>
                  </header>
                  {gmailPreview.date && <small>{new Date(gmailPreview.date).toLocaleString()}</small>}
                  <pre>{gmailPreview.content || '(No plain-text body or snippet available.)'}</pre>
                  <p className="google-workspace__scope-note">
                    {gmailPreview.contentSource === 'snippet'
                      ? 'Only Gmail’s message snippet is available; a plain-text body was not found. Attachments are not opened.'
                      : 'Temporary plain-text preview. Message content is not saved to task history or sent to the planner.'}
                  </p>
                </section>
              )}
            </section>
          ) : (
            <section className="google-workspace__gmail" aria-label="Gmail read-only">
              <h4>Gmail</h4>
              <p className="google-workspace__scope-note">Gmail has not been authorized for this workspace connection. It uses a separate restricted read-only scope.</p>
              <button className="button button--secondary" disabled={busy} onClick={() => void connectGmail()} type="button">
                Connect Gmail read-only
              </button>
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
            <div className="task-actions">
              <button className="button" disabled={busy} onClick={() => void connect()} type="button">
                {busy ? 'Connecting…' : 'Connect Google Drive'}
              </button>
              <button className="button button--secondary" disabled={busy} onClick={() => void connectGmail()} type="button">
                {busy ? 'Connecting…' : 'Connect Gmail read-only'}
              </button>
            </div>
          )}
        </div>
      )}

      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <p className="google-workspace__scope-note">
        Google OAuth credentials and refresh tokens remain server-only. Drive and Gmail scopes are granted separately; Gmail uses `gmail.readonly` and this UI exposes no email mutation actions.
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
