import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  type WorkflowCommand,
  type WorkflowCommandContext,
} from '../workflow/workflow';
import {
  SupabaseWorkflowRepository,
  type PersistedTask,
  type WorkspaceRecord,
} from '../backend/workflowRepository';
import {
  applyTaskCommand,
  createWorkflowTask,
} from '../backend/workflowService';
import {
  getSupabaseClient,
  SupabaseConfigurationError,
} from '../backend/supabaseClient';
import { TaskTimeline } from './components/TaskTimeline';

export function App() {
  const [connection] = useState(initializeConnection);
  const client = connection.client;
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(client !== null);
  const [authError, setAuthError] = useState('');
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const result = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthError('');
      setLinkSent(false);
    });
    const subscription = result.data.subscription;
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setAuthError('Unable to restore your sign-in. Please reload and try again.');
        } else {
          setSession(data.session);
        }
        setAuthLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setAuthError('Unable to restore your sign-in. Please reload and try again.');
        setAuthLoading(false);
      });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [client]);

  async function requestSignInLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !email.trim()) return;
    setAuthError('');
    try {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setLinkSent(true);
    } catch {
      setAuthError('Unable to send a sign-in link. Check the email address and try again.');
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FlowWork home">
          <span className="brand__mark" aria-hidden="true">F</span>
          <span>FlowWork</span>
        </a>
        {session && client ? (
          <button
            className="button button--quiet"
            onClick={() => {
              void client.auth.signOut().then(({ error }) => {
                if (error) {
                  setAuthError('Unable to sign out. Please retry.');
                }
              }).catch(() => setAuthError('Unable to sign out. Please retry.'));
            }}
            type="button"
          >
            Sign out
          </button>
        ) : (
          <span className="preview-badge">Private workspace</span>
        )}
      </header>

      <main className="main-content">
        {authError && session && (
          <p className="error-message" role="alert">{authError}</p>
        )}
        <section className="welcome" aria-labelledby="welcome-title">
          <p className="eyebrow">Your workspace</p>
          <h1 id="welcome-title">Make work move forward.</h1>
          <p className="welcome__description">
            Create tasks, record approvals and verification, and return to the
            saved workflow whenever you need it.
          </p>
        </section>

        {connection.setupMessage ? (
          <section className="panel" aria-labelledby="setup-title">
            <h2 id="setup-title">Connect Supabase to continue</h2>
            <p>{connection.setupMessage}</p>
            <p>
              Add the project URL and public anon key to a local <code>.env</code>
              file, then restart the development server. Never use a service-role
              key in this application.
            </p>
          </section>
        ) : authLoading ? (
          <section className="panel" role="status">Checking your sign-in…</section>
        ) : session && client ? (
          <WorkspaceView client={client} userId={session.user.id} />
        ) : (
          <section className="panel auth-panel" aria-labelledby="signin-title">
            <p className="eyebrow">Sign in</p>
            <h2 id="signin-title">Open your private workspace</h2>
            <p>A secure sign-in link will be sent to your email address.</p>
            <form className="form-stack" onSubmit={requestSignInLink}>
              <label>
                Email address
                <input
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </label>
              <button className="button" disabled={!client} type="submit">
                Send sign-in link
              </button>
            </form>
            {linkSent && (
              <p className="notice" role="status">
                Check your inbox for a sign-in link.
              </p>
            )}
            {authError && <p className="error-message" role="alert">{authError}</p>}
          </section>
        )}
      </main>

      <footer className="footer">Built for clear, dependable work.</footer>
    </div>
  );
}

function WorkspaceView({
  client,
  userId,
}: {
  readonly client: SupabaseClient;
  readonly userId: string;
}) {
  const repository = useMemo(() => new SupabaseWorkflowRepository(client), [client]);
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [tasks, setTasks] = useState<PersistedTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [decisionReason, setDecisionReason] = useState('');
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const canAccessWorkspace = useWorkspacePermission(userId, workspace);

  useEffect(() => {
    let active = true;
    async function loadWorkspace() {
      setLoading(true);
      setError('');
      try {
        const workspaces = await repository.listWorkspaces(userId);
        const activeWorkspace =
          workspaces[0] ?? (await repository.createWorkspace('My workspace'));
        if (!active) return;
        setWorkspace(activeWorkspace);
        const savedTasks = await repository.listTasks(activeWorkspace.id);
        if (!active) return;
        setTasks(savedTasks);
        setSelectedTaskId(savedTasks[0]?.id ?? null);
      } catch {
        if (active) {
          setError('Unable to load your workspace. Check your connection and access, then retry.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadWorkspace();
    return () => {
      active = false;
    };
  }, [repository, userId]);

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !canAccessWorkspace || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const task = await createWorkflowTask(repository, {
        workspaceId: workspace.id,
        actorId: userId,
        title: title.trim(),
        details: details.trim(),
      });
      setTasks((existing) => [task, ...existing]);
      setSelectedTaskId(task.id);
      setTitle('');
      setDetails('');
      setTaskFormOpen(false);
    } catch (caught) {
      setError(readableWorkflowError(caught, 'Unable to create this task.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveCommand(command: WorkflowCommand) {
    if (!selectedTask || !canAccessWorkspace) return;
    setBusy(true);
    setError('');
    try {
      const workflow = await applyTaskCommand(
        repository,
        selectedTask.workflow,
        command,
      );
      setTasks((existing) =>
        existing.map((task) =>
          task.id === selectedTask.id
            ? { ...task, workflow, updatedAt: new Date().toISOString() }
            : task,
        ),
      );
    } catch (caught) {
      setError(readableWorkflowError(caught, 'Unable to save this workflow update.'));
    } finally {
      setBusy(false);
    }
  }

  function commandContext(task: PersistedTask): WorkflowCommandContext {
    return {
      taskId: task.id,
      tenantId: task.workspaceId,
      ownerId: task.ownerId,
      actorId: userId,
      actorTenantId: task.workspaceId,
      idempotencyKey: crypto.randomUUID(),
      expectedSequence: task.workflow.events.length,
      occurredAt: new Date().toISOString(),
    };
  }

  if (loading) {
    return <section className="panel" role="status">Loading your saved workspace…</section>;
  }
  if (!workspace || !canAccessWorkspace) {
    return (
      <section className="panel" role="alert">
        <h2>Workspace access unavailable</h2>
        <p>Your account is not a member of an available workspace.</p>
        {error && <p className="error-message">{error}</p>}
      </section>
    );
  }

  return (
    <section className="workspace" aria-label={`${workspace.name} workspace`}>
      <div className="workspace__heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2>{workspace.name}</h2>
        </div>
        <button
          className="button"
          onClick={() => setTaskFormOpen((open) => !open)}
          type="button"
        >
          {taskFormOpen ? 'Close' : 'New task'}
        </button>
      </div>

      <p className="workspace-note">
        Status changes are recorded explicitly; tasks are not executed automatically.
      </p>

      {error && <p className="error-message" role="alert">{error}</p>}

      {taskFormOpen && (
        <form className="panel form-stack task-form" onSubmit={submitTask}>
          <label>
            Task name
            <input
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <label>
            Details <span className="optional-label">Optional</span>
            <textarea
              maxLength={10000}
              onChange={(event) => setDetails(event.target.value)}
              rows={3}
              value={details}
            />
          </label>
          <button className="button" disabled={busy} type="submit">
            Create task in Planning
          </button>
        </form>
      )}

      {tasks.length === 0 ? (
        <section className="panel empty-state">
          <h3>No tasks yet</h3>
          <p>Create a task to start a saved workflow in Planning.</p>
        </section>
      ) : (
        <div className="task-layout">
          <nav className="task-list panel" aria-label="Saved tasks">
            <h3>Tasks</h3>
            {tasks.map((task) => (
              <button
                aria-current={selectedTaskId === task.id ? 'true' : undefined}
                className={`task-list__item${selectedTaskId === task.id ? ' task-list__item--selected' : ''}`}
                key={task.id}
                onClick={() => setSelectedTaskId(task.id)}
                type="button"
              >
                <span>{task.title}</span>
                <small>{task.workflow.task.status}</small>
              </button>
            ))}
          </nav>
          {selectedTask && (
            <article className="task-detail panel">
              <header className="task-detail__heading">
                <div>
                  <p className="eyebrow">Saved task</p>
                  <h2>{selectedTask.title}</h2>
                </div>
                <span className={`status-pill status-pill--${statusClass(selectedTask.workflow.task.status)}`}>
                  {selectedTask.workflow.task.status}
                </span>
              </header>
              {selectedTask.details && <p className="task-details">{selectedTask.details}</p>}

              <TaskTimeline aggregate={selectedTask.workflow} />

              <div className="task-actions" aria-label="Workflow actions">
                {selectedTask.workflow.task.status === 'Planning' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void saveCommand({ ...commandContext(selectedTask), type: 'start' })}
                    type="button"
                  >
                    Start task
                  </button>
                )}
                {selectedTask.workflow.task.status === 'Running' && (
                  <>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => void saveCommand({
                        ...commandContext(selectedTask),
                        type: 'request-approval',
                        requestId: crypto.randomUUID(),
                      })}
                      type="button"
                    >
                      Request approval
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void saveCommand({
                        ...commandContext(selectedTask),
                        type: 'begin-verification',
                      })}
                      type="button"
                    >
                      Begin verification
                    </button>
                  </>
                )}
                {selectedTask.workflow.task.status === 'Waiting for approval' && (
                  <>
                    <label className="action-field">
                      Decision note <span className="optional-label">Optional</span>
                      <input
                        onChange={(event) => setDecisionReason(event.target.value)}
                        value={decisionReason}
                      />
                    </label>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void resolveApproval(selectedTask, true)}
                      type="button"
                    >
                      Approve and continue
                    </button>
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => void resolveApproval(selectedTask, false)}
                      type="button"
                    >
                      Reject approval
                    </button>
                  </>
                )}
                {selectedTask.workflow.task.status === 'Verifying' && (
                  <>
                    <label className="action-field">
                      Verification evidence reference
                      <input
                        onChange={(event) => setEvidenceReference(event.target.value)}
                        placeholder="Reference to the evidence checked"
                        required
                        value={evidenceReference}
                      />
                    </label>
                    <button
                      className="button"
                      disabled={busy || !evidenceReference.trim()}
                      onClick={() => void recordVerification(selectedTask, true)}
                      type="button"
                    >
                      Record verification passed
                    </button>
                    <button
                      className="button button--danger"
                      disabled={busy || !evidenceReference.trim()}
                      onClick={() => void recordVerification(selectedTask, false)}
                      type="button"
                    >
                      Record verification failed
                    </button>
                  </>
                )}
                {selectedTask.workflow.task.status === 'Failed' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void saveCommand({
                      ...commandContext(selectedTask),
                      type: 'retry',
                      reason: 'User requested a retry.',
                    })}
                    type="button"
                  >
                    Retry task
                  </button>
                )}
                {selectedTask.workflow.task.status === 'Completed' && (
                  <p className="notice">Verification evidence is recorded for this task.</p>
                )}
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  );

  function resolveApproval(task: PersistedTask, approved: boolean) {
    const request = [...task.workflow.events]
      .reverse()
      .find((event) => event.type === 'approval.requested');
    if (!request || request.type !== 'approval.requested') {
      setError('No pending approval request was found in the saved history.');
      return;
    }
    return saveCommand({
      ...commandContext(task),
      type: 'resolve-approval',
      result: {
        requestId: request.requestId,
        decision: approved ? 'approved' : 'rejected',
        approverId: userId,
        decidedAt: new Date().toISOString(),
        ...(decisionReason.trim() ? { reason: decisionReason.trim() } : {}),
      },
    });
  }

  function recordVerification(task: PersistedTask, passed: boolean) {
    const reference = evidenceReference.trim();
    if (!reference) return;
    const command: WorkflowCommand = {
      ...commandContext(task),
      type: 'record-verification',
      result: {
        passed,
        evidenceReference: reference,
        verifiedBy: userId,
        verifiedAt: new Date().toISOString(),
        ...(passed ? {} : { summary: 'Verification did not pass.' }),
      },
    };
    return saveCommand(command);
  }
}

function useWorkspacePermission(
  userId: string,
  workspace: WorkspaceRecord | null,
): boolean {
  return workspace?.memberUserIds.includes(userId) ?? false;
}

function initializeConnection(): {
  readonly client: SupabaseClient | null;
  readonly setupMessage: string;
} {
  try {
    return { client: getSupabaseClient(), setupMessage: '' };
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) {
      return { client: null, setupMessage: error.message };
    }
    return {
      client: null,
      setupMessage: 'Unable to initialize authentication. Check the Supabase configuration.',
    };
  }
}

function readableWorkflowError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

function statusClass(status: string): string {
  return status.toLowerCase().replaceAll(' ', '-');
}
