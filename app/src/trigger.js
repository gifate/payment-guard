/**
 * "Work item created" trigger (avi:jira:created:issue).
 *
 * Invoices usually reach accounts payable by e-mail (the JSM e-mail channel) or
 * through a portal request. When a new work item's summary/description contains
 * labelled invoice data ("Invoice number: …", "Amount due: …"), Payment Guard
 * records and checks it immediately — before anyone opens the ticket. A "please
 * update our bank details" message with a new IBAN is recorded as a bank-change
 * request, which holds every payment to that vendor.
 *
 * Nothing to configure: work items without such text are ignored.
 */
import api, { route } from '@forge/api';
import * as store from './lib/store.js';
import { extractFromText, adfToText } from './lib/parse.js';
import { checkAndRecord, recordBankChange } from './lib/guard.js';

const TRIGGER = 'read automatically from the new work item';

export async function onIssueCreated(event) {
  const issueKey = event?.issue?.key;
  if (!issueKey) return;
  // Never overwrite something a person already recorded.
  if ((await store.getInvoice(issueKey)) || (await store.getBankChange(issueKey))) return;

  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    console.warn(`Payment Guard: could not read ${issueKey} (HTTP ${response.status})`);
    return;
  }
  const { fields } = await response.json();
  const parsed = extractFromText(fields?.summary || '', adfToText(fields?.description));

  if (parsed.kind === 'invoice') {
    await store.setInvoice(issueKey, {
      ...parsed.invoice,
      recordedBy: null,
      recordedAt: Date.now(),
      source: 'auto',
    });
    await store.addAudit(issueKey, { type: 'invoice-recorded', by: null, trigger: TRIGGER, fields: parsed.found });
    await checkAndRecord(issueKey, null, TRIGGER);
  } else if (parsed.kind === 'bank-change') {
    await recordBankChange(issueKey, parsed.change, null, TRIGGER);
  }
}
