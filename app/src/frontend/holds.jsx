/**
 * Payment Guard — global page (Apps menu > Payment Guard).
 *
 * One place for the accounts-payable lead to see every payment on hold, every
 * unverified bank-account change, the released holds with their reasons, and
 * the settings. Works without Rovo.
 */
import React, { useEffect, useState, useCallback } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  ErrorMessage,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield,
  Toggle,
  User,
  ValidMessage,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const formatTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
const issueLink = (key) => <Link href={`/browse/${key}`}>{key}</Link>;

const Settings = ({ initial, onSaved }) => {
  const [days, setDays] = useState(String(initial.coolingDays));
  const [second, setSecond] = useState(Boolean(initial.requireSecondPerson));
  const [result, setResult] = useState(null);
  const save = async () => {
    const response = await invoke('saveSettings', { coolingDays: days, requireSecondPerson: second });
    setResult(response);
    if (!response?.error) onSaved();
  };
  return (
    <Stack space="space.150">
      <Stack space="space.050">
        <Label labelFor="pg-days">Waiting period after a bank-account change is verified (days)</Label>
        <Textfield id="pg-days" defaultValue={days} onChange={(e) => setDays(e.target.value)} />
      </Stack>
      <Inline space="space.100" alignBlock="center">
        <Toggle id="pg-second" isChecked={second} onChange={() => setSecond(!second)} />
        <Label labelFor="pg-second">Require a second person to verify bank-account changes (recommended for real teams)</Label>
      </Inline>
      <Box>
        <Button onClick={save}>Save settings</Button>
      </Box>
      {result?.error ? <ErrorMessage>{result.error}</ErrorMessage> : null}
      {result && !result.error ? <ValidMessage>Saved.</ValidMessage> : null}
    </Stack>
  );
};

const App = () => {
  const [data, setData] = useState(null);
  const load = useCallback(async () => setData(await invoke('listHolds')), []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <Spinner label="Loading Payment Guard" />;

  return (
    <Stack space="space.300">
      <Text>
        Stops duplicate invoice payments and holds payments to vendors whose bank details changed until a person verifies
        them by call-back. Work items on hold also carry the label payment-guard-hold, so you can filter any queue with
        labels = payment-guard-hold.
      </Text>

      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Heading as="h2">On hold</Heading>
          <Lozenge appearance={data.holds.length ? 'removed' : 'success'} isBold>
            {String(data.holds.length)}
          </Lozenge>
        </Inline>
        <DynamicTable
          head={{
            cells: [
              { key: 'issue', content: 'Work item' },
              { key: 'vendor', content: 'Vendor' },
              { key: 'reasons', content: 'Why' },
              { key: 'since', content: 'On hold since' },
            ],
          }}
          rows={data.holds.map((hold) => ({
            key: hold.issueKey,
            cells: [
              { key: 'issue', content: issueLink(hold.issueKey) },
              { key: 'vendor', content: hold.vendor || '' },
              { key: 'reasons', content: hold.reasons.map((r) => `[${r.code}] ${r.message}`).join(' ') },
              { key: 'since', content: formatTime(hold.heldAt) },
            ],
          }))}
          emptyView="Nothing is on hold."
        />
      </Stack>

      <Stack space="space.100">
        <Heading as="h2">Bank-account changes waiting for call-back</Heading>
        <DynamicTable
          head={{
            cells: [
              { key: 'issue', content: 'Work item' },
              { key: 'vendor', content: 'Vendor' },
              { key: 'account', content: 'New account' },
              { key: 'by', content: 'Requested by' },
              { key: 'at', content: 'Requested' },
            ],
          }}
          rows={data.pendingChanges.map((change) => ({
            key: change.issueKey,
            cells: [
              { key: 'issue', content: issueLink(change.issueKey) },
              { key: 'vendor', content: change.vendor },
              { key: 'account', content: change.newAccount },
              { key: 'by', content: change.requestedBy ? <User accountId={change.requestedBy} /> : '' },
              { key: 'at', content: formatTime(change.requestedAt) },
            ],
          }))}
          emptyView="No unverified changes."
        />
      </Stack>

      <Stack space="space.100">
        <Heading as="h2">Released holds (who released and why)</Heading>
        <DynamicTable
          head={{
            cells: [
              { key: 'issue', content: 'Work item' },
              { key: 'codes', content: 'Rules' },
              { key: 'by', content: 'Released by' },
              { key: 'reason', content: 'Reason' },
              { key: 'at', content: 'When' },
              { key: 'now', content: 'Now' },
            ],
          }}
          rows={data.released.map((release) => ({
            key: `${release.issueKey}-${release.releasedAt}`,
            cells: [
              { key: 'issue', content: issueLink(release.issueKey) },
              { key: 'codes', content: (release.codes || []).join(', ') },
              { key: 'by', content: release.releasedBy ? <User accountId={release.releasedBy} /> : '' },
              { key: 'reason', content: release.releaseReason },
              { key: 'at', content: formatTime(release.releasedAt) },
              {
                key: 'now',
                content: (
                  <Lozenge appearance={release.nowStatus === 'held' ? 'removed' : release.nowStatus === 'clear' ? 'success' : 'moved'}>
                    {release.nowStatus === 'held' ? 'ON HOLD AGAIN' : release.nowStatus === 'clear' ? 'CLEAR' : 'RELEASED'}
                  </Lozenge>
                ),
              },
            ],
          }))}
          emptyView="No holds have been released."
        />
      </Stack>

      <Stack space="space.100">
        <Heading as="h2">Settings</Heading>
        <SectionMessage appearance="information">
          <Text>Only Jira administrators can change these.</Text>
        </SectionMessage>
        <Settings initial={data.settings} onSaved={load} />
      </Stack>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
