# FlowWork

FlowWork is a B2B workflow automation platform. The application currently provides a durable, workspace-scoped workflow lifecycle: create tasks in Planning, record allowed status changes, approvals, verification evidence, and reload the saved task history.

## Requirements

- Node.js 22.22.2+ or 24.15+
- npm 10+

## Local development

```sh
npm ci
npx supabase start
npx supabase status
npm run dev
```

Copy `.env.example` to `.env.local` and set the local Supabase API URL and anon key printed by `supabase status`. Email sign-in links are delivered to the local Supabase mail viewer. To apply/reset migrations and run the database authorization tests, use:

```sh
npx supabase db reset
npx supabase test db
```

The local Supabase CLI requires Docker. Supabase Auth email confirmation is enabled in the local configuration.

For a hosted Supabase project, apply migrations with `npx supabase db push` after linking the project, and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the frontend environment. The frontend uses only the project URL and public anon key; never set a service-role key in a `VITE_` variable or expose it to a browser.

## Quality checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` runs all four checks in sequence. The production bundle is written to `dist/`.

## Current scope

Workspace membership and task access are enforced by PostgreSQL row-level security. Authenticated users can read only workspaces where they are members; workspace creation and task/event/approval writes use constrained, transactional database functions. Task history, approval records, verification evidence references, and workflow steps are persisted. The UI's verification action records an explicit user-supplied evidence reference; it does not independently validate the referenced evidence or execute an external action.

The framework-independent `src/workflow` module remains the workflow transition/business-rule authority. The persistence adapter maps its aggregates and commands to Supabase storage; the database provides authorization, immutable workspace linkage, sequence/concurrency checks, and atomic writes.

### Tool execution infrastructure

The framework-independent `src/tools` module defines versioned tool contracts, immutable registry metadata, input validation, a timeout-bounded executor, and the deterministic MVP tools: `echo`, `text-transform`, `json-inspect`, and `file-metadata`. Each execution receives an authenticated user, workspace, task, execution, tool/version, and request identity. The backend service checks that context, workspace authorization, and any workflow approval requirement before execution.

`file-metadata` queries only metadata registered to the current task; it never reads a filesystem path or file contents. Successful tool outputs and optional evidence remain separate from verification: the workflow moves from Running to Verifying, and only the existing workflow verification command can record verification evidence and complete the task.

`task_tool_executions` stores execution inputs, outputs, failures, and evidence with task/workspace linkage and per-task execution/request idempotency constraints. Workspace members have read-only history access through RLS. Authenticated writes go through constrained `claim_task_tool_execution` and `finish_task_tool_execution` functions, which verify the current user, membership, task association, and workflow execution state. Browser code uses the existing public Supabase client; it does not receive a service-role key or any tool-specific credentials. Inputs, outputs, and evidence are size-limited, and credential-like field names and common credential formats are rejected in both the application and database RPC boundary; credentials must not be passed as ordinary tool input.

This phase is infrastructure only. FlowWork does not yet contain AI orchestration, autonomous agents, external production integrations, browser automation, arbitrary shell/code execution, unrestricted filesystem/network/database tools, or an independent workflow state machine. Existing workflow domain rules and approval protections remain authoritative.

## Environment variables

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project API URL |
| `VITE_SUPABASE_ANON_KEY` | Public Supabase anon/publishable key; protected by RLS |

Authentication is required. The app fails with a setup message when either variable is missing and never falls back to an unauthenticated or privileged database client.
