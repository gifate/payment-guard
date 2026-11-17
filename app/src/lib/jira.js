/**
 * Small wrappers around the Jira REST API.
 *
 * Holds are mirrored into Jira itself so that a payment clerk sees them even
 * without opening the app: a label (filterable in JSM queues with
 * `labels = payment-guard-hold`) and a comment explaining why.
 */
import api, { route } from '@forge/api';

export const HOLD_LABEL = 'payment-guard-hold';

/** Builds a minimal Atlassian Document Format body from plain lines of text. */
function adf(lines) {
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/**
 * Runs a Jira request as the current user. When `allowAppFallback` is true and
 * the user is not allowed to do it, the app itself writes instead — used only
 * for placing a hold, because a hold must never be skipped for lack of rights.
 * Releasing a hold never falls back: a user who cannot edit the work item
 * cannot release its hold.
 */
async function requestJira(path, options, { allowAppFallback = false } = {}) {
  let response = null;
  try {
    response = await api.asUser().requestJira(path, options);
  } catch (error) {
    // No user context (e.g. the "work item created" trigger): only the app can act.
    if (!allowAppFallback) throw error;
  }
  if (allowAppFallback && (!response || (!response.ok && (response.status === 401 || response.status === 403)))) {
    response = await api.asApp().requestJira(path, options);
  }
  return response;
}

export async function addComment(issueKey, lines, opts) {
  const response = await requestJira(
    route`/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: adf(lines) }),
    },
    opts
  );
  return response.ok;
}

export async function setHoldLabel(issueKey, on, opts) {
  const response = await requestJira(
    route`/rest/api/3/issue/${issueKey}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ update: { labels: [on ? { add: HOLD_LABEL } : { remove: HOLD_LABEL }] } }),
    },
    opts
  );
  return { ok: response.ok, status: response.status };
}

/** True when the current user can see the work item. */
export async function canBrowse(issueKey) {
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/mypermissions?issueKey=${issueKey}&permissions=BROWSE_PROJECTS`, {
      headers: { Accept: 'application/json' },
    });
  if (!response.ok) return false;
  const body = await response.json();
  return Boolean(body?.permissions?.BROWSE_PROJECTS?.havePermission);
}

/**
 * Returns the subset of `keys` the current user may see (order kept).
 * Checks run in parallel in small batches; answers are cached per call.
 */
export async function filterVisible(keys, cache = new Map()) {
  const unique = [...new Set(keys)].filter((key) => !cache.has(key));
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    const answers = await Promise.all(batch.map((key) => canBrowse(key).catch(() => false)));
    batch.forEach((key, index) => cache.set(key, answers[index]));
  }
  return keys.filter((key) => cache.get(key));
}

/** True when the current user is a Jira administrator (used for settings). */
export async function userIsAdmin() {
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return false;
  const body = await response.json();
  return Boolean(body?.permissions?.ADMINISTER?.havePermission);
}

/** True when the current user may edit the work item (used before releases). */
export async function userCanEdit(issueKey) {
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/mypermissions?issueKey=${issueKey}&permissions=EDIT_ISSUES`, {
      headers: { Accept: 'application/json' },
    });
  if (!response.ok) return false;
  const body = await response.json();
  return Boolean(body?.permissions?.EDIT_ISSUES?.havePermission);
}
