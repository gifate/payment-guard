/**
 * Payment Guard — compact view in the work item's details column.
 * Read-only summary; all actions live in the Payment Guard panel.
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Inline, List, ListItem, Lozenge, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const [state, setState] = useState(null);
  useEffect(() => {
    invoke('getState').then(setState);
  }, []);
  if (!state) return <Spinner label="Loading" />;
  const { hold, bankChange } = state;
  if (!hold && !bankChange) {
    return <Text>No invoice recorded. Open the Payment Guard panel to record one.</Text>;
  }
  if (!hold && bankChange) {
    return (
      <Text>
        Bank-account change for {bankChange.vendor}: {bankChange.verifiedAt ? 'verified by call-back.' : 'waiting for call-back — payments to this vendor are on hold.'}
      </Text>
    );
  }
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={hold.status === 'held' ? 'removed' : hold.status === 'clear' ? 'success' : 'moved'} isBold>
          {hold.status === 'held' ? 'ON HOLD' : hold.status === 'clear' ? 'CLEAR' : 'RELEASED'}
        </Lozenge>
        <Text>{hold.vendor}</Text>
      </Inline>
      {hold.status === 'held' ? (
        <List type="unordered">
          {hold.reasons.map((reason, index) => (
            <ListItem key={`${reason.code}-${index}`}>
              <Text>
                [{reason.code}] {reason.message}
              </Text>
            </ListItem>
          ))}
        </List>
      ) : null}
      {hold.status === 'released' ? <Text>Released with reason: {hold.releaseReason}</Text> : null}
      <Text>Open the Payment Guard panel to act.</Text>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
