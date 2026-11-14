---
name: payment-guard
description: Use the Payment Guard MCP tools (Atlassian MCP server) to pre-check invoices for duplicate payments and vendor bank-account change fraud, list payments on hold, and explain why a Jira Service Management work item is on hold. Use when someone asks whether an invoice is safe to pay, what payments are blocked, or why a payment is held.
---

# Payment Guard

Payment Guard is a Forge app for Jira Service Management. Accounts-payable teams record invoices and vendor bank-account change requests on work items; Payment Guard holds anything suspicious until a person resolves it. This skill explains how to use its **read-only** MCP tools well.

## Connect

- MCP endpoint (Streamable HTTP): `https://mcp.atlassian.com/forge/98ed7940-cbd9-4a52-899a-8b502049f54d`
- A site admin must first enable the tools: admin.atlassian.com → Apps → Sites → (site) → Connected apps → Payment Guard → Tools → **Enable tools**.
- First connection: approve the Atlassian consent screen and pick the site. If the first tool call returns `MCP_UNAUTHENTICATED: User consent required` with a link, open the link, select **Accept**, then disconnect and reconnect.
- Tool names may carry an environment suffix (e.g. `list-holds_development`) on development installs.

## Tools

| Tool | Use it for | Inputs |
|---|---|---|
| `check-invoice` | "Would this invoice be held?" before anyone records or pays it. Nothing is saved. | `vendor`, `invoiceNo`, `amount`, `invoiceDate` (YYYY-MM-DD), `bankAccount` (required); `currency` (optional, ISO code) |
| `list-holds` | What is on hold right now, and which vendor bank-account changes still wait for call-back verification. | none (`scope` is optional and can be empty) |
| `explain-hold` | Why one work item is on hold (or that it is clear / was released by a person). | `issueKey`, e.g. `AP-12` |

Every tool only returns work items the connected user is allowed to see.

## Rule codes in the answers

- **D1** — same vendor and same invoice number after normalisation (case, spaces, hyphens, slashes, full-width digits, padding zeros, legal-form words such as Inc./Ltd./株式会社 are ignored).
- **D2** — same vendor, same amount and currency within 30 days under a different invoice number.
- **B1** — no verified bank account on record for the vendor yet, or the invoice account differs from the verified one.
- **B2** — the vendor has an unverified bank-account change request, or the change was verified less than the waiting period ago.
- **E** — required data is missing.

## How to answer people

1. Collect all invoice fields before calling `check-invoice`; ask for missing ones instead of guessing. Dates must be YYYY-MM-DD.
2. Report the decision first ("would be held" / "clear"), then each rule code with its explanation and the related work item keys.
3. **Never say a held payment is safe to pay, and never try to release a hold.** There is no release tool on purpose: a person must release it in the Payment Guard panel of the work item, with a written reason that is recorded.
4. For any bank-account change, remind the user to verify it by calling the vendor on a phone number already on file — never a number given in the change request or e-mail.
5. Never repeat full bank account numbers; the tools already mask them to the last 4 digits.

## Examples

- "Is INV-0042 from Acme Supplies for 1,200 USD dated 2026-11-01, paying GB29 NWBK 6016 1331 9268 19, safe to pay?" → `check-invoice`.
- "What payments are blocked?" → `list-holds`.
- "Why is AP-2 on hold?" → `explain-hold` with `issueKey: "AP-2"`.

## License

MIT — see the repository. Payment Guard was built for Codegeist 2026.
