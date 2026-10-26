# Recover the current local Supabase stack

## What the old startup output meant

The output showing only these migrations—

- `20261008000000_durable_workflow_core`
- `20261008010000_prevent_approval_self_approval`
- `20261008020000_tool_execution_layer`
- `20261009000000_server_side_tool_execution`
- `20261013000000_persist_workflow_plans`

—matches the tracked migration set on the stale `Supabase-temp-branch`. That branch is 428 commits behind `main`. Do not merge it into `main` or use its checkout for integration.

The current `main` branch owns the canonical Supabase setup: 20 migrations, five Edge Functions, and the database/RLS test suite. Local and hosted configuration must be brought forward from `main`, not reconstructed from an old terminal transcript.

## Safely switch to the canonical checkout

Run these from the local `Main-Repo` directory. First review or commit/stash any local code changes before switching branches.

```sh
git status --short
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse --short HEAD
```

Confirm the current branch is `main` and the working tree does not contain unreviewed changes.

## Recreate the local database from current migrations

The reset below **deletes local Supabase database data** and rebuilds the local schema from the checked-out migrations. Export any local-only data first if it matters. It does not require or use a hosted project, and you must not add `--linked`.

```sh
supabase stop
supabase start
supabase db reset
supabase migration list --local
supabase status
```

After reset, compare the local migration list with the 20 migration files in `supabase/migrations`; all current migrations should be applied locally. If the CLI reports an error, stop and inspect it rather than trying a remote migration repair.

The local URLs should point at loopback addresses (for example, `http://127.0.0.1:54321` for the API and `http://127.0.0.1:54323` for Studio). These addresses are for the machine running the stack; they are not hosted deployment URLs.

## Handling local keys and environment values

Supabase generates local development keys. Keep them local and out of commits, screenshots, logs, and chat. The repository ignores `.env` and `.env.*` files while explicitly allowing `.env.example`. Never put a service-role/secret key in a `VITE_*` variable.

If you need to use local values in your frontend, set only the public local project URL and public/publishable key in your private local environment file. Keep provider API keys and Supabase service-role credentials on the server side. Do not use a local URL or key when configuring hosted staging.

## Missing seed warning

There is intentionally no production-like seed data. The tracked `supabase/seed.sql` is a no-op file to make that choice explicit and avoid treating the absence of seed data as a failed setup. Use synthetic fixtures in the existing tests for test data.
