# FlowWork

FlowWork is a B2B workflow automation platform. The application currently provides a durable, user-scoped workflow lifecycle: create tasks in Planning, record allowed status changes, approvals, verification evidence, and reload the saved task history.

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

The framework-independent `src/workflow` module remains the workflow transition/business-rule authority. The persistence adapter maps its aggregates and commands to Supabase storage; the database provides authorization, immutable workspace linkage, sequence/concurrency checks, and atomic writes. This release does not execute tools, invoke AI models, or connect external integrations.

## Environment variables

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project API URL |
| `VITE_SUPABASE_ANON_KEY` | Public Supabase anon/publishable key; protected by RLS |

Authentication is required. The app fails with a setup message when either variable is missing and never falls back to an unauthenticated or privileged database client.
