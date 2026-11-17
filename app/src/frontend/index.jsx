/**
 * Payment Guard — work item panel (UI Kit).
 *
 * Shows the guard decision for this work item and lets the accounts-payable
 * clerk record invoice data, record / verify a vendor bank-account change,
 * release a hold with a written reason, and read the audit trail.
 * All decisions are made in the backend (src/resolvers) — this file only
 * collects input and displays results.
 */
import React, { useEffect, useState, useCallback } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  DatePicker,
  DynamicTable,
  Inline,
  Label,
  Link,
  List,
  ListItem,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
  User,
  ErrorMessage,
  HelperMessage,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((code) => ({ label: code, value: code }));
const EMPTY_INVOICE = { vendor: '', invoiceNo: '', amount: '', currency: 'USD', invoiceDate: '', bankAccount: '' };

const formatTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

/** Links each related work item key to its page. */
const RelatedKeys = ({ keys }) =>
  keys && keys.length > 0 ? (
    <Inline space="space.050">
      <Text>See:</Text>
      {keys.map((key) => (
        <Link key={key} href={`/browse/${key}`}>
          {key}
        </Link>
      ))}
    </Inline>
  ) : null;

/** The decision banner at the top of the panel. */
const Decision = ({ hold, bankChange }) => {
  if (!hold && bankChange) {
    // A bank-change request is not an invoice; its status is shown in the Bank change tab.
    return (
      <SectionMessage appearance={bankChange.verifiedAt ? 'success' : 'error'} title="Vendor bank-account change request">
        <Text>
          {bankChange.verifiedAt
            ? 'Verified by call-back. See the Bank change tab.'
            : 'Not verified yet — every payment to this vendor is on hold. See the Bank change tab.'}
        </Text>
      </SectionMessage>
    );
  }
  if (!hold) {
    return (
      <SectionMessage appearance="information" title="No invoice recorded yet">
        <Text>Record the invoice below. Payment Guard checks it before anyone pays it.</Text>
      </SectionMessage>
    );
  }
  if (hold.status === 'clear') {
    return (
      <SectionMessage appearance="success" title="CLEAR — all checks pass">
        <Text>Last checked {formatTime(hold.checkedAt)}.</Text>
      </SectionMessage>
    );
  }
  if (hold.status === 'released') {
    return (
      <SectionMessage appearance="warning" title="Hold released by a person">
        <Inline space="space.050">
          <Text>Released by</Text>
          <User accountId={hold.releasedBy} />
          <Text>on {formatTime(hold.releasedAt)}.</Text>
        </Inline>
        <Text>Reason: {hold.releaseReason}</Text>
      </SectionMessage>
    );
  }
  return (
    <SectionMessage appearance="error" title="ON HOLD — do not pay this invoice yet">
      <List type="unordered">
        {hold.reasons.map((reason, index) => (
          <ListItem key={`${reason.code}-${index}`}>
            <Stack space="space.050">
              <Inline space="space.075" alignBlock="start">
                <Lozenge appearance="removed">{reason.code}</Lozenge>
                <Text>{reason.message}</Text>
              </Inline>
              <RelatedKeys keys={reason.relatedKeys} />
            </Stack>
          </ListItem>
        ))}
      </List>
    </SectionMessage>
  );
};

/** A modal asking for a written reason / call-back note before an action. */
const ReasonModal = ({ title, helper, actionLabel, onClose, onSubmit }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    const result = await onSubmit(text);
    setBusy(false);
    if (result?.error) setError(result.error);
    else onClose();
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{title}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.100">
          <Label labelFor="pg-reason">Written reason (kept in the audit trail and posted as a comment)</Label>
          <TextArea id="pg-reason" onChange={(e) => setText(e.target.value)} />
          <HelperMessage>{helper}</HelperMessage>
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <ButtonGroup>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          {/* Always clickable: the backend checks the length and returns a clear error.
              Disabling on length made the first click get lost while state caught up. */}
          <Button appearance="warning" isDisabled={busy} onClick={submit}>
            {actionLabel}
          </Button>
        </ButtonGroup>
      </ModalFooter>
    </Modal>
  );
};

/**
 * One labelled text input. Uncontrolled (defaultValue) on purpose: in UI Kit a
 * controlled `value` round-trips through the bridge on every keystroke and
 * drops characters when people type fast (seen in testing on 2026-11-14).
 */
const Field = ({ id, label, value, onChange, placeholder }) => (
  <Stack space="space.050">
    <Label labelFor={id}>{label}</Label>
    <Textfield id={id} defaultValue={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </Stack>
);

const InvoiceForm = ({ initial, onSaved }) => {
  const [invoice, setInvoice] = useState({ ...EMPTY_INVOICE, ...(initial || {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field) => (value) => setInvoice((current) => ({ ...current, [field]: value }));
  const save = async () => {
    setBusy(true);
    setError('');
    const result = await invoke('saveInvoice', invoice);
    setBusy(false);
    if (result?.error) setError(result.error);
    else onSaved();
  };
  return (
    <Stack space="space.150">
      <Field id="pg-vendor" label="Vendor" value={invoice.vendor} onChange={set('vendor')} placeholder="e.g. Acme Supplies Inc." />
      <Field id="pg-number" label="Invoice number" value={invoice.invoiceNo} onChange={set('invoiceNo')} placeholder="e.g. INV-0042" />
      <Inline space="space.100" alignBlock="end">
        <Field id="pg-amount" label="Amount" value={invoice.amount} onChange={set('amount')} placeholder="e.g. 1200.00" />
        <Stack space="space.050">
          <Label labelFor="pg-currency">Currency</Label>
          <Select
            inputId="pg-currency"
            options={CURRENCIES}
            value={CURRENCIES.find((option) => option.value === invoice.currency)}
            onChange={(option) => set('currency')(option?.value || '')}
          />
        </Stack>
      </Inline>
      <Stack space="space.050">
        <Label labelFor="pg-date">Invoice date</Label>
        <DatePicker id="pg-date" value={invoice.invoiceDate} onChange={(value) => set('invoiceDate')(value || '')} />
      </Stack>
      <Field
        id="pg-account"
        label="Pay to bank account (IBAN / account number)"
        value={invoice.bankAccount}
        onChange={set('bankAccount')}
        placeholder="e.g. GB29 NWBK 6016 1331 9268 19"
      />
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Box>
        <Button appearance="primary" isDisabled={busy} onClick={save}>
          {busy ? 'Checking…' : initial ? 'Update and re-check' : 'Save and check'}
        </Button>
      </Box>
    </Stack>
  );
};

const BankChange = ({ change, onSaved, openVerify }) => {
  const [vendor, setVendor] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (change) {
    return (
      <Stack space="space.100">
        <Text>
          Vendor: <Strong>{change.vendor}</Strong> — new account {change.newAccountMasked}
        </Text>
        {change.verifiedAt ? (
          <SectionMessage appearance="success" title="Verified by call-back">
            <Inline space="space.050">
              <Text>By</Text>
              <User accountId={change.verifiedBy} />
              <Text>on {formatTime(change.verifiedAt)}. Note: {change.note}</Text>
            </Inline>
          </SectionMessage>
        ) : (
          <SectionMessage appearance="error" title="Not verified — all payments to this vendor are on hold">
            <Text>
              Call the vendor on a phone number already on file (never one from this request) and confirm the new account.
            </Text>
            <Box>
              <Button appearance="primary" onClick={openVerify}>
                I called the vendor — verify change
              </Button>
            </Box>
          </SectionMessage>
        )}
      </Stack>
    );
  }
  const save = async () => {
    setBusy(true);
    setError('');
    const result = await invoke('saveBankChange', { vendor, newAccount: account });
    setBusy(false);
    if (result?.error) setError(result.error);
    else onSaved();
  };
  return (
    <Stack space="space.150">
      <Text>Use this tab when the work item is a request to change where a vendor gets paid.</Text>
      <Field id="pg-chg-vendor" label="Vendor" value={vendor} onChange={setVendor} placeholder="e.g. Acme Supplies Inc." />
      <Field id="pg-chg-account" label="New bank account" value={account} onChange={setAccount} placeholder="e.g. DE89 3704 0044 0532 0130 00" />
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Box>
        {/* Always clickable; the backend reports missing fields (see ReasonModal). */}
        <Button appearance="primary" isDisabled={busy} onClick={save}>
          Record change request and hold payments
        </Button>
      </Box>
    </Stack>
  );
};

const AUDIT_LABELS = {
  'invoice-recorded': 'Invoice recorded',
  'invoice-updated': 'Invoice updated',
  check: 'Checked',
  release: 'Hold released',
  'verify-bank': 'Bank account verified',
  'bank-change-requested': 'Bank change requested',
  'auto-lift': 'Hold lifted automatically',
};

const History = ({ audit }) => (
  <DynamicTable
    head={{
      cells: [
        { key: 'time', content: 'When' },
        { key: 'what', content: 'What' },
        { key: 'who', content: 'Who' },
        { key: 'detail', content: 'Detail' },
      ],
    }}
    rows={[...audit].reverse().map((entry, index) => ({
      key: `a-${index}`,
      cells: [
        { key: 'time', content: formatTime(entry.at) },
        { key: 'what', content: AUDIT_LABELS[entry.type] || entry.type },
        { key: 'who', content: entry.by ? <User accountId={entry.by} /> : 'Payment Guard (automatic)' },
        {
          key: 'detail',
          content: [entry.status, entry.codes?.join(', '), entry.reason, entry.note, entry.account, entry.trigger]
            .filter(Boolean)
            .join(' · '),
        },
      ],
    }))}
    emptyView="No activity yet."
  />
);

const App = () => {
  const [state, setState] = useState(null);
  const [modal, setModal] = useState(null); // 'release' | 'verifyInvoice' | 'verifyChange'
  const [message, setMessage] = useState('');

  const load = useCallback(async () => setState(await invoke('getState')), []);
  useEffect(() => {
    load();
  }, [load]);

  if (!state) return <Spinner label="Loading Payment Guard" />;

  const { hold, invoice, bankChange, verifiedBank, audit } = state;
  const needsFirstVerification = hold?.status === 'held' && hold.reasons.some((r) => r.code === 'B1') && !verifiedBank;

  const recheck = async () => {
    setMessage('');
    const result = await invoke('recheck');
    if (result?.error) setMessage(result.error);
    await load();
  };

  return (
    <Stack space="space.200">
      <Inline spread="space-between" alignBlock="center">
        <Text>Checks this invoice before anyone pays it.</Text>
        {hold ? (
          <Lozenge appearance={hold.status === 'held' ? 'removed' : hold.status === 'clear' ? 'success' : 'moved'} isBold>
            {hold.status === 'held' ? 'ON HOLD' : hold.status === 'clear' ? 'CLEAR' : 'RELEASED'}
          </Lozenge>
        ) : null}
      </Inline>

      <Decision hold={hold} bankChange={bankChange} />
      {hold || bankChange ? (
        <Text>
          The decision is also written to this work item as the label payment-guard-hold and a comment (reload the page to
          see them).
        </Text>
      ) : null}
      {message ? <Text>{message}</Text> : null}

      {invoice ? (
        <ButtonGroup>
          <Button onClick={recheck}>Re-check</Button>
          {needsFirstVerification ? (
            <Button appearance="primary" onClick={() => setModal('verifyInvoice')}>
              I called the vendor — verify bank account
            </Button>
          ) : null}
          {hold?.status === 'held' ? (
            <Button appearance="warning" onClick={() => setModal('release')}>
              Release hold…
            </Button>
          ) : null}
        </ButtonGroup>
      ) : null}

      <Tabs id="pg-tabs">
        <TabList>
          <Tab>Invoice</Tab>
          <Tab>Bank change</Tab>
          <Tab>History</Tab>
        </TabList>
        <TabPanel>
          <Box paddingBlock="space.150">
            {invoice?.source === 'auto' ? (
              <SectionMessage appearance="information" title="Read automatically from this work item">
                <Text>Payment Guard found these invoice details in the description. Check them, correct anything wrong, then update.</Text>
              </SectionMessage>
            ) : null}
            {verifiedBank ? (
              <Text>
                Verified account on record for this vendor: {verifiedBank.account} (since {formatTime(verifiedBank.verifiedAt)})
              </Text>
            ) : null}
            <InvoiceForm initial={invoice} onSaved={load} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.150">
            <BankChange change={bankChange} onSaved={load} openVerify={() => setModal('verifyChange')} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.150">
            <History audit={audit} />
          </Box>
        </TabPanel>
      </Tabs>

      <ModalTransition>
        {modal === 'release' ? (
          <ReasonModal
            title="Release hold and allow payment"
            helper="Explain why paying is safe (at least 10 characters). Your name and reason are recorded."
            actionLabel="Release hold"
            onClose={() => setModal(null)}
            onSubmit={async (reason) => {
              const result = await invoke('releaseHold', { reason });
              if (!result?.error) await load();
              return result;
            }}
          />
        ) : null}
        {modal === 'verifyInvoice' ? (
          <ReasonModal
            title="Verify vendor bank account by call-back"
            helper="Who did you call, on which number already on file, and what did they confirm?"
            actionLabel="Mark as verified"
            onClose={() => setModal(null)}
            onSubmit={async (note) => {
              const result = await invoke('verifyInvoiceBank', { note });
              if (!result?.error) await load();
              return result;
            }}
          />
        ) : null}
        {modal === 'verifyChange' ? (
          <ReasonModal
            title="Verify bank-account change by call-back"
            helper="Who did you call, on which number already on file, and what did they confirm?"
            actionLabel="Verify change"
            onClose={() => setModal(null)}
            onSubmit={async (note) => {
              const result = await invoke('verifyBankChange', { note });
              if (!result?.error) await load();
              return result;
            }}
          />
        ) : null}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
