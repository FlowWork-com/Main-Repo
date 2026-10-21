# Lovable frontend integration plan

## Source of truth

`FlowWork-com/Main-Repo` remains the canonical repository for workflow lifecycle rules, task/workspace persistence, plan validation, tool execution, approvals, and verification.

The Lovable project is available in `FlowWork-com/flowowork`. It is a TanStack Start application with server functions and its own Drizzle/Supabase schema; it is not a drop-in set of React components for this repository's React + Vite app. Its current Supabase project configuration is separate from Main-Repo's local project. Do not copy its `.env`, `supabase/config.toml`, or migrations into Main-Repo without an explicit schema and environment migration plan.

## Phase 1 — request-first home experience

This phase ports the central interaction pattern into the existing Vite frontend while keeping the existing backend authoritative:

- The home page asks, "What do you need done?"
- The request composer saves a task in the existing Planning state.
- The first non-empty line becomes the short task title; the full request is saved as task details and used as the default planning goal.
- Existing plan review, tool execution, workflow timeline, approval, and verification components stay in place.
- The interface explicitly says that creating a workflow does not execute actions automatically.

No new external integrations or execution behavior are introduced by this phase.

## Not migrated in Phase 1

The following parts of the Lovable app depend on its own TanStack Start server functions, database tables, storage rules, OAuth credential handling, or Drizzle migrations, so they must not be copied as disconnected UI:

- File upload and attachment processing.
- Invoice parsing and spreadsheet preparation/export.
- Google Drive, Google Sheets, and Gmail OAuth connections and workflows.
- Saved prompt templates and the richer history/detail routes.

## Follow-up phases

1. Rework task history and task details around Main-Repo's persisted workflow model.
2. Add private task-file upload/download with storage authorization and RLS.
3. Plan any invoice/spreadsheet or Google integration migration separately: identify the required data model, server-side secret storage, OAuth callback lifecycle, approval requirements, recovery/idempotency behavior, and test coverage before porting routes or migrations.
4. Keep real provider credentials server-side and keep tool execution behind existing authorization and approval controls.

Every phase should land through a small feature branch and PR, with typecheck, lint, tests, build, and the relevant database/function checks before merge.
