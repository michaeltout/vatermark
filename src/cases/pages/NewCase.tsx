import { useRef, useState } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/material';
import { api, type Config } from '../api';
import { Dropzone } from '../components/Dropzone';
import { casePath } from '../format';

type Notice = { severity: 'success' | 'info' | 'warning'; message: string };
interface Props { config: Config | null; navigate: (path: string, notice?: Notice) => void }

export function NewCase({ config, navigate }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  async function open(file: File) {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError('');
    try {
      const created = await api.open(file, abort.signal);
      if (abort.signal.aborted) return;
      navigate(casePath(created.number), { severity: 'info', message: `Case ${created.number} is ready. Say who owns it and sign to open it.` });
    } catch (err) {
      if (abort.signal.aborted) return;
      setError((err as Error).message); setBusy(false);
    }
  }

  return <Stack gap={2.5}>
    <Box className="intro reveal" sx={{ textAlign: { xs: 'left', sm: 'center' } }}>
      <div className="intro-label">New case</div>
      <Typography variant="h1">Start with the image.</Typography>
      <Typography color="text.secondary" sx={{ mt: 2, fontSize: { xs: '1rem', sm: '1.125rem' }, lineHeight: 1.6 }}>We take its fingerprint and let the file go. The original stays wherever you keep it.</Typography>
    </Box>
    <Box className="cases-grid-wide">
      <Box className="panel reveal" sx={{ '--delay': '100ms' } as React.CSSProperties}>
        <div className="step-label">Step 1 of 2</div>
        <Typography variant="h2" sx={{ mb: 2.5 }}>Choose the image</Typography>
        <Dropzone label="Drop the image to open a case" title="Drop the image here" onFile={file => void open(file)} onReject={setError}
          busy={busy} busyText="Taking its fingerprint and setting up the case…" maxBytes={config?.maxUploadBytes} hint="PNG, JPEG or DICOM · the file itself is not kept" />
        {error && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {config && !config.signing.enabled && <Alert severity="info" sx={{ mt: 2 }}><Typography variant="body2" fontWeight={600}>Signing isn’t set up on this server yet</Typography>{config.signing.reason || 'The service identity is not configured.'} You can open a case, but nobody can sign a step until <code>VATERMARK_SERVICE_ID</code>, <code>VATERMARK_SERVICE_WIF</code> and a reachable <code>PUBLIC_ORIGIN</code> are set.</Alert>}
      </Box>
      <Box className="panel reveal" sx={{ '--delay': '180ms' } as React.CSSProperties}>
        <Typography variant="h2">Then</Typography>
        <ol className="instruction-list" style={{ marginTop: 18 }}>
          {[['Name the owner', 'You type in a VerusID. That person signs the opening statement in Verus Mobile and owns the case from then on.'], ['Assign a reviewer', 'The owner names a colleague, with a deadline if they like, and signs the request.'], ['Get a signed answer', 'The reviewer accepts or declines with their own signature, and later signs off the review.']].map(([title, body], index) =>
            <li key={title}><span className="step-number" aria-hidden="true">{index + 1}</span><Box><Typography variant="body2" fontWeight={600}>{title}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .25 }}>{body}</Typography></Box></li>)}
        </ol>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2.5 }}>This is a testnet preview. Use test images rather than real patient scans; even a fingerprint can be linked back to a file.</Typography>
      </Box>
    </Box>
  </Stack>;
}
