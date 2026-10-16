import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, CircularProgress, FormControl, FormControlLabel, IconButton,
  Radio, RadioGroup, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  ArrowBackRounded, AssignmentIndRounded, AssignmentTurnedInRounded, BlockRounded, ContentCopyRounded, DownloadRounded, ExpandMoreRounded,
  FolderOpenRounded, LinkRounded, LockOpenRounded, LockRounded, RefreshRounded, TaskAltRounded, UndoRounded, WarningAmberRounded,
} from '@mui/icons-material';
import { api, RequestError, type AllowedStep, type CaseStatus, type CaseView, type Config, type EventType, type IdentityRef, type StepInput } from '../api';
import { Dropzone } from '../components/Dropzone';
import { Flow } from '../components/Flow';
import { Identicon } from '../components/Identicon';
import { Party } from '../components/Identity';
import { Timeline } from '../components/Timeline';
import { WalletStep } from '../components/WalletStep';
import { casePath, formatBytes, formatTime, mediaLabel, shortHex } from '../format';

type Notice = { severity: 'success' | 'info' | 'warning'; message: string };
interface Props { number: string; config: Config | null; navigate: (path: string, notice?: Notice) => void; copy: (value: string, what?: string) => void; toast: (message: string) => void }

const statusLabel: Record<CaseStatus, { text: string; kind: '' | 'is-live' | 'is-done' | 'is-warn' }> = {
  draft: { text: 'Not opened yet', kind: '' }, open: { text: 'Open, no reviewer', kind: 'is-live' }, assigned: { text: 'Waiting for the reviewer', kind: 'is-live' },
  rejected: { text: 'Declined, no reviewer', kind: 'is-warn' }, accepted: { text: 'In review', kind: 'is-live' }, completed: { text: 'Review done', kind: 'is-done' },
  closed: { text: 'Closed', kind: '' }, reopened: { text: 'Reopened, no reviewer', kind: 'is-live' },
};
const stepCopy: Record<EventType, { label: string; title: (signer: string, to?: string) => string; description: string }> = {
  CASE_CREATED: { label: 'Opening the case', title: s => `${s} opens the case`, description: 'Signing this makes them the owner. The owner assigns reviewers and closes the case.' },
  TASK_ASSIGNED: { label: 'Assigning a reviewer', title: (s, to) => `${s} asks ${to} to review`, description: 'The request is signed by the person making it. The reviewer answers with a signature of their own.' },
  TASK_ACCEPTED: { label: 'Accepting', title: s => `${s} accepts the review`, description: 'From this signature until they finish or hand it on, the review is theirs.' },
  TASK_REJECTED: { label: 'Declining', title: s => `${s} declines the review`, description: 'The case goes back to where it was before the request.' },
  TASK_WITHDRAWN: { label: 'Taking the request back', title: (s, to) => `${s} withdraws the request to ${to}`, description: 'Use this when a request has gone unanswered. Nothing else changes.' },
  REVIEW_COMPLETED: { label: 'Signing off', title: s => `${s} signs the review as complete`, description: 'This says the review they accepted is done. It doesn’t carry findings or a diagnosis; those belong in the clinical record.' },
  CASE_CLOSED: { label: 'Closing', title: s => `${s} closes the case`, description: 'The owner wraps the case up. It can be reopened later.' },
  CASE_REOPENED: { label: 'Reopening', title: s => `${s} reopens the case`, description: 'Earlier steps keep their meaning; new ones follow.' },
};
const actionCopy: Record<EventType, { label: string; icon: ReactElement; primary: boolean }> = {
  CASE_CREATED: { label: 'Open the case', icon: <FolderOpenRounded />, primary: true },
  TASK_ASSIGNED: { label: 'Assign a reviewer', icon: <AssignmentIndRounded />, primary: true },
  TASK_ACCEPTED: { label: 'Accept', icon: <AssignmentTurnedInRounded />, primary: true },
  TASK_REJECTED: { label: 'Decline', icon: <BlockRounded />, primary: false },
  TASK_WITHDRAWN: { label: 'Take the request back', icon: <UndoRounded />, primary: false },
  REVIEW_COMPLETED: { label: 'Mark the review done', icon: <TaskAltRounded />, primary: true },
  CASE_CLOSED: { label: 'Close the case', icon: <LockRounded />, primary: false },
  CASE_REOPENED: { label: 'Reopen the case', icon: <LockOpenRounded />, primary: false },
};
const signersOf = (step: AllowedStep): IdentityRef[] => step.signers === 'any' ? [] : step.signers;
const whoSigns = (step: AllowedStep) => step.signers === 'any' ? 'the owner you name' : signersOf(step).map(w => w.name).join(' or ');

export function CasePage({ number, config, navigate, copy, toast }: Props) {
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState<EventType | null>(null);
  const [identity, setIdentity] = useState('');
  const [deadline, setDeadline] = useState('');
  const [actor, setActor] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<'match' | 'different' | null>(null);
  const [checkError, setCheckError] = useState('');
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const value = await api.case(number, signal);
      if (signal?.aborted || generation.current !== current) return;
      setView(value); setError(''); setPollError('');
    } catch (err) {
      if (signal?.aborted || generation.current !== current) return;
      if (err instanceof RequestError && err.status === 404) { setError(err.message); setView(null); }
      else setPollError(`Lost the connection for a moment. Trying again. ${(err as Error).message}`);
    } finally { if (!signal?.aborted && generation.current === current) setLoading(false); }
  }, [number]);
  useEffect(() => { const abort = new AbortController(); setLoading(true); setView(null); setError(''); setForm(null); void load(abort.signal); return () => abort.abort(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const interval = view?.pending ? 2500 : view ? 20_000 : 0;
    if (!interval) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => void load(abort.signal), interval);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [view?.pending?.id, view?.updatedAt, load]);

  function startStep(type: EventType) {
    setForm(type); setFormError(''); setIdentity(''); setDeadline('');
    const step = view?.actions.find(a => a.type === type);
    setActor(step && step.signers !== 'any' && step.signers.length === 1 ? step.signers[0].id : '');
  }
  async function submitStep(type: EventType, input: Omit<StepInput, 'type'> = {}) {
    if (!view || submitting) return;
    setSubmitting(true); setFormError('');
    try {
      setView(await api.step(view.number, { type, ...input }));
      setForm(null);
      toast('Ready to sign. It counts once the right person signs it.');
    } catch (err) { setFormError((err as Error).message); if (!form) toast((err as Error).message); }
    finally { setSubmitting(false); }
  }
  async function withdraw() {
    if (!view?.pending) return;
    try { setView(await api.withdrawStep(view.number)); } catch (err) { toast((err as Error).message); }
  }
  async function checkCopy(file: File) {
    setCheckBusy(true); setCheckError(''); setCheckResult(null);
    try {
      const result = await api.check(file);
      setCheckResult(result.artifact.digest === view?.artifact.digest ? 'match' : 'different');
    } catch (err) { setCheckError((err as Error).message); }
    finally { setCheckBusy(false); }
  }
  async function exportRecord() {
    if (!view?.exportUrl || exporting) return;
    setExporting(true);
    try {
      const response = await fetch(view.exportUrl, { credentials: 'same-origin' });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message || `The record could not be exported (${response.status}).`); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `${view.number}.json`;
      try { document.body.appendChild(link); link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (err) { toast((err as Error).message); }
    finally { setExporting(false); }
  }

  if (loading && !view) return <Stack alignItems="center" sx={{ py: 10 }} role="status"><CircularProgress /><Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>Opening {number}…</Typography></Stack>;
  if (!view) return <Stack gap={2} sx={{ maxWidth: 560 }} role="status" className="reveal">
    <Box className="status-symbol" sx={{ color: 'var(--warning)', bgcolor: 'var(--warning-soft)' }}><WarningAmberRounded /></Box>
    <Typography variant="h2">No case under {number}</Typography>
    <Typography variant="body2" color="text.secondary">{error || 'Check the number, or drop the image on the Cases page to find it by fingerprint.'}</Typography>
    <Button variant="outlined" startIcon={<ArrowBackRounded />} onClick={() => navigate('/cases')} sx={{ alignSelf: 'flex-start' }}>Back to Cases</Button>
  </Stack>;

  const status = statusLabel[view.status];
  const pending = view.pending;
  const link = `${window.location.origin}${casePath(view.number)}`;
  const signingOff = !!config && !config.signing.enabled;
  const formStep = form ? view.actions.find(a => a.type === form) : undefined;
  const needsIdentity = form === 'CASE_CREATED' || form === 'TASK_ASSIGNED';
  const needsActorChoice = !!formStep && formStep.signers !== 'any' && formStep.signers.length > 1;
  const nextHeading = view.status === 'draft' ? 'Who owns this case?' : view.status === 'assigned' ? `Over to ${view.assignee?.name}` : view.status === 'accepted' ? `${view.responsible?.name} has the review` : view.status === 'closed' ? 'This case is closed' : 'Who should review it?';

  return <Stack gap={2.5}>
    <Button color="inherit" size="small" startIcon={<ArrowBackRounded />} onClick={() => navigate('/cases')} sx={{ alignSelf: 'flex-start', color: 'text.secondary', ml: -1 }}>Cases</Button>
    <Box className="workspace reveal">
      <Box className="workspace-toolbar" sx={{ flexWrap: 'wrap', rowGap: 1.5 }}>
        <Stack direction="row" gap={2} alignItems="center" sx={{ minWidth: 0, flex: '1 1 300px' }}>
          <Identicon seed={view.artifact.digest} size={52} title="Fingerprint glyph of the image" />
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" gap={.25} flexWrap="wrap">
              <Typography component="h1" className="case-number">{view.number}</Typography>
              <Tooltip title="Copy the number"><IconButton size="small" aria-label="Copy case number" onClick={() => copy(view.number, 'Case number')} sx={{ minWidth: 36, minHeight: 36 }}><ContentCopyRounded sx={{ fontSize: 16 }} /></IconButton></Tooltip>
              <Tooltip title="Copy a link"><IconButton size="small" aria-label="Copy case link" onClick={() => copy(link, 'Link')} sx={{ minWidth: 36, minHeight: 36 }}><LinkRounded sx={{ fontSize: 18 }} /></IconButton></Tooltip>
            </Stack>
            <Typography variant="caption" color="text.secondary">Opened {formatTime(view.createdAt)} · {view.events.length} signed {view.events.length === 1 ? 'step' : 'steps'}</Typography>
          </Box>
        </Stack>
        <Stack direction="row" gap={1.5} alignItems="center">
          <span className={`status-pill ${status.kind}`}><span className="dot" />{status.text}</span>
          <Tooltip title="Refresh"><IconButton aria-label="Refresh the case" onClick={() => void load()}><RefreshRounded /></IconButton></Tooltip>
        </Stack>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3.5 }, py: 2.5, borderBottom: '1px solid var(--separator)' }}><Flow status={view.status} /></Box>
      {pollError && <Alert severity="warning" sx={{ m: 2 }}>{pollError}</Alert>}

      <Box className="workspace-content">
        <Box className="image-editor">
          {pending ? <WalletStep stepLabel={stepCopy[pending.type].label} title={stepCopy[pending.type].title(pending.expectedSigner.name, pending.to?.name)} description={stepCopy[pending.type].description}
            walletUri={pending.walletUri} expiresAt={pending.expiresAt} signer={pending.expectedSigner} statement={pending.statement} responseMode={config?.responseMode} copy={copy}
            onWithdraw={pending.proposedHere ? () => void withdraw() : undefined} /> : <Stack gap={2}>
            <Box><div className="step-label">Next</div><Typography variant="h2">{nextHeading}</Typography></Box>
            {signingOff && <Alert severity="info">Nobody can sign yet: {config?.signing.reason || 'the service identity is not set up on this server.'}</Alert>}
            {!form ? <Stack direction="row" gap={1} flexWrap="wrap">
              {view.actions.map(step => <Tooltip key={step.type} title={`Signed by ${whoSigns(step)}`}>
                <span><Button variant={actionCopy[step.type].primary ? 'contained' : 'outlined'} startIcon={actionCopy[step.type].icon} disabled={signingOff || submitting}
                  onClick={() => { if (step.type === 'CASE_CREATED' || step.type === 'TASK_ASSIGNED' || (step.signers !== 'any' && step.signers.length > 1)) startStep(step.type); else void submitStep(step.type); }}>
                  {actionCopy[step.type].label}</Button></span>
              </Tooltip>)}
            </Stack> : <Box component="form" className="reveal" onSubmit={event => { event.preventDefault(); void submitStep(form, { actor: actor || (form === 'CASE_CREATED' ? identity.trim() : undefined), to: form === 'TASK_ASSIGNED' ? identity.trim() : undefined, deadline: deadline ? new Date(deadline).toISOString() : undefined }); }}>
              <Stack gap={2}>
                {needsIdentity && <TextField autoFocus fullWidth label={form === 'CASE_CREATED' ? 'Owner’s VerusID' : 'Reviewer’s VerusID'} placeholder="name@ or i-address" value={identity} autoComplete="off" inputProps={{ spellCheck: false }}
                  helperText={form === 'CASE_CREATED' ? 'They sign the opening statement and own the case.' : 'They’ll need to accept with exactly this identity.'} onChange={event => setIdentity(event.target.value)} />}
                {form === 'TASK_ASSIGNED' && <TextField fullWidth label="Needed by (optional)" type="datetime-local" value={deadline} InputLabelProps={{ shrink: true }} helperText="Goes into the signed request as a date. Not enforced." onChange={event => setDeadline(event.target.value)} />}
                {needsActorChoice && formStep && <FormControl><Typography variant="body2" fontWeight={600}>Who is signing this?</Typography>
                  <RadioGroup value={actor} onChange={event => setActor(event.target.value)}>{signersOf(formStep).map(who => <FormControlLabel key={who.id} value={who.id} control={<Radio size="small" />} label={`${who.name} (${who.id === view.owner?.id ? 'owner' : 'currently reviewing'})`} />)}</RadioGroup></FormControl>}
                {formError && <Alert severity="error" onClose={() => setFormError('')}>{formError}</Alert>}
                <Stack direction="row" gap={1}>
                  <Button type="submit" variant="contained" disabled={submitting || (needsIdentity && !identity.trim()) || (needsActorChoice && !actor)} startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : actionCopy[form].icon}>{submitting ? 'Preparing…' : 'Send for signing'}</Button>
                  <Button color="inherit" onClick={() => setForm(null)}>Cancel</Button>
                </Stack>
              </Stack>
            </Box>}
            {!form && formError && <Alert severity="error" onClose={() => setFormError('')}>{formError}</Alert>}
          </Stack>}
          <Box sx={{ mt: 4, pt: 3, borderTop: '1px solid var(--separator)' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 2.5 }}>
              <Typography variant="h2">History</Typography>
              <Typography variant="caption" color="text.secondary">latest <span className="mono">{shortHex(view.headHash, 10)}</span></Typography>
            </Stack>
            {view.events.length || pending ? <Timeline events={view.events} pending={pending} copy={copy} now={now} /> : <Typography variant="body2" color="text.secondary">Nothing signed yet. The history starts when the owner opens the case.</Typography>}
          </Box>
        </Box>

        <Box className="inspector">
          <Stack gap={3}>
            <Stack gap={2.5}>
              <Party role="Owner" identity={view.owner} copy={copy} note={view.owner ? undefined : 'Set when the case is opened'} />
              {view.assignee && <Party role="Asked to review" identity={view.assignee} copy={copy} note={view.openTask?.deadline ? `Needed by ${formatTime(view.openTask.deadline)}` : 'Hasn’t answered yet'} />}
              <Party role="Reviewing" identity={view.responsible} copy={copy} note={view.responsible ? (view.status === 'completed' ? 'Signed the review as done' : undefined) : 'Nobody has accepted a review yet'} />
            </Stack>
            <Box className="identity-details">
              <div className="panel-label">The image</div>
              <Typography variant="body2"><strong>{mediaLabel(view.artifact.mediaType)}</strong> · {formatBytes(view.artifact.bytes)}{view.artifact.width ? ` · ${view.artifact.width} × ${view.artifact.height}` : ''}</Typography>
              <Stack direction="row" alignItems="center" gap={.25}><Typography variant="caption" className="mono" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>sha-256 {view.artifact.digest}</Typography><Tooltip title="Copy fingerprint"><IconButton size="small" aria-label="Copy the file fingerprint" onClick={() => copy(view.artifact.digest, 'Fingerprint')} sx={{ minWidth: 36, minHeight: 36 }}><ContentCopyRounded sx={{ fontSize: 14 }} /></IconButton></Tooltip></Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>We keep this fingerprint, not the file.</Typography>
              <Dropzone compact label="Drop a copy of the image to check it is the same file" title="Check a copy" onFile={file => void checkCopy(file)} onReject={setCheckError} busy={checkBusy} busyText="Comparing…" maxBytes={config?.maxUploadBytes} hint="Byte for byte, nothing stored" />
              {checkError && <Alert severity="error" sx={{ mt: 1.5 }} onClose={() => setCheckError('')}>{checkError}</Alert>}
              {checkResult && <Alert severity={checkResult === 'match' ? 'success' : 'warning'} sx={{ mt: 1.5 }} onClose={() => setCheckResult(null)}>{checkResult === 'match' ? 'Same file, byte for byte.' : 'Not the same file. A re-save or an edit changes the fingerprint.'}</Alert>}
            </Box>
            <Box className="identity-details">
              <div className="panel-label">The record</div>
              <Typography variant="body2" color="text.secondary">Each step is signed over a statement that points at the one before it. Export the record and check it anywhere with <code className="mono">pnpm cases:verify</code>, no server needed.</Typography>
              <Button variant="outlined" fullWidth onClick={() => void exportRecord()} disabled={!view.exportUrl || exporting} startIcon={exporting ? <CircularProgress size={16} color="inherit" /> : <DownloadRounded />} sx={{ mt: 1.5 }}>{exporting ? 'Preparing…' : 'Export the record'}</Button>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.2 }}>{view.events[0]?.anchor.status === 'anchored' ? 'Steps are anchored on VRSCTEST.' : 'Steps aren’t on the Verus chain yet; this server has no anchoring set up, and we never say they are until they are.'}</Typography>
            </Box>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreRounded sx={{ fontSize: 20 }} />} sx={{ px: 0 }}><Typography variant="body2" color="text.secondary">Policy {view.policy.id} · {shortHex(view.policy.hash, 10)}</Typography></AccordionSummary>
              <AccordionDetails sx={{ px: 0, pt: 0 }}><pre className="statement" style={{ marginTop: 0 }}>{view.policy.text}</pre></AccordionDetails>
            </Accordion>
            {!!view.related.length && <Typography variant="caption" color="text.secondary">Other cases with this file: {view.related.map(other => <Chip key={other} size="small" label={other} onClick={() => navigate(casePath(other))} className="mono" sx={{ ml: .5 }} />)}</Typography>}
          </Stack>
        </Box>
      </Box>
    </Box>
  </Stack>;
}
