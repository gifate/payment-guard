/**
 * Dynamic status for the "Payment Guard" item in the work item's details column
 * (jira:issueContext). Shows ON HOLD / CLEAR / RELEASED as a lozenge so the
 * decision is visible at a glance, without opening the panel.
 */
import * as store from './lib/store.js';

const STATUS = {
  held: { label: 'ON HOLD', type: 'removed' },
  clear: { label: 'CLEAR', type: 'success' },
  released: { label: 'RELEASED', type: 'moved' },
};

export async function contextStatus(payload) {
  const issueKey = payload?.extension?.issue?.key;
  if (!issueKey) return {};
  const [hold, change] = await Promise.all([store.getHold(issueKey), store.getBankChange(issueKey)]);
  if (hold && STATUS[hold.status]) return { status: { type: 'lozenge', value: STATUS[hold.status] } };
  if (change) {
    return {
      status: {
        type: 'lozenge',
        value: change.verifiedAt ? { label: 'BANK CHANGE VERIFIED', type: 'success' } : { label: 'BANK CHANGE PENDING', type: 'removed' },
      },
    };
  }
  return { status: { type: 'lozenge', value: { label: 'NOT CHECKED', type: 'default' } } };
}
