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

### Run the containerized frontend

Copy `.env.example` to `.env` and set the local Supabase URL and public anon key printed by `npx supabase status`. Then build and start the frontend container:

```sh
cp .env.example .env
# Edit .env with the local Supabase values.
docker compose up --build -d
docker compose ps
```

Open `http://localhost:8080`. Compose builds a multi-stage Node/Nginx image, serves SPA routes through the Nginx fallback, and reports container health at `/health`. The `VITE_SUPABASE_*` values are public frontend configuration and are embedded in the static bundle; never put service-role or provider secrets in `.env` or build arguments. `.env` is ignored by Git.

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

### Planning foundation

The `src/planning` module defines a provider-agnostic planning contract and validation logic. It accepts a goal and the canonical tool catalog, validates the returned plan against the registered tools and safe JSON rules, and rejects plans containing unknown tool IDs, duplicate step IDs, cyclic dependencies, unsafe credential-like values, or unsupported capabilities. A planner request can only be generated through a configured server-side adapter; when no provider is configured, the module responds with a sanitized `PLANNER_NOT_CONFIGURED` error instead of inventing a plan.

The `plan-workflow` Edge Function invokes a configured OpenAI-compatible chat-completions endpoint using structured JSON mode. Set `FLOWWORK_PLANNER_PROVIDER=openai-compatible`, `FLOWWORK_PLANNER_BASE_URL`, `FLOWWORK_PLANNER_MODEL`, and the server-side secret `FLOWWORK_PLANNER_API_KEY`. For OpenAI, use `https://api.openai.com/v1`; hosted endpoints must use HTTPS. HTTP is accepted only for loopback local development. Missing or invalid configuration returns `PLANNER_NOT_CONFIGURED`; there is no hard-coded provider or model fallback. The deterministic `mock` adapter is disabled unless `FLOWWORK_PLANNER_ALLOW_MOCK=true` is explicitly set in a local test/development function environment. Never enable mock mode for production or represent its output as a genuine provider result.

Proposals are validated again against the canonical tool registry on the server, then stored as versioned `proposed` plan records. Members may accept or reject a persisted version. Acceptance records a planning decision only: it does not execute tools, change workflow status, or constitute verification. Execution and verification remain separate workflow stages and are not part of this phase. Plans and decisions reload from Supabase after refresh; browser storage is not authoritative.

### Tool execution infrastructure

The browser requests tool execution only through the authenticated `execute-tool` Supabase Edge Function. Its payload contains the task, execution, and request IDs, tool ID/version, and JSON input; it cannot supply an actor, workspace, approval, or result. The function verifies the Supabase Auth token, resolves the task and workspace from database records under the caller JWT, and checks membership before invoking the shared backend execution service.

The versioned allow-list and canonical implementations remain in `src/tools`: `echo`, `text-transform`, `json-inspect`, and `file-metadata`. Tool input is validated before claiming; `file-metadata` reads only metadata registered to the task. No client-supplied code or tool definition is executed. The browser adapter in `src/backend/toolExecutionClient.ts` only invokes the Edge Function with the public authenticated Supabase client; it does not import or instantiate the executor.

In an authenticated workspace, select a task in Planning or Running to choose one of these registered tools, review its description and example, edit the JSON input, and explicitly run it. Successful execution moves the saved workflow to Verifying; tool execution does not complete verification. The task detail shows the saved result and read-only execution history, including status, tool version, and available timestamps. Invalid JSON is rejected before a request is sent. If the Edge Function response is ambiguous, retry the same request so the original execution and request IDs are reused; a request left running after interruption is shown as in progress rather than reported as successful.

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
| `FLOWWORK_PLANNER_PROVIDER` | `openai-compatible` for a genuine configured provider; `mock` only with the explicit development gate |
| `FLOWWORK_PLANNER_BASE_URL` | OpenAI-compatible API base URL, for example `https://api.openai.com/v1` |
| `FLOWWORK_PLANNER_MODEL` | Explicit model identifier supported by the configured API |
| `FLOWWORK_PLANNER_API_KEY` | Provider credential stored only as a Supabase Edge Function secret |
| `FLOWWORK_PLAN_SIGNING_KEY` | Random signing secret, at least 32 characters, configured both as an Edge Function secret and in Supabase Vault under `flowwork-plan-signing-key` |
| `FLOWWORK_PLANNER_ALLOW_MOCK` | Set to `true` only in local test/development to enable deterministic mock output |

Authentication is required. The app fails with a setup message when either `VITE_` value is missing and never falls back to an unauthenticated or privileged database client. Configure the Edge Function's `SUPABASE_SERVICE_ROLE_KEY` and `APP_ORIGINS` as Supabase secrets for hosted deployments. Never place the service-role key in frontend environment files or logs.

For local testing, start Supabase and apply migrations. Put function settings in an ignored, server-only `supabase/functions/.env` file; do not put provider secrets in `.env.local` or any `VITE_` variable. Use the real provider values for end-to-end model generation, or explicitly enable the mock only for UI plumbing tests. Serve the planning and execution functions separately:

```sh
npx supabase db reset
npx supabase functions serve plan-workflow --env-file supabase/functions/.env
```

In a second terminal, the execution endpoint remains separate and unused by plan acceptance:

```sh
npx supabase functions serve execute-tool --env-file supabase/functions/.env
```

The browser app continues to use the local URL and anon key in `.env.local`; the local function env file is server-only and must not be committed. Configure `APP_ORIGINS` to the exact origin(s) used by the browser. For hosted deployment, set `FLOWWORK_PLANNER_*`, `FLOWWORK_PLAN_SIGNING_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `APP_ORIGINS` as Edge Function secrets. Store the same random signing key in Vault under `flowwork-plan-signing-key` using the Supabase SQL editor or an administrator connection:

```sql
select vault.create_secret('<same-random-signing-key>', 'flowwork-plan-signing-key');
```

The signing secret prevents browser callers from forging planner proposals. Do not configure or expose a service-role key for planning; task reads, plan writes, and decisions use the verified caller JWT and user-scoped client.

For local runs, add the signing key and function settings to `supabase/functions/.env`, run `npx supabase db reset`, then execute the `vault.create_secret` statement above against the local database before serving the function. A local mock setup needs `FLOWWORK_PLANNER_PROVIDER=mock` and `FLOWWORK_PLANNER_ALLOW_MOCK=true`; real model tests need all four `FLOWWORK_PLANNER_*` provider settings instead. The frontend sends only `{ taskId, goal }` to the authenticated Edge Function.

Run the Edge Function's executable request/auth/authorization tests and type-check with:

```sh
deno check --unstable-sloppy-imports supabase/functions/execute-tool/index.ts
deno test --unstable-sloppy-imports supabase/functions/execute-tool/handler_test.ts
deno check --unstable-sloppy-imports supabase/functions/plan-workflow/index.ts
deno test --unstable-sloppy-imports supabase/functions/plan-workflow/handler_test.ts
```

The existing `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npx supabase db lint --local`, and `npx supabase test db` remain enabled in CI. The database tests cover role privileges and actor/task ownership independently of `auth.uid()`.

This phase remains infrastructure only: no AI orchestration, autonomous agents, external production integrations, browser automation, arbitrary shell/code/network/filesystem/database access, background workers, or separate workflow state machine. Edge execution is request-bound; a process interruption after an execution is claimed can leave it `running`, and retries safely report in-progress rather than risk executing an operation twice. There is no queue or automated recovery worker yet. Execution is bounded by the tool timeout and the Edge Function platform's request limits.
