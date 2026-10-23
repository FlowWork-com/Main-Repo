import { useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PromptTemplate {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly currentVersion: number;
  readonly promptText: string;
  readonly updatedAt: string;
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly current_version: number;
  readonly updated_at: string;
}

interface TemplateVersionRow {
  readonly template_id: string;
  readonly version: number;
  readonly prompt_text: string;
}

interface PromptTemplatesPanelProps {
  readonly canAccessWorkspace: boolean;
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly onUseTemplate: (promptText: string) => void;
}

export function PromptTemplatesPanel({
  canAccessWorkspace,
  client,
  workspaceId,
  onUseTemplate,
}: PromptTemplatesPanelProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [promptText, setPromptText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    async function loadTemplates() {
      setLoading(true);
      setError('');
      try {
        if (!canAccessWorkspace) {
          if (active) setTemplates([]);
          return;
        }
        const { data: rows, error: rowError } = await client
          .from('workspace_prompt_templates')
          .select('id, name, category, current_version, updated_at')
          .eq('workspace_id', workspaceId)
          .is('archived_at', null)
          .order('updated_at', { ascending: false })
          .limit(100);
        if (rowError) throw rowError;

        const templateRows = (rows ?? []) as TemplateRow[];
        if (!templateRows.length) {
          if (active) setTemplates([]);
          return;
        }
        const { data: versionRows, error: versionError } = await client
          .from('workspace_prompt_template_versions')
          .select('template_id, version, prompt_text')
          .eq('workspace_id', workspaceId)
          .order('version', { ascending: false })
          .limit(2000);
        if (versionError) throw versionError;

        const versions = (versionRows ?? []) as TemplateVersionRow[];
        const mapped = templateRows.map((row): PromptTemplate => {
          const version = versions.find((item) =>
            item.template_id === row.id && item.version === row.current_version
          );
          if (!version || typeof version.prompt_text !== 'string') {
            throw new Error('The saved prompt version is unavailable.');
          }
          return {
            id: row.id,
            name: row.name,
            category: row.category,
            currentVersion: row.current_version,
            promptText: version.prompt_text,
            updatedAt: row.updated_at,
          };
        });
        if (active) setTemplates(mapped);
      } catch {
        if (active) setError('Unable to load saved prompt templates. Check workspace access and retry.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadTemplates();
    return () => {
      active = false;
    };
  }, [canAccessWorkspace, client, refreshKey, workspaceId]);

  function resetForm() {
    setEditingTemplateId(null);
    setIsCreating(false);
    setName('');
    setCategory('');
    setPromptText('');
  }

  function startCreate() {
    setError('');
    setNotice('');
    setEditingTemplateId(null);
    setIsCreating(true);
    setName('');
    setCategory('');
    setPromptText('');
  }

  function startEdit(template: PromptTemplate) {
    setError('');
    setNotice('');
    setIsCreating(false);
    setEditingTemplateId(template.id);
    setName(template.name);
    setCategory(template.category ?? '');
    setPromptText(template.promptText);
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAccessWorkspace || busy) return;
    const nextName = name.trim();
    const nextPrompt = promptText.trim();
    const current = templates.find((template) => template.id === editingTemplateId);
    if (!nextName || nextName.length > 120) {
      setError('Enter a template name between 1 and 120 characters.');
      return;
    }
    if (nextPrompt.length < 3 || nextPrompt.length > 4000) {
      setError('Prompt text must contain between 3 and 4,000 characters.');
      return;
    }
    if (editingTemplateId && !current) {
      setError('This prompt template is no longer available. Reload the list and try again.');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await client.rpc('save_workspace_prompt_template', {
        p_workspace_id: workspaceId,
        p_template_id: current?.id ?? null,
        p_expected_version: current?.currentVersion ?? null,
        p_name: nextName,
        p_category: category.trim() || null,
        p_prompt_text: nextPrompt,
      });
      if (saveError) {
        setError(saveError.code === '40001'
          ? 'This template changed elsewhere. Reload it before saving your edits.'
          : 'Unable to save this prompt template. Check its contents and workspace access.');
        return;
      }
      setNotice(current ? 'A new prompt template version was saved.' : 'Prompt template saved.');
      resetForm();
      setRefreshKey((key) => key + 1);
    } catch {
      setError('Unable to confirm that the prompt template was saved. Reload the list before retrying.');
    } finally {
      setBusy(false);
    }
  }

  async function archiveTemplate(template: PromptTemplate) {
    if (!canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: archiveError } = await client.rpc('archive_workspace_prompt_template', {
        p_workspace_id: workspaceId,
        p_template_id: template.id,
        p_expected_version: template.currentVersion,
      });
      if (archiveError) {
        setError(archiveError.code === '40001'
          ? 'This template changed elsewhere. Reload it before archiving.'
          : 'Unable to archive this prompt template.');
        return;
      }
      if (editingTemplateId === template.id) resetForm();
      setNotice('Prompt template archived.');
      setRefreshKey((key) => key + 1);
    } catch {
      setError('Unable to confirm that the prompt template was archived. Reload the list before retrying.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="prompt-templates panel" aria-labelledby="prompt-templates-title">
      <header className="prompt-templates__heading">
        <div>
          <p className="eyebrow">Reusable instructions</p>
          <h3 id="prompt-templates-title">Saved prompt templates</h3>
        </div>
        {canAccessWorkspace && !isCreating && !editingTemplateId && (
          <button className="button button--secondary" disabled={busy} onClick={startCreate} type="button">
            New template
          </button>
        )}
      </header>
      <p className="prompt-templates__description">
        Save common instructions for repeated work. Templates are private to this workspace and each edit creates a new version.
      </p>

      {error && <p className="error-message" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading saved templates…</p>
      ) : templates.length === 0 ? (
        <p className="prompt-templates__empty">No prompt templates saved yet.</p>
      ) : (
        <ul className="prompt-templates__list">
          {templates.map((template) => (
            <li className="prompt-templates__item" key={template.id}>
              <div className="prompt-templates__item-main">
                <strong>{template.name}</strong>
                <span>
                  {template.category ? `${template.category} · ` : ''}Version {template.currentVersion}
                </span>
                <p>{template.promptText}</p>
              </div>
              <div className="prompt-templates__actions">
                {canAccessWorkspace && (
                  <>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => {
                        onUseTemplate(template.promptText);
                        setNotice(`Loaded “${template.name}” into the request composer. Review it before creating the workflow.`);
                        setError('');
                      }}
                      type="button"
                    >
                      Use
                    </button>
                    <button className="button button--quiet" disabled={busy} onClick={() => startEdit(template)} type="button">
                      Edit
                    </button>
                    <button className="button button--quiet" disabled={busy} onClick={() => void archiveTemplate(template)} type="button">
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canAccessWorkspace && (isCreating || editingTemplateId) && (
        <form className="form-stack prompt-templates__editor" onSubmit={saveTemplate}>
          <h4>{editingTemplateId ? 'Create a new version' : 'New prompt template'}</h4>
          <label>
            Template name
            <input
              autoComplete="off"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            Category <span className="optional-label">Optional</span>
            <input
              autoComplete="off"
              maxLength={80}
              onChange={(event) => setCategory(event.target.value)}
              value={category}
            />
          </label>
          <label>
            Prompt text
            <textarea
              maxLength={4000}
              onChange={(event) => setPromptText(event.target.value)}
              required
              rows={5}
              value={promptText}
            />
          </label>
          <p className="prompt-templates__description">
            Templates do not run by themselves. Using one only fills the request composer.
          </p>
          <div className="task-actions">
            <button className="button" disabled={busy || name.trim().length < 1 || promptText.trim().length < 3} type="submit">
              {busy ? 'Saving…' : editingTemplateId ? 'Save new version' : 'Save template'}
            </button>
            <button className="button button--quiet" disabled={busy} onClick={resetForm} type="button">
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
