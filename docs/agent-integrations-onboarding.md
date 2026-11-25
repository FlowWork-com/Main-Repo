# AI agent onboarding and integration

**Status:** staged integration work; not a production runtime-agent expansion.  
**Principle:** preserve the current runtime roles and keep application-owned authorization, approval, deterministic calculation, and execution controls outside model authority.

## 1. What this stage adds

This feature branch adds a manually triggered GitHub Actions workflow named **Manual AI-assisted PR review**. It runs an independent review of an open pull request against main using Groq, Claude, DeepSeek, or both, and publishes an advisory comment on that PR.

It is an engineering review checkpoint, not a new FlowWork runtime agent. It does not change the main planner, FinNLP, invoice-extractor role names or assignments.

### Current provider onboarding status

| Provider / tool | Intended checkpoint | Current state |
|---|---|---|
| Groq | Existing main planner | Existing model-backed role; staging configuration and release acceptance remain governed by the AI roster and Phase 9 gates. |
| Groq / Qwen | Existing FinNLP financial verifier | Existing model-backed sidecar; remains advisory, bounded, and non-authoritative. |
| Groq / Qwen vision | Existing invoice document extractor | Dedicated adapter exists in the repository. Live synthetic invoice acceptance and preview-model risk remain open. |
| Groq | Independent review of selected PR diffs using the existing Groq account | Manual review option added. Requires GROQ_API_KEY in repository Actions secrets. Uses the Groq OpenAI-compatible Chat Completions API. |\n| Claude | Independent review of selected high-impact PR diffs | Manual review workflow added in this branch. Requires ANTHROPIC_API_KEY and a successful manual test after merge. |
| DeepSeek | Independent cost-conscious review of selected low/medium-risk PR diffs | Manual review workflow added in this branch. Requires DEEPSEEK_API_KEY and a successful manual test after merge. |
| ChatGPT | Requirements clarification, architecture discussion, and decision synthesis | Human-operated development checkpoint; not a FlowWork production runtime dependency. |
| Codex | Issue-scoped implementation and test work | Development tool. Continue requiring a dedicated branch, CI, review, and human merge. No self-merge or deployment authority. |
| Devin | Issue-scoped implementation that produces a reviewable branch / PR | Not integrated with FlowWork yet. Requires Devin V3 service-user setup and a deliberately scoped repository connection. |
| Gemini | Candidate alternative for the existing invoice-extraction role | Not integrated. Needs its own native provider adapter and fixture-based parity evaluation; do not point the current Groq Chat Completions adapter at Gemini. |

The implementation deliberately does not fan every request out to every model. The selected reviewer(s) are invoked only when a maintainer manually dispatches the workflow.

## 2. Configure Groq, Claude, and DeepSeek

Create API keys with the relevant provider accounts. Add them as **GitHub repository Actions secrets**:

1. Open the Main-Repo GitHub repository.
2. Go to Settings → Secrets and variables → Actions.
3. Under Repository secrets, add GROQ_API_KEY, ANTHROPIC_API_KEY, and/or DEEPSEEK_API_KEY.
4. Do not place provider keys in source files, workflow YAML literals, frontend environment variables, or committed environment files.

The workflow defaults are:

| Provider | Model | API endpoint |
|---|---|---|
| Groq | openai/gpt-oss-120b | https://api.groq.com/openai/v1/chat/completions (see [Groq Chat Completions API](https://console.groq.com/docs/api-reference) and [supported models](https://console.groq.com/docs/models)) |\n| Claude | claude-sonnet-5-5 | https://api.anthropic.com/v1/messages (see [Claude Messages API](https://platform.claude.com/docs/en/api/messages) and [Sonnet 5.5 model details](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)) |
| DeepSeek | deepseek-flash | https://api.deepseek.com/chat/completions (see [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)) |

Models are explicit workflow settings and can be updated after a reviewed model/version change. Provider account billing and rate limits still apply. Selecting both calls both APIs and may incur charges from each provider.

## 3. Run a review

After this PR is merged:

1. Open the repository's Actions tab.
2. Select **Manual AI-assisted PR review**.
3. Choose Run workflow from the main branch.
4. Enter the open PR number.
5. Select Groq, Claude, DeepSeek, or both.
6. Run the workflow and read its comment on the selected PR.

The workflow only reviews PRs that belong to this repository, are open, and target main. If a selected provider secret is missing, the run fails with a setup message.

A review result is posted as a normal PR issue comment. Re-running the workflow updates its existing marked comment when available instead of repeatedly adding new review comments.

## 4. Security and data handling

The workflow is deliberately manual. A maintainer chooses which PR diff is sent to an external model provider.

The workflow:
- checks out trusted code from main; it never checks out or runs code from the PR branch;
- uses only GitHub token permissions for contents: read, pull-requests: read, and issues: write (the latter is only for publishing the comment);
- has no contents: write, actions: write, deployment, merge, or PR-approval permission;
- only includes patched text/code files from src, supabase/functions, supabase/migrations, scripts, docs, and .github/workflows;
- skips environment files, secret/credential directories, fixtures/sample-data directories, lockfiles, binaries, invoice/spreadsheet data files, and files without a patch;
- caps review at 60 files, 100,000 total patch characters, and 18,000 patch characters per file;
- redacts common API-key, OAuth-token, bearer-token, private-key, and credential-assignment patterns before transmission and before publishing the report;
- treats the diff as untrusted content and instructs the reviewer to ignore embedded instructions;
- records the model and file counts in the comment.

Automated redaction is not a guarantee that every sensitive value will be detected. **Do not dispatch a review for a diff that contains confidential customer information, real invoice contents, credentials, or code that your organization is not permitted to share with the selected provider.** Inspect the selected PR diff first. Skipped or truncated patches are not reviewed; the comment reports those counts.

The AI reviewer is advisory. It does not run the project's CI, inspect live secrets, verify deployment state, create commits, approve PRs, merge PRs, or deploy software. Findings must be checked against source code, tests, and current project policy by a human reviewer.

## 5. Integration sequence after this PR

1. **Groq / Claude / DeepSeek PR review:** select one configured provider, add its corresponding repository Actions secret, run against a small non-sensitive PR, verify the comment, model ID, and returned input/output token counts, then confirm usage in the provider console.
2. **Gemini invoice adapter:** implement a separate native Gemini adapter against the existing invoice-extraction interface. Preserve the current approval gate, human review, null/abstention behavior, document-size limits, and evidence handling. Compare it against the same synthetic PDF/image fixtures as the current provider before changing any assignment.
3. **Devin implementation service:** connect a dedicated Devin service user using its V3 API key and a narrowly scoped GitHub repository connection. It should receive one bounded issue, produce a branch/PR, and stop for existing CI and human review. It must not receive production secrets, self-merge, change branch protection, or deploy.
4. **Codex development integration:** retain the current dedicated-branch coding workflow. A later SDK/app-server integration should preserve explicit approval events and keep the agent separate from repository merge/deployment authority.
5. **Runtime model expansion:** only consider additional providers for existing planner, FinNLP reviewer, or invoice extractor checkpoints after provider-specific request/response adapters, schema validation, compatibility tests, synthetic evaluations, latency/cost observations, and staging acceptance exist.

Do not turn this into a model-voting loop. The primary planner remains the plan owner; FinNLP remains the specialist verifier; the server remains authoritative for tool allowlists, authorization, human approvals, execution state, recovery, and evidence.

## 6. Relationship to Phase 9

The current Phase 9 production-readiness audit remains open. This PR does not close live invoice acceptance, a staging recovery drill, owner approval and implementation of SLOs/alerts, retention approval, dependency-risk review, leaked-password risk acceptance, or optional live integration acceptance. Provider onboarding can proceed as a separate workstream, but no production-readiness claim follows from a successful code-review workflow.
