# Payment Guard — Forge app source

Source code of the Payment Guard Forge app for Jira Service Management (Codegeist 2026).
Judges install the app from the installation link on the submission; this folder is for reading the code.

| Path | What it does |
|---|---|
| `manifest.yml` | Forge modules: `jira:issuePanel`, `jira:issueContext`, `jira:globalPage`, `trigger` (work item created), 3 × `action`, `rovo:mcp`, `rovo:agent`, functions |
| `src/lib/rules.js` | Pure rule engine (D1 duplicate number, D2 same amount within 30 days, B1 unverified account, B2 bank change, E missing data) |
| `src/lib/normalize.js` | How names, invoice numbers, accounts and amounts are normalised before comparing |
| `src/lib/parse.js` | Reads labelled invoice data and bank-change requests from the text of a new work item |
| `src/lib/guard.js` | Runs the rules, records holds, mirrors them to Jira (label + comment) |
| `src/lib/jira.js` | Jira REST calls: label, comment, permission checks (browse / edit / admin) |
| `src/lib/store.js` | Forge Key-Value Storage: invoices, verified accounts, bank changes, holds, audit trail, settings |
| `src/trigger.js` | Automatic intake when a work item is created |
| `src/actions.js` | Read-only tools for the Rovo agent and the Atlassian MCP server: check-invoice, list-holds, explain-hold |
| `src/resolvers/index.js` | Panel and page back end (permission checks, release with a reason, settings) |
| `src/frontend/` | UI Kit panel, status section and Payment Guard page |
| `test/` | Unit tests for the rules and the text reader (`npm test`, Node.js 24) |

There is deliberately no tool or action that releases a hold: only a person can do that, in the panel, with a written reason.
