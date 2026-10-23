import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SupabaseToolExecutionHistoryRepository,
  type ToolExecutionHistoryEntry,
} from '../../backend/toolExecutionRepository';
import {
  executeTool,
  type ExecuteToolRequest,
} from '../../backend/toolExecutionClient';
import { isPersistableJson, type JsonValue } from '../../tools/contracts';
import { InvoiceExtractionFeedbackForm } from './InvoiceExtractionFeedbackForm';
import { MVP_TOOL_UI_METADATA } from '../../tools/toolMetadata';
import type { PersistedTask } from '../../backend/workflowRepository';

interface TaskToolExecutionPanelProps {
  readonly canAccessWorkspace: boolean;
  readonly client: SupabaseClient;
  readonly onTaskRefresh: () => Promise<PersistedTask>;
  readonly task: PersistedTask;
}

export function TaskToolExecutionPanel({
  canAccessWorkspace,
  client,
  onTaskRefresh,
  task,
}: TaskToolExecutionPanelProps) {
  const historyRepository = useMemo(
    () => new SupabaseToolExecutionHistoryRepository(client),
    [client],
  );
  const [toolId, setToolId] = useState(MVP_TOOL_UI_METADATA[0].id);
  const [inputText, setInputText] = useState(() =>
    JSON.stringify(MVP_TOOL_UI_METADATA[0].exampleInput, null, 2),
  );
  const [history, setHistory] = useState<ToolExecutionHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [inputError, setInputError] = useState('');
  const [executionMessage, setExecutionMessage] = useState('');
  const [executionError, setExecutionError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof executeTool>>['result'] | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ExecuteToolRequest | null>(null);
  const selectedTool = MVP_TOOL_UI_METADATA.find((tool) => tool.id === toolId) ??
    MVP_TOOL_UI_METADATA[0];
  const eligible = canAccessWorkspace && (
    task.workflow.task.status === 'Planning' || task.workflow.task.status === 'Running'
  );

  useEffect(() => {
    let active = true;
    void historyRepository
      .listTaskExecutions(task.workspaceId, task.id)
      .then((entries) => {
        if (active) setHistory(entries);
      })
      .catch(() => {
        if (active) setHistoryError('Execution history is temporarily unavailable.');
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [historyRefreshKey, historyRepository, task.id, task.workspaceId]);

  async function submitExecution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eligible || busy) return;

    let request = pendingRequest;
    if (!request) {
      let input: unknown;
      try {
        input = JSON.parse(inputText);
      } catch {
        setInputError('Enter valid JSON before running this tool.');
        return;
      }
      if (!isPersistableJson(input)) {
        setInputError('Input must be safe JSON within the supported size limits.');
        return;
      }
      request = {
        taskId: task.id,
        executionId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        toolId: selectedTool.id,
        toolVersion: selectedTool.version,
        input,
      };
      setPendingRequest(request);
    }

    setInputError('');
    setExecutionError('');
    setExecutionMessage('');
    setResult(null);
    setBusy(true);
    try {
      const response = await executeTool(client, request);
      setResult(response.result);
      if (response.result.success) {
        setExecutionMessage('Execution returned successfully. Refreshing saved workflow status…');
        setPendingRequest(null);
      } else {
        setExecutionError(readableExecutionError(response.result.error.code));
        if (response.result.error.code === 'EXECUTION_IN_PROGRESS') {
          setExecutionMessage('This request is still in progress. Retry only with the same request identity.');
        } else {
          setPendingRequest(null);
        }
      }
      try {
        const refreshedTask = await onTaskRefresh();
        if (response.result.success) {
          setExecutionMessage(
            `Execution returned successfully. Saved workflow status: ${refreshedTask.workflow.task.status}.`,
          );
        }
      } catch {
        setExecutionMessage((current) =>
          `${current} Saved workflow refresh is unavailable; the displayed task status may be stale.`,
        );
      }
    } catch (caught) {
      setExecutionError(readableAdapterError(caught));
      setExecutionMessage('The request identity is retained. Retry this same request to safely check its outcome.');
      try {
        await onTaskRefresh();
      } catch {
        setExecutionMessage((current) =>
          `${current} Saved workflow refresh is unavailable; the displayed task status may be stale.`,
        );
      }
    } finally {
      setBusy(false);
      setHistoryLoading(true);
      setHistoryError('');
      setHistoryRefreshKey((key) => key + 1);
    }
  }

  return (
    <>
      {eligible && (
        <section className="tool-executions" aria-labelledby="tool-executions-title">
          <header className="tool-executions__heading">
            <div>
              <p className="eyebrow">Registered tools</p>
              <h3 id="tool-executions-title">Tool execution</h3>
            </div>
            <span className="tool-executions__workflow">Workflow: {task.workflow.task.status}</span>
          </header>
        <form className="form-stack tool-execution-form" onSubmit={submitExecution}>
          <label>
            Tool
            <select
              disabled={busy || pendingRequest !== null}
              onChange={(event) => {
                const nextTool = MVP_TOOL_UI_METADATA.find((tool) => tool.id === event.target.value);
                if (!nextTool) return;
                setToolId(nextTool.id);
                setInputText(JSON.stringify(nextTool.exampleInput, null, 2));
                setInputError('');
                setExecutionError('');
                setResult(null);
                setExecutionMessage('');
              }}
              value={toolId}
            >
              {MVP_TOOL_UI_METADATA.map((tool) => (
                <option key={tool.id} value={tool.id}>{tool.name}</option>
              ))}
            </select>
          </label>
          <p className="tool-execution-form__description">
            {selectedTool.description} Version {selectedTool.version}.
          </p>
          <label>
            Input (JSON)
            <textarea
              aria-describedby="tool-example"
              disabled={busy || pendingRequest !== null}
              onChange={(event) => {
                setInputText(event.target.value);
                setInputError('');
              }}
              rows={7}
              spellCheck={false}
              value={inputText}
            />
          </label>
          <p className="tool-execution-form__example" id="tool-example">
            Example input: <code>{JSON.stringify(selectedTool.exampleInput)}</code>
          </p>
          {inputError && <p className="error-message" role="alert">{inputError}</p>}
          <button className="button" disabled={busy || pendingRequest !== null} type="submit">
            {busy ? 'Running…' : `Run ${selectedTool.name}`}
          </button>
          {pendingRequest && !busy && (
            <button className="button button--secondary" type="submit">
              Retry same request
            </button>
          )}
        </form>
        </section>
      )}

      {executionMessage && <p className="notice" role="status">{executionMessage}</p>}
      {executionError && <p className="error-message" role="alert">{executionError}</p>}
      {result?.success && (
        <section className="tool-execution-result" aria-label="Latest tool result">
          <h4>Latest result</h4>
          <pre>{JSON.stringify(result.output, null, 2)}</pre>
        </section>
      )}

      <section className="tool-execution-history" aria-labelledby="tool-history-title">
        <h4 id="tool-history-title">Saved execution history</h4>
        {historyLoading ? (
          <p role="status">Loading saved executions…</p>
        ) : historyError ? (
          <p className="error-message" role="alert">{historyError}</p>
        ) : history.length === 0 ? (
          <p>No tool executions have been saved for this task.</p>
        ) : (
          <ol className="tool-execution-history__list">
            {history.map((entry) => {
              const reviewFileId = invoiceReviewFileId(entry);
              return (
              <li key={entry.executionId}>
                <div className="tool-execution-history__item-heading">
                  <strong>{toolName(entry.toolId)} <span>v{entry.toolVersion}</span></strong>
                  <span className={`tool-execution-history__status tool-execution-history__status--${entry.status}`}>
                    {entry.status}
                  </span>
                </div>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
                {entry.completedAt && (
                  <p className="tool-execution-history__completed">
                    Finished {new Date(entry.completedAt).toLocaleString()}
                  </p>
                )}
                {entry.status === 'succeeded' && (
                  <pre>{JSON.stringify(entry.output, null, 2)}</pre>
                )}
                {reviewFileId && entry.output && (
                  <InvoiceExtractionFeedbackForm
                    client={client}
                    workspaceId={task.workspaceId}
                    taskId={task.id}
                    executionId={entry.executionId}
                    fileId={reviewFileId}
                    output={entry.output}
                  />
                )}
                {entry.status === 'failed' && entry.error && (
                  <p className="tool-execution-history__error">
                    {readableExecutionError(entry.error.code)}
                  </p>
                )}
                {entry.status === 'running' && (
                  <p className="tool-execution-history__pending">
                    This request has no saved final result. A retry must use its original request identity.
                  </p>
                )}
              </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}

function invoiceReviewFileId(entry: ToolExecutionHistoryEntry): string | null {
  if (entry.toolId !== 'invoice-document-extract' || entry.status !== 'succeeded' || !entry.output) {
    return null;
  }
  if (!isRecord(entry.input) || typeof entry.input.fileId !== 'string') return null;
  if (!isRecord(entry.output) || entry.output.fileId !== entry.input.fileId || !isRecord(entry.output.fields)) {
    return null;
  }
  const fields = entry.output.fields;
  const required = [
    'invoiceNumber', 'invoiceDate', 'vendor', 'description',
    'currency', 'subtotal', 'taxAmount', 'totalAmount',
  ];
  const valid = required.every((key) => {
    const field = fields[key];
    return isRecord(field) &&
      (typeof field.value === 'string' || typeof field.value === 'number' || field.value === null) &&
      typeof field.confidenceEstimate === 'number' &&
      Number.isFinite(field.confidenceEstimate) &&
      field.confidenceEstimate >= 0 &&
      field.confidenceEstimate <= 1;
  });
  return valid ? entry.input.fileId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toolName(toolId: string): string {
  return MVP_TOOL_UI_METADATA.find((tool) => tool.id === toolId)?.name ?? 'Registered tool';
}

function readableAdapterError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === 'The tool execution service returned an invalid response.'
  ) {
    return 'The service response could not be verified. The request may have completed; retry the same request to check safely.';
  }
  return 'Unable to confirm tool execution. Check your sign-in and workspace access, then retry the same request.';
}

function readableExecutionError(code: string): string {
  switch (code) {
    case 'EXECUTION_IN_PROGRESS':
      return 'This request is still in progress. It has not been reported as complete.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'This request identity conflicts with a previously saved request. No new request was started.';
    case 'PERMISSION_DENIED':
      return 'Workspace access is required to execute this tool.';
    case 'APPROVAL_REQUIRED':
      return 'A persisted workflow approval is required before this tool can run.';
    case 'INVALID_TOOL_INPUT':
      return 'The input does not match this tool’s requirements.';
    case 'EXECUTION_TIMEOUT':
      return 'The tool did not finish before the execution limit.';
    case 'EXECUTOR_UNAVAILABLE':
      return 'The execution service is temporarily unavailable.';
    case 'TOOL_NOT_FOUND':
      return 'This registered tool version is no longer available.';
    default:
      return 'The tool execution failed. Review the saved workflow and execution history.';
  }
}