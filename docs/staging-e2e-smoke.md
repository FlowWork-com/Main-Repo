# Authenticated staging smoke test

This is a manually triggered, staging-only GitHub Actions check. Run it from the main branch using Actions → Staging authenticated E2E smoke → Run workflow. The job uses the GitHub Actions environment named staging and is intentionally restricted to the Supabase project reference nhvmeahmwywhaxtnuehr.

## Required GitHub Actions environment secrets

Set these in Settings → Environments → staging → Environment secrets (repository Actions secrets also work if the environment does not override them):

- STAGING_SUPABASE_URL = https://nhvmeahmwywhaxtnuehr.supabase.co
- STAGING_SUPABASE_ANON_KEY = the project's public anon/publishable key
- STAGING_TEST_USER_EMAIL = the dedicated staging test user's email
- STAGING_TEST_USER_PASSWORD = the dedicated staging test user's password

Never add a service-role key, provider key, plan-signing key, password, or JWT to source control. The runner rejects any Supabase URL other than the exact staging project.

## Required server-side provider configuration

In Supabase → Edge Functions → Secrets, configure the planner, FinNLP reviewer, and invoice roles using the FLOWWORK_* variables documented in docs/ai-agent-roster.md. Configure FLOWWORK_PLAN_SIGNING_KEY there with the same privately generated value as the Vault secret flowwork-plan-signing-key. A valid public key alone is not enough to exercise the live planner.

### Optional Groq staging configuration

For an OpenAI API alternative, the planner and FinNLP review path can use Groq's OpenAI-compatible endpoint. Use the profile in `docs/ai-agent-roster.md` and configure the server-side `FLOWWORK_PLANNER_*` and `FLOWWORK_FINNLP_REVIEW_*` secrets in Supabase → Edge Functions → Secrets. Generate a **new** key if a previous key was pasted into chat or source control; never put a provider key in this document, workflow inputs, GitHub source, or client-side environment variables.

The current invoice extractor is not covered by the Groq staging profile because PDF payload compatibility has not been validated. Do not replace its secrets until a separate image/PDF adapter test passes.

## What this workflow checks

- Unauthenticated requests are rejected by all four required Edge Functions.
- The test user can authenticate and read only the expected staging workspace/task under RLS.
- The FinNLP integration status endpoint returns a workspace-scoped status without exposing provider credentials.
- The live planner creates a valid proposal for a fictional finance glossary exercise, the FinNLP reviewer performs its configured handoff, and the database stores the proposal with decision proposed.
- The database refuses to start a run while that proposal remains unaccepted.
- The worker endpoint denies a missing/unowned plan run.
- The test task remains in Planning and no tool executions are created.

The planner-side smoke sends one fictional financial-language goal through the planner, one FinNLP review, and one planner refinement, so it makes live provider requests and can incur API charges. Every run creates another proposed plan on the dedicated test task. The script never accepts a plan, starts a workflow run, or executes a tool.

## Deliberate coverage limits

This smoke does not upload or process an invoice file, approve a high-risk action, validate a real Finnhub company-news request, or trigger positive worker recovery. Those paths require a dedicated fixture, an explicit approval flow, and/or a safely seeded recoverable plan run. Do not bypass approval to make a smoke test pass.
