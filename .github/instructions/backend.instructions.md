---
name: FlowWork Backend Guidelines
applyTo: "src/backend/**/*"
---

# Backend Guidelines
- Enforce strict PostgreSQL Row-Level Security (RLS) rules on all database transactions.
- Treat every external payload from an AI orchestration step as untrusted input; validate schemas tightly before mutation execution.
- Maintain persistent, historical logging records for long-running workflows.
