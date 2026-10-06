# FlowWork Agentic Security Guardrails

## Core Principle
AI agents must NEVER possess direct, unrestricted production credentials or direct access to production databases/APIs. All actions must route through a decoupled permission validation proxy.

## Architecture Pipeline
AI Agent ➔ Tool Execution Request ➔ Permission Validation Layer ➔ Secure Gate Execution

## Restricted Capabilities (Human Gate Required)
- Send Email / Communication blasts
- Edit CRM Core Records
- Create/Modify Calendar Events
- Delete Files / Drop Database Tables
- Move Money / Execute Financial Transactions
- Modify Core Business Records

## Code Implementation Constraints
- Production API tokens must only live inside secure, sandboxed environment vaults.
- Agents are restricted to submitting transactional payloads to validation hooks (`/api/v1/verify`). They cannot initiate direct execution loops.
