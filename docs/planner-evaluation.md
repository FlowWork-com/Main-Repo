# Planner quality evaluation

## Offline benchmark

Run `npm run evaluate:planner` or the complete suite with `npm test`. The benchmark is deterministic, uses synthetic goals and mocked provider outcomes, makes no network calls, and requires no API credentials.

The versioned dataset is in `src/planning/evaluationDataset.ts`. It covers simple supported goals, multi-step dependencies, ambiguous goals, missing inputs, unsupported capabilities, malformed tool input, prompt injection, provider timeouts, and provider errors. Tests use the real canonical `ToolRegistry` and `validatePlan`; model-supplied `validation` fields are never trusted.

The report groups counts by category and records dataset/prompt version and provider mode. It includes provider success/timeout/error rates, valid-plan rate, registered tool/version and input-schema pass rates, dependency-graph validity, unsupported-capability detection, maximum-step enforcement, and malicious-instruction rejection. Plan regeneration/acceptance/rejection counts are explicitly marked as not measured because this offline harness does not inspect persisted user decisions. These are **synthetic harness results**, not evidence of live provider quality, accuracy, or production behavior. Do not compare different provider/model/prompt versions as if this deterministic fixture measured model quality.

## Optional live evaluation

There is no live-provider benchmark mode in this initial harness. To evaluate a real provider, add an explicitly opt-in runner that obtains credentials only from server-side environment configuration, sends only synthetic goals, bounds time/output/step count, and keeps credentials and raw provider payloads out of logs. Never make live calls from CI.

## Adding cases and comparing versions

1. Add a synthetic case with a unique ID and category.
2. Set the expected invariant outcome (`valid`, `blocked`, or `invalid`) and a deterministic mocked provider result.
3. Use canonical registry validation; do not assert exact natural-language wording.
4. Run the offline benchmark and full checks.
5. Compare only like-for-like dataset versions and clearly identify provider, model, prompt, and dataset versions. Treat real-provider measurements as a separate report.

## Known limitations

The unsupported-capability detector is heuristic and the offline dataset is intentionally small. This is a regression guard, not a statistical estimate of planner quality. No live model accuracy, false-positive rate, or false-negative rate is claimed.
