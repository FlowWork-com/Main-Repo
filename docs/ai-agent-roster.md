# FlowWork AI agent roster and model assignments

**Decision:** use three model-backed runtime roles, plus deterministic and data-provider components. For the selected staging profile, Groq is the API provider for the existing **main planner** and **FinNLP financial reviewer**. FinNLP remains a specialist sidecar; it is never the primary planner, authorization authority, or execution authority. Invoice extraction stays on its separately configured provider until Groq PDF/image compatibility is proven by adapter and fixture tests.

This roster records the selected staging configuration, not proof of active deployment. The actual provider/model values are loaded from server-side Supabase Edge Function Secrets and cannot be inferred from repository source. Do not claim the latest code is live-verified until a fresh authenticated smoke run against the intended commit passes. Keep Phase 9/new-roadmap work on hold until the staged acceptance checks below are recorded.

## Runtime product agents

| Runtime role | Model ID to configure | Component configuration | Responsibility and boundary |
|---|---|---|---|
| **FlowWork main planner** | `openai/gpt-oss-120b` (selected Groq staging model) | `FLOWWORK_PLANNER_PROVIDER=openai-compatible`, `FLOWWORK_PLANNER_BASE_URL=https://api.groq.com/openai/v1`, `FLOWWORK_PLANNER_MODEL=openai/gpt-oss-120b` | Turns a user goal into a bounded structured plan. For financial requests, it receives one FinNLP handoff and may revise the plan once. The server validates the final plan and tool inputs. The planner does not itself authorize or execute an action. |
| **FinNLP financial verifier / language decoder** | `qwen/qwen3.8-27b` (selected Groq staging model; preview model) | `FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible`, `FLOWWORK_FINNLP_REVIEW_BASE_URL=https://api.groq.com/openai/v1`, `FLOWWORK_FINNLP_REVIEW_MODEL=qwen/qwen3.8-27b` | A bounded second opinion for financial terminology, ambiguity, unsupported assumptions, contradictory source snippets, missing accounting basis/period/currency, and handoff questions. It performs one review pass, not an agent loop. It must not issue investment/trading recommendations, mark unsupported claims as verified, approve writes, or execute tools. |
| **Invoice document extractor** | Separately configured vision model (not assigned to Groq yet) | `FLOWWORK_INVOICE_PROVIDER=openai-compatible`, `FLOWWORK_INVOICE_BASE_URL=<validated-provider-endpoint>`, `FLOWWORK_INVOICE_MODEL=<validated-vision-model-id>` | Reads the approved PDF/image invoice and returns field-level extraction estimates for human review. It only runs through the existing high-risk approval gate; the model's confidence is not a calibrated probability and extracted fields are not automatically trusted. |

These are explicit role assignments, not hard-coded fallbacks. The planner and FinNLP reviewer each need their own configured `*_BASE_URL` and server-side `*_API_KEY` secret name even if the same fresh Groq key is temporarily used for staging. Separate keys are preferable for attribution and rotation. Never put credentials in `VITE_*` variables, `.env.example`, browser code, or Git history. The invoice extractor needs independently configured credentials for a provider that supports its exact PDF/image request format; a Groq planner key alone does not configure that role.

### Selected Groq profile for staging (planner + FinNLP only)

The planner and FinNLP reviewer use Groq's OpenAI-compatible Chat Completions endpoint at `https://api.groq.com/openai/v1`. The selected model IDs support Groq Strict Structured Outputs (JSON Schema); server-side canonical plan and tool validators remain authoritative. Configure these Edge Function secrets for staging:

```sh
FLOWWORK_PLANNER_PROVIDER=openai-compatible
FLOWWORK_PLANNER_BASE_URL=https://api.groq.com/openai/v1
FLOWWORK_PLANNER_MODEL=openai/gpt-oss-120b
# FLOWWORK_PLANNER_API_KEY=<fresh Groq API key>

FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible
FLOWWORK_FINNLP_REVIEW_BASE_URL=https://api.groq.com/openai/v1
FLOWWORK_FINNLP_REVIEW_MODEL=qwen/qwen3.8-27b
# FLOWWORK_FINNLP_REVIEW_API_KEY=<fresh Groq API key>
```

For a quick staging check, the same freshly generated Groq key can populate both role-specific secret names; separately scoped/project-specific keys are preferable where the account supports them. Check the Groq Console for account access and quota before running the smoke test; usage may incur charges. The staging run calls the planner, reviewer, and planner again. **Groq currently lists `qwen/qwen3.8-27b` among its preview models**, so this pairing is for staging evaluation only; do not promote it to production until the model is production-listed or a production-listed alternative passes the same review contract and evaluation. See [Groq supported models](https://console.groq.com/docs/models) and [Strict Structured Outputs](https://console.groq.com/docs/structured-outputs).

**Do not point the invoice extractor at Groq using this profile.** The current invoice adapter sends PDFs using a Chat Completions `type: "file"` payload, while Groq's published Qwen vision path documents image inputs. The current JPG/PNG payload may be compatible, but PDF behavior has not been validated. Keep the invoice role on its independently tested provider configuration until a dedicated Groq invoice adapter and PDF fixture tests are added. Its existing approval gate must remain enabled.

This profile changes only provider configuration: FinNLP remains a verifier/language decoder, the planner remains the primary planner, and application-owned validation, approval, authorization, persistence, and tool execution remain unchanged. Groq references: [OpenAI compatibility](https://console.groq.com/docs/openai), [supported models](https://console.groq.com/docs/models), [vision support](https://console.groq.com/docs/vision), and [rate limits](https://console.groq.com/docs/rate-limits).

### Why these choices

- `openai/gpt-oss-120b` is the selected staging planner because Groq's current catalog identifies it as a production model and the strict-schema API supports it.
- `qwen/qwen3.8-27b` is retained as the selected staging financial-language reviewer because the existing adapter and tests use its strict-schema response contract; Groq currently classifies it as a preview model, so production use is explicitly blocked pending a production-listed alternative or a status change and successful evaluation.
- Strict Structured Outputs constrain response shape but do not prove financial correctness, source validity, authorization, or tool safety. FlowWork's server-side schema, tool registry, dependency, approval, and workflow checks remain the authority.
- These are staging assignments, not measured quality claims. Compare model/provider/prompt versions with the offline planner evaluation suite and representative synthetic financial-review cases before changing the roster. Keep invoice extraction separate until Groq PDF payload compatibility has dedicated fixtures and tests.

Official references: Groq [OpenAI compatibility](https://console.groq.com/docs/openai), [supported models](https://console.groq.com/docs/models), [Strict Structured Outputs](https://console.groq.com/docs/structured-outputs), [vision support](https://console.groq.com/docs/vision), and [rate limits](https://console.groq.com/docs/rate-limits).

## AI-adjacent components that should **not** receive a generative model

| Component | What it does today | Model assignment |
|---|---|---|
| **FinNLP/Finnhub company-news tool** | Retrieves company-news records through a fixed Finnhub endpoint, using workspace/member-scoped credentials. The tool returns bounded source data. | None. Finnhub is the data source, not an LLM. |
| **Optional `finnlp-agent-bridge` service** | Calls the pinned upstream FinNLP `Finnhub_Date_Range` client to retrieve news and hands back structured evidence. It binds to loopback and is not the main FlowWork planner. | None of its own. Upstream FinNLP code plus Finnhub provide data retrieval; do not count this bridge as another autonomous decision agent. |
| **CSV/spreadsheet review** | Uses deterministic parsing, aggregation, and validation rules. | None. Keep numeric calculations deterministic where possible. |
| **Plan worker, authorization, state transitions, tool registry, and recovery** | Enforces persisted dependencies, permissions, approvals, retries/recovery policy, and workflow state. | None. These are application/control-plane responsibilities; an LLM must not be the source of authorization truth. |
| **Evidence/verification state** | Stores evidence references and gates workflow transitions. Currently, user-supplied evidence references are not independently proven merely by being stored. | No additional verifier model by default. FinNLP can help review claims, but human review and source validation remain necessary. |

Do not create a separate generative agent just to duplicate one of these deterministic/data-provider responsibilities. Add a new runtime agent only when it has a concrete job, an explicit input/output contract, a least-privilege tool set, a measurable test suite, and a clear handoff to the main planner.

## Engineering personas are a separate roster

The eleven files in `.github/agents/` are repository engineering personas (architect, backend, frontend, integrations, QA, validator, security reviewer, and their specialist reviewers). They help developers and GitHub Copilot work on the codebase; they are **not** runtime agents in the deployed FlowWork application. Several declare `model: default`, and the Copilot-targeted profiles rely on the active Copilot harness/session. Do not conflate those settings with the three server-side model IDs above. Their actual model can vary by developer/tooling configuration and is not pinned by the runtime environment variables.

## Deployment configuration checklist

Configure these as server-side Supabase Edge Function secrets; the keys are placeholders, not values to commit:

```sh
FLOWWORK_PLANNER_PROVIDER=openai-compatible
FLOWWORK_PLANNER_BASE_URL=https://api.groq.com/openai/v1
FLOWWORK_PLANNER_MODEL=openai/gpt-oss-120b
# FLOWWORK_PLANNER_API_KEY=<Groq secret>

FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible
FLOWWORK_FINNLP_REVIEW_BASE_URL=https://api.groq.com/openai/v1
FLOWWORK_FINNLP_REVIEW_MODEL=qwen/qwen3.8-27b
# FLOWWORK_FINNLP_REVIEW_API_KEY=<Groq secret>

# Keep invoice extraction separate until a provider and model are validated
# for the exact PDF/image payloads used by this adapter.
FLOWWORK_INVOICE_PROVIDER=openai-compatible
FLOWWORK_INVOICE_BASE_URL=<validated-provider-endpoint>
FLOWWORK_INVOICE_MODEL=<validated-vision-model-id>
# FLOWWORK_INVOICE_API_KEY=<separate server-side secret>
```

The deployment's secret manager is the source of truth for active configuration. Do not duplicate the model IDs as code fallbacks: a missing provider configuration should fail closed, as it does today.

## Phase hold / readiness gate

**Hold new Phase 9+ feature work** until the deployment model configuration is confirmed and the following staging checks are recorded:

1. Planner smoke test: a normal goal returns a valid plan, and a financial goal triggers exactly one FinNLP review and one planner revision.
2. FinNLP smoke test: an ambiguous financial claim yields useful interpretation/questions, and without independent sources the result is explicitly `insufficient_evidence` or `clarification_needed`.
3. Invoice smoke test: a known test invoice produces a field-level result only after the normal approval gate, with absent/ambiguous fields left null or low-confidence.
4. Finnhub smoke test: the configured workspace connection retrieves real articles or an honest empty result; no key or raw provider error leaks.
5. Capture pass/fail, model ID, latency, and a simple cost/usage observation for each live model path.

The existing PR/CI work is complete; live provider behavior still needs a credentialed staging check. Do not claim that a model is deployed, or that Phase 8's external-provider acceptance is complete, until those checks pass.

**Phase numbering note:** the current integration guide already marks its historical Phase 9 (stale tool-execution recovery) and Phase 10 (extraction quality monitoring) as merged. This hold applies to any *new* roadmap phase after the FinNLP roster/readiness work, not to reverting or redoing those merged phases.


## Selective AI routing policy (existing roles only)

This section assigns providers and engineering tools to **specific checkpoints**. It does not add, rename, replace, or broaden any runtime or `.github/agents/` role. The existing role definitions, tool permissions, workflow state machine, approval gates, and FinNLP's verifier-only boundary remain authoritative.

### Assignment matrix

| AI/tool | Assign it here | Do not assign it here | Status and gate |
|---|---|---|---|
| **Groq API (selected staging profile)** | Existing runtime **main planner** (`openai/gpt-oss-120b`) and **FinNLP financial reviewer** (`qwen/qwen3.8-27b`) only, through the OpenAI-compatible endpoint. Keep the roles' separate secret names and budgets. | Do not route invoice extraction through this profile yet. Do not give either model authorization, tool-dispatch, approval, workflow-state, or verification-finality authority. | **Code/config profile exists; deployed secret state is not readable from repository source.** The last recorded successful smoke used an earlier workflow-dispatch SHA; rerun against current `main` after these config/roster decisions before claiming latest-commit staging acceptance. Qwen is currently preview-listed. | 
| **Invoice extraction provider** | Existing invoice extraction role only, using a separately configured vision provider/model with tested PDF/image payload compatibility. | Do not reuse the Groq planner/reviewer key as invoice credentials or swap a base URL without a dedicated adapter and fixtures. | **Existing code path; provider readiness must be checked separately.** Keep the high-risk approval gate and human review. |
| **ChatGPT** | Human-facing architecture discussion, requirements clarification, trade-off synthesis, and turning ambiguous product requests into a reviewable plan before implementation. | Not a production runtime dependency, not a source of truth for repository state, and not an automatic approver. | **Human-operated checkpoint.** Decisions must be grounded in repository code and captured in an issue/PR before implementation. |
| **Codex** | Repository implementation on a dedicated branch: bounded code changes, regression tests, type/lint/build fixes, and a PR diff for review. Use it as the implementation tool—not as the final judge of its own work. | No direct production secret access, policy bypass, self-merge, or deployment authority. | **Engineering workflow only.** Existing CI, the repository's Validator/QA/security review checkpoints, and human merge rules remain the acceptance gates. |
| **Claude** | Independent architecture/security challenge on high-impact diffs: auth/RLS, provider boundaries, prompt-injection handling, financial-review handoffs, and approval/execution paths. Ask for concrete findings tied to changed lines and tests. | Not a second runtime planner and not a replacement for the existing architect or security-reviewer roles. | **Advisory review checkpoint.** A finding must be reproduced or resolved against code/tests; Claude does not override CI, policy, or human review. |
| **DeepSeek** | Cost-conscious independent code/test review for bounded, low-to-medium-risk diffs; look for missing edge cases, malformed provider output, retries/timeouts, and test gaps. | Not the only reviewer for security-sensitive changes; not a runtime decision-maker or source of factual truth. | **Advisory review checkpoint.** Escalate security, finance, permissions, or destructive-operation findings to the existing security/QA/human gates. |
| **Gemini** | Candidate for the **existing invoice-document-extraction path only** when a dedicated adapter has been implemented and tested against the repository's PDF/image fixtures. Its multimodal capability is useful at this narrow boundary. | Do not point the current OpenAI-compatible invoice adapter at a Gemini endpoint and assume request/response compatibility; do not let extracted fields auto-approve or trigger actions. | **Not wired by this assignment.** The current `invoiceProvider.ts` sends a specific Chat Completions multimodal payload. Add provider-specific request/response mapping and fixture-based parity tests before enabling Gemini. Keep the existing approval gate and human review. |
| **Devin** | Isolated, issue-scoped implementation work that produces a branch/PR—for example, a self-contained adapter, tests, or bounded maintenance task. | Not a deployed FlowWork runtime agent; no production credentials, secret rotation, branch-protection changes, self-approval, self-merge, or production deployment. | **Engineering worker only.** Require a narrow issue, acceptance criteria, CI, the existing reviewers, and human merge approval. |

### Decision filtering: one owner, bounded reviewers

1. The **existing main planner** owns plan drafting. For financial requests, it may receive the existing **single FinNLP review handoff** and make at most the existing single revision. Do not create a multi-model runtime debate or recursive consensus loop.
2. The **existing FinNLP reviewer** remains a specialist financial-language decoder/verifier. It can flag ambiguity, unsupported claims, missing evidence, and questions for the planner; it cannot approve, execute, or turn an unsupported claim into a verified fact.
3. For code changes, **Codex or Devin may implement**, while **Claude or DeepSeek may independently critique** a bounded diff. These are optional engineering checkpoints, not new repository roles. Keep the existing architect, backend, frontend, integrations, QA, validator, and security-reviewer role definitions unchanged.
4. **Deterministic code remains the final authority** for schema/tool allowlists, authentication, workspace access, approvals, state transitions, retries, and evidence-state changes. AI review comments are signals to investigate, never authorization.
5. Do not fan every request out to every AI. Route only when the risk/uncertainty justifies the cost. Record the selected tool/provider, task or PR, concrete findings, tests run, and resolved/unresolved status—never credentials or private invoice contents in review logs.
6. Do not claim Claude, DeepSeek, Gemini, or Devin is integrated into production from this documentation change. Runtime provider support requires an explicit adapter contract, server-side secret handling where applicable, compatibility tests, evaluation fixtures, latency/cost observations, and staging acceptance.

### Implementation order

- **Now:** use the selected Groq profile for staging's existing planner and FinNLP reviewer only. Use ChatGPT for human-led design synthesis and Codex for bounded repository implementation; use Claude/DeepSeek only as optional independent PR reviewers; use Devin only for isolated PR-producing engineering tasks. Keep the invoice role separate until its provider contract is validated.
- **Later, behind evaluation:** prototype Gemini against the existing invoice-extraction contract using a dedicated adapter. Compare field-level exact match, null/abstention behavior, malformed output, latency, and cost against the current provider on the same fixture set. Do not change the active provider until it passes.
- **Before any runtime provider expansion:** add explicit provider configuration and adapter tests. A base URL swap is not proof of API compatibility, and a provider being available in an engineering product does not make it a runtime API.

