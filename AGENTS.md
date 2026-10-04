# FlowWork Agent Instructions

## Product

FlowWork is a B2B workflow automation platform.

The core loop is:

Goal
→ Plan
→ Execute
→ Observe
→ Verify
→ Recover
→ Deliver

The product should prioritize reliable task completion over conversational cleverness.

## Architecture principles

- Keep frontend, backend, AI orchestration, integrations, and verification clearly separated.
- Keep the AI provider layer model-agnostic.
- Treat model output as untrusted input.
- Tools must enforce their own authorization.
- Never allow the model to bypass permission checks.
- Persist long-running task state.
- Do not fake task completion.
- Do not claim an external action succeeded without evidence.
- Prefer small, testable changes over broad rewrites.

## Database

- Supabase/PostgreSQL is the backend.
- Use migrations for schema changes.
- Keep RLS enabled where required.
- Never expose secrets or privileged credentials to the frontend.

## Git

- Never push directly to main.
- Work on a dedicated branch.
- Keep changes scoped to the assigned task.
- Do not undo unrelated work.
- Before opening a PR, run the relevant tests/checks.

## AI agents

Before modifying code:

1. Read this file.
2. Inspect the relevant architecture.
3. Identify existing components that should be reused.
4. Avoid unnecessary refactoring.

After modifying code:

1. Run typecheck.
2. Run lint.
3. Run tests.
4. Run build when appropriate.
5. Summarize changed files.
6. Report any uncertainty honestly.

## Security

Never:
- expose secrets
- bypass authorization
- disable security controls to make a test pass
- silently weaken validation
- introduce arbitrary unrestricted code execution

## Product behavior

The UI should be understandable to normal business users.

Do not expose internal model reasoning or chain-of-thought.

Show operational progress instead:
- Planning
- Running
- Waiting for approval
- Verifying
- Completed
- Failed

## Definition of done

 A task is not complete because code was written.

A task is complete when:
- implementation exists
- relevant tests pass
- typecheck passes
- lint passes
- build passes when applicable
- behavior matches the issue
- security implications have been considered
- the result is reviewable
