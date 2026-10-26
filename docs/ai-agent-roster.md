# FlowWork AI agent roster and model assignments

**Decision:** use three model-backed runtime roles, plus deterministic and data-provider components. FinNLP remains a specialist sub-agent; it never becomes the primary planner or an execution authority.

This is the repository's intended initial model roster. The production model IDs cannot be inferred from source code because model/provider configuration is loaded from server-side Supabase Edge Function secrets. Do not describe the deployment as using these models until the secret values and a live smoke test have been checked.

## Runtime product agents

| Runtime role | Model ID to configure | Component configuration | Responsibility and boundary |
|---|---|---|---|
| **FlowWork main planner** | `gpt-6.1-sol` | `FLOWWORK_PLANNER_PROVIDER=openai-compatible`, `FLOWWORK_PLANNER_MODEL=gpt-6.1-sol` | Turns a user goal into a bounded structured plan. For financial requests, it receives one FinNLP handoff and may revise the plan once. The server validates the final plan and tool inputs. The planner does not itself authorize or execute an action. |
| **FinNLP financial verifier / language decoder** | `gpt-6-astra` | `FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible`, `FLOWWORK_FINNLP_REVIEW_MODEL=gpt-6-astra` | A higher-capability second opinion for financial terminology, ambiguity, unsupported assumptions, contradictory source snippets, missing accounting basis/period/currency, and handoff questions. It performs one review pass, not an agent loop. It must not issue investment/trading recommendations, mark unsupported claims as verified, approve writes, or execute tools. |
| **Invoice document extractor** | `gpt-6.1-sol` | `FLOWWORK_INVOICE_PROVIDER=openai-compatible`, `FLOWWORK_INVOICE_MODEL=gpt-6.1-sol` | Reads the approved PDF/image invoice and returns field-level extraction estimates for human review. It only runs through the existing high-risk approval gate; the model's confidence is not a calibrated probability and extracted fields are not automatically trusted. |

These are explicit role assignments, not hard-coded fallbacks. Each role still needs its own configured `*_BASE_URL` and server-side `*_API_KEY`. For the OpenAI API, the recommended base URL is `https://api.openai.com/v1`. Use separate server-side secrets per role to support least-privilege operations, attribution, rotation, and usage monitoring. Never put these credentials in `VITE_*` variables, `.env.example`, browser code, or Git history.

### Why these choices

- OpenAI's current model catalog describes GPT-6.1 Sol as a strong option for complex professional work with lower cost than GPT-6 Astra, so it is the default choice for the main planner and invoice extraction workload.
- GPT-6 Astra is reserved for the less frequent finance-review sidecar, where ambiguous financial wording and conflicting evidence merit the strongest available reasoning model.
- All three GPT-6 request adapters deliberately **omit a custom `temperature` parameter**, because OpenAI documents GPT-6 Astra and GPT-6.1 Sol as not supporting custom temperature/top-p with reasoning effort enabled. The invoice extractor uses `max_completion_tokens` rather than the deprecated `max_tokens`. These adapters call Chat Completions without provider-side tool calls; FlowWork retains ownership of tool dispatch and authorization. See the model-specific [GPT-6 guidance](https://developers.openai.com/api/docs/guides/latest-model) and [Chat Completions parameter reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
- These model IDs are starting assignments, not proof of accuracy. Evaluate them on the repository's planner dataset and known invoice fixtures; tune or replace them based on measured accuracy, latency, cost, and provider compatibility.

Official references: [OpenAI API models](https://developers.openai.com/api/docs/models), [model selection guide](https://developers.openai.com/api/docs/guides/model-selection), and [API changelog](https://developers.openai.com/api/docs/changelog).

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
FLOWWORK_PLANNER_BASE_URL=https://api.openai.com/v1
FLOWWORK_PLANNER_MODEL=gpt-6.1-sol
# FLOWWORK_PLANNER_API_KEY=<secret>

FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible
FLOWWORK_FINNLP_REVIEW_BASE_URL=https://api.openai.com/v1
FLOWWORK_FINNLP_REVIEW_MODEL=gpt-6-astra
# FLOWWORK_FINNLP_REVIEW_API_KEY=<secret>

FLOWWORK_INVOICE_PROVIDER=openai-compatible
FLOWWORK_INVOICE_BASE_URL=https://api.openai.com/v1
FLOWWORK_INVOICE_MODEL=gpt-6.1-sol
# FLOWWORK_INVOICE_API_KEY=<secret>
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
