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

The browser requests tool execution only through the authenticated `execute-tool` Supabase Edge Function. Its payload contains the task, execution, and request IDs, tool ID/version, and JSON input; it cannot supply an actor, workspace, approval, or result. The function verifies the Supabase Auth token, resolves the task and workspace from database records under the caller JWT, and checks membership before invoking the shared backend execution service.

The versioned allow-list and canonical implementations remain in `src/tools`: `echo`, `text-transform`, `json-inspect`, and `file-metadata`. Tool input is validated before claiming; `file-metadata` reads only metadata registered to the task. No client-supplied code or tool definition is executed. The browser adapter in `src/backend/toolExecutionClient.ts` only invokes the Edge Function with the public authenticated Supabase client; it does not import or instantiate the executor.

The Edge Function uses two clients: the caller's verified JWT for task/workflow reads and workflow-domain event persistence, and a service-role client held only in the function runtime for execution-record RPCs and task-file metadata reads. A forward-only migration revokes authenticated access to the claim/finalization RPCs and grants it only to `service_role`. Those `SECURITY DEFINER` functions take an explicit actor ID from the verified Edge Function and independently validate actor membership, task/workspace linkage, Running status for new claims/finalization, and execution ownership. They preserve identity uniqueness, safe identical-result replay, and rejection of conflicting results. Input/output size limits and credential checks remain enforced by application and database boundaries. RLS still permits workspace members to read execution history but not mutate it.

Successful execution moves a Running workflow to Verifying through the existing workflow domain and authenticated persistence RPC. Execution output and evidence are not verification: only the existing independent verification command may complete the task. High-risk tools require an approval recorded in both workflow history and persisted approval records; the workflow self-approval protection remains in force.

## Environment variables

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project API URL |
| `VITE_SUPABASE_ANON_KEY` | Public Supabase anon/publishable key; protected by RLS |
| `SUPABASE_URL` | Supabase project URL available to the Edge Function |
| `SUPABASE_ANON_KEY` | Public key available to the Edge Function for caller-scoped requests |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged key used only inside the Edge Function runtime; never add a `VITE_` prefix |
| `APP_ORIGINS` | Comma-separated exact browser origins allowed by the Edge Function; local defaults are `http://localhost:5173,http://127.0.0.1:5173` |

Authentication is required. The app fails with a setup message when either `VITE_` value is missing and never falls back to an unauthenticated or privileged database client. Configure the Edge Function's `SUPABASE_SERVICE_ROLE_KEY` and `APP_ORIGINS` as Supabase secrets for hosted deployments. Never place the service-role key in frontend environment files or logs.

For local execution, start Supabase, apply migrations, and serve the function using a local ignored env file containing the four `SUPABASE_*`/`APP_ORIGINS` values above:

```sh
npx supabase db reset
npx supabase functions serve execute-tool --env-file supabase/functions/.env
```

The browser app continues to use the local URL and anon key in `.env.local`; the local function env file is server-only and must not be committed. Configure `APP_ORIGINS` to the exact origin(s) used by the browser.

Run the Edge Function's executable request/auth/authorization tests and type-check with:

```sh
deno check --unstable-sloppy-imports supabase/functions/execute-tool/index.ts
deno test --unstable-sloppy-imports supabase/functions/execute-tool/handler_test.ts
```

The existing `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npx supabase db lint --local`, and `npx supabase test db` remain enabled in CI. The database tests cover role privileges and actor/task ownership independently of `auth.uid()`.

This phase remains infrastructure only: no AI orchestration, autonomous agents, external production integrations, browser automation, arbitrary shell/code/network/filesystem/database access, background workers, or separate workflow state machine. Edge execution is request-bound; a process interruption after an execution is claimed can leave it `running`, and retries safely report in-progress rather than risk executing an operation twice. There is no queue or automated recovery worker yet. Execution is bounded by the tool timeout and the Edge Function platform's request limits.
