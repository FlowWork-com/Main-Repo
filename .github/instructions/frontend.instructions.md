---
name: FlowWork Frontend Guidelines
applyTo: "src/frontend/**/*"
---

# Frontend Guidelines
- Always implement explicit permission checking hooks on newly rendered visual views.
- Under no circumstances should internal model chain-of-thought or raw JSON errors leak to the end UI layer.
- Show operational loading states matching the /AGENTS.md schema: Planning, Running, Waiting for approval, Verifying, Completed, or Failed.
