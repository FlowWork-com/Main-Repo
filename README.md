# FlowWork

FlowWork is a B2B workflow automation platform. This repository currently contains an early frontend prototype; the displayed task status is illustrative and is not connected to a live workflow.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Local development

```sh
npm ci
npm run dev
```

## Quality checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` runs all four checks in sequence. The production bundle is written to `dist/`.

## Current scope

The React interface demonstrates operational progress states only. It does not authenticate users, access a backend, persist task state, execute integrations, or enforce permissions. Do not connect production credentials or treat the displayed state as evidence that a workflow ran.
