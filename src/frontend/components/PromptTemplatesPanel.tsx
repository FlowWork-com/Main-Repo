import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PromptTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly current_version: number;
  readonly updated_at: string;
}

interface PromptTemplateVersion {
  readonly version: number;
  readonly name: string;
  readonly prompt: string;
  readonly change_kind: 'created' | 'updated' | 'archived';
  readonly created_at: string;
}

interface PromptTemplatesPanelProps {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly onUseTemplate: (prompt: string) => void;
}

export function PromptTemplatesPanel({
  client,
  workspaceId,
  onUseTemplate,
}: PromptTemplatesPanelProps) {
  const [templates, setTemplates] = useState<PromptTemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [editing, setEditing] = useState<PromptTemplateRecord | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptTemplateVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await client
        .from('workflow_prompt_templates')
        .select('id, name, prompt, current_version, updated_at')
        .eq('workspace_id', workspaceId)
        .is('archived_at', null)
        .order('updated_at', { ascending: false });
      if (queryError) throw queryError;
      setTemplates(Array.isArray(data) ? data as PromptTemplateRecord[] : []);
    } catch {
      setError('Unable to load saved prompts. Check workspace access and retry.');
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  function resetEditor() {
    setEditing(null);
    setName('');
    setPrompt('');
    setError('');
  }

  function beginEdit(template: PromptTemplateRecord) {
    setEditing(template);
    setName(template.name);
    setPrompt(template.prompt);
    setError('');
    setHistoryFor(null);
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const cleanPrompt = prompt.trim();
    if (cleanName.length < 1 || cleanName.length > 80) {
      setError('Give this prompt a name between 1 and 80 characters.');
      return;
    }
    if (cleanPrompt.length < 3 || cleanPrompt.length > 2000) {
      setError('Prompt text must be between 3 and 2,000 characters.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { error: saveError } = await client.rpc('save_workflow_prompt_template', {
        p_workspace_id: workspaceId,
        p_template_id: editing?.id ?? null,
        p_name: cleanName,
        p_prompt: cleanPrompt,
        p_expected_version: editing?.current_version ?? null,
      });
      if (saveError) {
        setError(saveError.code === '40001'
          ? 'This prompt changed in another session. Reload the list and review the latest version before saving.'
          : 'Unable to save this prompt. Check workspace access and retry.');
        return;
      }
      resetEditor();
      await loadTemplates();
    } catch {
      setError('Unable to confirm that this prompt was saved. Reload the list before retrying.');
    } finally {
      setBusy(false);
    }
  }

  async function archiveTemplate(template: PromptTemplateRecord) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { error: archiveError } = await client.rpc('archive_workflow_prompt_template', {
        p_workspace_id: workspaceId,
        p_template_id: template.id,
        p_expected_version: template.current_version,
      });
      if (archiveError) {
        setError(archiveError.code === '40001'
          ? 'This prompt changed in another session. Reload the list before archiving.'
          : 'Unable to archive this prompt. Check workspace access and retry.');
        return;
      }
      if (editing?.id === template.id) resetEditor();
      if (historyFor === template.id) setHistoryFor(null);
      await loadTemplates();
    } catch {
      setError('Unable to confirm that this prompt was archived. Reload the list before retrying.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory(template: PromptTemplateRecord) {
    if (historyFor === template.id) {
      setHistoryFor(null);
      setVersions([]);
      return;
    }
    setHistoryFor(template.id);
    setHistoryLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await client
        .from('workflow_prompt_template_versions')
        .select('version, name, prompt, change_kind, created_at')
        .eq('workspace_id', workspaceId)
        .eq('template_id', template.id)
        .order('version', { ascending: false })
        .limit(10);
      if (queryError) throw queryError;
      setVersions(Array.isArray(data) ? data as PromptTemplateVersion[] : []);
    } catch {
      setError('Unable to load this prompt history. Check workspace access and retry.');
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <section className="prompt-templates" aria-labelledby="prompt-templates-title">
      <header className="workspace__heading">
        <div>
          <p className="eyebrow">Reusable instructions</p>
          <h2 id="prompt-templates-title">Prompt templates</h2>
        </div>
        <span className="preview-badge preview-badge--subtle">{templates.length} saved</span>
      </header>
      <p className="workspace-note">
        Save common requests once and reuse them when creating a workflow. Templates are private to this workspace; each edit creates a version.
      </p>

      <section className="panel prompt-template-editor" aria-labelledby="prompt-template-editor-title">
        <h3 id="prompt-template-editor-title">{editing ? 'Edit prompt template' : 'New prompt template'}</h3>
        <form className="form-stack" onSubmit={saveTemplate}>
          <label>
            Template name
            <input
              autoComplete="off"
              disabled={busy}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            Prompt text
            <textarea
              disabled={busy}
              maxLength={2000}
              onChange={(event) => setPrompt(event.target.value)}
              required
              rows={4}
              value={prompt}
            />
          </label>
          <div className="prompt-template-editor__actions">
            <button className="button" disabled={busy || name.trim().length === 0 || prompt.trim().length < 3} type="submit">
              {busy ? 'Saving…' : editing ? 'Save new version' : 'Save template'}
            </button>
            {editing && (
              <button className="button button--quiet" disabled={busy} onClick={resetEditor} type="button">
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </section>

      {error && <p className="error-message" role="alert">{error}</p>}
      <section className="prompt-template-list" aria-label="Saved prompt templates">
        <h3>Saved templates</h3>
        {loading ? (
          <p role="status">Loading saved prompts…</p>
        ) : templates.length === 0 ? (
          <section className="panel empty-state">
            <h4>No saved prompts yet</h4>
            <p>Save a repeatable instruction above to use it for future workflows.</p>
          </section>
        ) : (
          templates.map((template) => (
            <article className="panel prompt-template-item" key={template.id}>
              <header className="prompt-template-item__heading">
                <div>
                  <h4>{template.name}</h4>
                  <p>Version {template.current_version} · Updated {new Date(template.updated_at).toLocaleString()}</p>
                </div>
              </header>
              <p className="prompt-template-item__prompt">{template.prompt}</p>
              <div className="prompt-template-item__actions">
                <button className="button" disabled={busy} onClick={() => onUseTemplate(template.prompt)} type="button">
                  Use template
                </button>
                <button className="button button--secondary" disabled={busy} onClick={() => beginEdit(template)} type="button">
                  Edit
                </button>
                <button className="button button--quiet" disabled={busy} onClick={() => void toggleHistory(template)} type="button">
                  {historyFor === template.id ? 'Hide versions' : 'Version history'}
                </button>
                <button className="button button--danger" disabled={busy} onClick={() => void archiveTemplate(template)} type="button">
                  Archive
                </button>
              </div>
              {historyFor === template.id && (
                <div className="prompt-template-versions" aria-label={`Version history for ${template.name}`}>
                  {historyLoading ? (
                    <p role="status">Loading version history…</p>
                  ) : versions.length === 0 ? (
                    <p>No versions are available.</p>
                  ) : versions.map((version) => (
                    <article className="prompt-template-version" key={version.version}>
                      <div>
                        <strong>Version {version.version} · {version.change_kind}</strong>
                        <p>{new Date(version.created_at).toLocaleString()}</p>
                      </div>
                      <p className="prompt-template-item__prompt">{version.prompt}</p>
                      <button className="button button--quiet" disabled={busy} onClick={() => onUseTemplate(version.prompt)} type="button">
                        Use this version
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}
