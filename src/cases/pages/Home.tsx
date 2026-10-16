import { useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { ArrowForwardRounded, FolderOpenRounded } from '@mui/icons-material';
import { api, RequestError, type CheckResult, type Config } from '../api';
import { Dropzone } from '../components/Dropzone';
import { Flow } from '../components/Flow';
import { IdentityLine } from '../components/Identity';
import { casePath, formatBytes, mediaLabel, normalizeCaseNumber, shortHex } from '../format';

type Notice = { severity: 'success' | 'info' | 'warning'; message: string };
interface Props { config: Config | null; navigate: (path: string, notice?: Notice) => void; copy: (value: string, what?: string) => void }

export function Home({ config, navigate, copy }: Props) {
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [opening, setOpening] = useState(false);
  const controller = useRef<AbortController | null>(null);

  function find() {
    const number = normalizeCaseNumber(query);
    if (!number) { setQueryError('That doesn’t look like a case number. They look like VC-XXXX-XXXX-XXXX.'); return; }
    setQueryError('');
    navigate(casePath(number));
  }
  async function check(file: File) {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setResult(null);
    try {
      const value = await api.check(file, abort.signal);
      if (abort.signal.aborted) return;
      if (value.cases.length === 1) { navigate(casePath(value.cases[0]), { severity: 'success', message: 'Found it. This is the image that case is about.' }); return; }
      setResult(value);
    } catch (err) { if (!abort.signal.aborted) setError((err as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  async function openCase() {
    if (!result?.ticket || opening) return;
    setOpening(true); setError('');
    try {
      const created = await api.fromTicket(result.ticket.id);
      navigate(casePath(created.number), { severity: 'info', message: 'Your case is ready. Say who owns it and sign to open it.' });
    } catch (err) {
      setOpening(false);
      setError(err instanceof RequestError && err.code === 'TICKET_EXPIRED' ? 'That check has expired. Drop the file again and we’ll start over.' : (err as Error).message);
    }
  }

  return <Stack gap={2.5}>
    <Box className="cases-hero">
      <Box className="reveal">
        <div className="intro-label" style={{ marginBottom: 12 }}>Cases · beta</div>
        <Typography variant="h1">Who’s looking after this scan?</Typography>
        <p className="cases-lede">Open a case for an image, hand it to a colleague, and get a signed answer back. Every step is signed in Verus Mobile, so the record stands on its own.</p>
        <Stack direction="row" gap={1.5} flexWrap="wrap" sx={{ mt: 3 }}>
          <Button variant="contained" onClick={() => navigate('/cases/new')} endIcon={<ArrowForwardRounded sx={{ fontSize: 18 }} />}>Open a case</Button>
          <Button color="inherit" href="#find" sx={{ color: 'text.secondary' }}>Find one</Button>
        </Stack>
      </Box>
      <Box className="panel reveal" sx={{ '--delay': '120ms' } as React.CSSProperties}>
        <div className="panel-label">How a case moves</div>
        <Flow animate orientation="stacked" />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Each stage is a signature from the person it concerns. Declining or handing over keeps the trail intact.</Typography>
      </Box>
    </Box>

    <Box className="cases-grid" id="find">
      <Box className="panel reveal" sx={{ '--delay': '200ms' } as React.CSSProperties}>
        <div className="step-label">Have a case number?</div>
        <Typography variant="h2" sx={{ mb: 2 }}>Find a case</Typography>
        <Box component="form" onSubmit={event => { event.preventDefault(); find(); }} sx={{ display: 'flex', gap: 1, flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'flex-start' } }}>
          <TextField fullWidth label="Case number" placeholder="VC-" value={query} error={!!queryError} helperText={queryError || ' '} autoComplete="off"
            inputProps={{ 'aria-label': 'Case number', spellCheck: false, style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.08em', textTransform: 'uppercase' } }}
            onChange={event => { setQuery(event.target.value); if (queryError) setQueryError(''); }} />
          <Button type="submit" variant="outlined" sx={{ minHeight: 56, px: 3 }}>Open</Button>
        </Box>
        <Typography variant="body2" color="text.secondary">The number is the key to the case. Share it with the people who should follow along, and only them.</Typography>
      </Box>

      <Box className="panel reveal" sx={{ '--delay': '260ms' } as React.CSSProperties}>
        <div className="step-label">No number to hand?</div>
        <Typography variant="h2" sx={{ mb: 2 }}>Drop the image instead</Typography>
        <Dropzone compact label="Drop an image to find its case" title="Drop the image here" onFile={file => void check(file)} onReject={setError}
          busy={busy} busyText="Taking its fingerprint…" maxBytes={config?.maxUploadBytes} hint={`We match it by fingerprint and keep nothing${config ? ` · up to ${formatBytes(config.maxUploadBytes)}` : ''}`} />
        {error && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {result && <Box className="inset reveal" role="status" sx={{ mt: 2 }}>
          <Typography variant="body2"><strong>{mediaLabel(result.artifact.mediaType)}</strong> · {formatBytes(result.artifact.bytes)}{result.artifact.width ? ` · ${result.artifact.width} × ${result.artifact.height}` : ''}</Typography>
          <Typography variant="caption" className="mono" color="text.secondary" sx={{ display: 'block' }}>sha-256 {shortHex(result.artifact.digest, 24)}</Typography>
          {result.cases.length > 1 && <Box sx={{ mt: 1.5 }}><Typography variant="body2">This exact file belongs to more than one case:</Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>{result.cases.map(number => <Chip key={number} label={number} onClick={() => navigate(casePath(number))} className="mono" />)}</Stack></Box>}
          {result.cases.length === 0 && <Box sx={{ mt: 1.5 }}>
            <Typography sx={{ fontWeight: 600 }}>No case has this file yet</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Cases are tied to the exact file. A re-saved or edited copy won’t match, so check that this is the original.</Typography>
            {result.derivative?.identity && <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid var(--separator)' }}>
              <Typography variant="body2" sx={{ mb: .5 }}>{result.derivative.message}</Typography>
              <IdentityLine identity={result.derivative.identity} copy={copy} compact />
            </Box>}
            {result.ticket && <Button variant="contained" onClick={() => void openCase()} disabled={opening} startIcon={opening ? <CircularProgress size={16} color="inherit" /> : <FolderOpenRounded />} sx={{ mt: 2 }}>{opening ? 'Opening…' : 'Open a case for it'}</Button>}
          </Box>}
        </Box>}
      </Box>
    </Box>

    <Box className="cases-grid">
      <Box className="panel reveal" sx={{ '--delay': '320ms' } as React.CSSProperties}>
        <Typography variant="h3">What a case tells you</Typography>
        <ol className="instruction-list" style={{ marginTop: 16 }}>
          {[['Who asked whom', 'The owner names the reviewer and signs the request. A deadline can go on it.'], ['Whether they said yes', 'The reviewer accepts or declines in their own signature. Nothing is assumed from a notification or an open tab.'], ['When it was done', 'The reviewer signs that the review is complete under the case policy. Diagnosis and reports stay in the clinical record.']].map(([title, body], index) =>
            <li key={title}><span className="step-number" aria-hidden="true">{index + 1}</span><Box><Typography variant="body2" fontWeight={600}>{title}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .25 }}>{body}</Typography></Box></li>)}
        </ol>
      </Box>
      <Box className="panel reveal" sx={{ '--delay': '380ms' } as React.CSSProperties}>
        <Typography variant="h3">What it doesn’t</Typography>
        <Stack gap={1.2} sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary">It can’t tell you that someone looked carefully, understood the image or got it right. Only that they signed for the step.</Typography>
          <Typography variant="body2" color="text.secondary">A VerusID isn’t a licence. Who may review what is still a decision for your organisation.</Typography>
          <Typography variant="body2" color="text.secondary">No patient details go in. A case holds a fingerprint of the file, the identities, the times and the policy. Nothing else.</Typography>
        </Stack>
      </Box>
    </Box>
  </Stack>;
}
