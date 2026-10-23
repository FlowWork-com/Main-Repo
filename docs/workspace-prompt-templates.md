# Workspace prompt templates

## Purpose

Prompt templates let a workspace reuse stable instructions for recurring tasks without turning them into executable automations by themselves.

## User flow

- A workspace member creates a template with a name, optional category, and prompt text.
- Choosing **Use** copies the prompt into the ordinary workflow request composer. The member can review and edit it before creating a task.
- Editing a template saves an immutable new version rather than replacing the prior prompt.
- Archiving hides a template from the active list but retains version history.

## Persistence and access

- `workspace_prompt_templates` stores the workspace-scoped template identity, name/category, current version, audit actor, timestamps, and archive time.
- `workspace_prompt_template_versions` stores immutable prompt text for every saved version.
- Authenticated clients have read access through workspace-membership RLS, but no direct insert/update/delete privileges on either table.
- Create/update and archive operations use security-definer RPCs that independently verify the authenticated user is a workspace member.
- Updates include an expected version. A stale update or archive returns a conflict instead of overwriting a concurrent edit.
- Template text is length-bounded and rejected if it matches the existing credential-like data checks.
- Templates are not run automatically; using a template only fills the request composer. Normal plan review and workflow approval rules remain unchanged.

## Intentional limitations

- This phase has no public template gallery, cross-workspace sharing, import/export, or automatic prompt execution.
- Archived template history is retained to preserve auditability.
- Version history and correction-quality data are separate; prompt templates do not assert that a particular prompt is more accurate without evaluation evidence.
