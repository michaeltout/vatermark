import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button,
  CircularProgress, Container, IconButton, LinearProgress, Snackbar, Stack,
  Tab, Tabs, Tooltip, Typography,
} from '@mui/material';
import {
  ArrowForwardRounded, CheckCircleRounded, CloseRounded, CloudOffRounded,
  ContentCopyRounded, DownloadRounded, ExpandMoreRounded, FingerprintRounded,
  ImageOutlined, InfoOutlined, LockOutlined, OpenInNewRounded, QrCode2Rounded,
  RefreshRounded, ShieldOutlined, VerifiedOutlined,
  WarningAmberRounded,
} from '@mui/icons-material';
import QRCode from 'qrcode';
import { MetadataPanel, VerifiedImageDetails, type ImageDetails, type MetadataState, type VerifiedMetadata } from './Metadata';

import { GetStarted, type GiftConfig } from './GetStarted';

type Mode = 'verify' | 'sign';
type Identity = { id: string; name?: string; systemId?: string; signingHeight?: number; currentStatus?: string };
type Config = { gifts?: GiftConfig; network: string; signing: { enabled: boolean; reason?: string }; responseMode?: 'redirect' | 'post'; maxUploadBytes: number; maxPixels: number; metadata?: { enabled: boolean; maxBytes: number } };
type VerifyResult = {
  status: 'verified' | 'revoked' | 'unmarked' | 'invalid' | 'unsupported' | 'unavailable';
  message: string; identity?: Identity; verification?: Record<string, unknown>; previewUrl?: string;
  metadata?: VerifiedMetadata;
};
type Job = {
  id: string; status: 'preparing' | 'awaiting_signature' | 'finalizing' | 'complete' | 'failed' | 'expired' | 'cancelled';
  qrText?: string; walletUri?: string; expiresAt: string; previewUrl?: string;
  width?: number; height?: number; message?: string; identity?: Identity; downloadUrl?: string;
  metadata?: MetadataState;
};
const pending = (job: Job | null) => !!job && ['preparing', 'awaiting_signature', 'finalizing'].includes(job.status);
const pendingMetadata = (job: Job | null) => job?.status === 'complete' && !!job.metadata && ['preparing', 'awaiting_approval', 'submitted'].includes(job.metadata.status);
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function readWalletReturn() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('walletReturn') && !params.has('returnError') && !params.has('metadataReturn')) return null;
  const value = params.get('walletReturn') || '';
  return { id: /^[a-f0-9]{32}$/.test(value) ? value : null, error: params.get('returnError'), metadata: params.get('metadataReturn') === '1' };
}

function walletReturnError(code: string, metadata = false) {
  if (metadata) return ['EXPIRED', 'JOB_EXPIRED', 'METADATA_EXPIRED'].includes(code)
    ? 'This details update request has expired. Your signed image is still available.'
    : 'The details update response could not be accepted. Your image is still signed; you can retry this optional step.';
  switch (code) {
    case 'EXPIRED': case 'JOB_EXPIRED': return 'This signing request has expired. Create a new request to try again.';
    case 'CHAIN_UNAVAILABLE': case 'SERVICE_UNAVAILABLE': return 'The wallet response could not be checked while the chain service was unavailable. Scan the request again or create a new one.';
    default: return 'The wallet response could not be accepted. Check your signing request and try again.';
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, credentials: 'same-origin' });
  const data = await response.json().catch(() => null) as T & { error?: { message?: string } };
  if (!response.ok) throw new RequestError(data?.error?.message || `The request could not be completed (${response.status}). Please try again.`, response.status);
  return data;
}

function BrandMark() {
  return <Box component="svg" viewBox="0 0 40 40" aria-hidden="true" sx={{ width: 32, height: 32, color: 'text.primary', flexShrink: 0 }}>
    <rect width="40" height="40" rx="12" fill="currentColor" />
    <path d="M10 12l10 17 10-17M15 12l5 8 5-8" fill="none" stroke="var(--surface)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </Box>;
}

function UploadArtwork() {
  return <svg className="upload-art" viewBox="0 0 88 82" fill="none" aria-hidden="true">
    <rect x="12" y="8" width="56" height="58" rx="10" transform="rotate(-9 12 8)" fill="var(--surface-tertiary)" stroke="var(--separator)" />
    <rect x="22" y="15" width="56" height="58" rx="10" fill="var(--surface)" stroke="var(--border-strong)" />
    <circle cx="40" cy="33" r="5" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
    <path d="m29 61 14-15 9 8 8-11 11 18" stroke="var(--accent)" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx="74" cy="68" r="12" fill="var(--accent)" stroke="var(--surface)" strokeWidth="3" />
    <path d="M74 63v10m-5-5h10" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" />
  </svg>;
}

function IdentityDetails({ identity, copy }: { identity: Identity; copy: (value: string) => void }) {
  return <Box className="identity-details">
    <Typography variant="caption" color="text.secondary">Signing identity</Typography>
    <Typography variant="h3" sx={{ mt: .6, overflowWrap: 'anywhere' }}>{identity.name || 'Identity'}</Typography>
    <Stack direction="row" alignItems="center" gap={.5} sx={{ mt: .5 }}>
      <Typography variant="body2" sx={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', overflowWrap: 'anywhere', flex: 1, minWidth: 0, fontSize: '.8125rem' }}>{identity.id}</Typography>
      <Tooltip title="Copy identity address"><IconButton onClick={() => copy(identity.id)} aria-label="Copy identity address"><ContentCopyRounded sx={{ fontSize: 17 }} /></IconButton></Tooltip>
    </Stack>
    {identity.signingHeight !== undefined && <Typography variant="caption" color="text.secondary">Signed at block {identity.signingHeight.toLocaleString()}</Typography>}
  </Box>;
}

function Verification({ result, copy }: { result: VerifyResult; copy: (value: string) => void }) {
  const presentations = {
    verified: { title: 'Signature verified', color: 'var(--success)', background: 'var(--success-soft)', icon: <CheckCircleRounded /> },
    revoked: { title: 'Signer revoked', color: 'var(--warning)', background: 'var(--warning-soft)', icon: <WarningAmberRounded /> },
    unmarked: { title: 'No supported watermark recovered', color: 'var(--text-secondary)', background: 'var(--surface-tertiary)', icon: <InfoOutlined /> },
    invalid: { title: 'Authentication failed', color: 'var(--error)', background: 'var(--error-soft)', icon: <WarningAmberRounded /> },
    unsupported: { title: 'Unsupported image signature', color: 'var(--accent)', background: 'var(--accent-soft)', icon: <InfoOutlined /> },
    unavailable: { title: 'Could not verify', color: 'var(--warning)', background: 'var(--warning-soft)', icon: <CloudOffRounded /> },
  };
  const presentation = presentations[result.status];
  return <Stack gap={2.5}>
    <Box role="status">
      <Box className="status-symbol" sx={{ color: presentation.color, bgcolor: presentation.background, mb: 2.5 }}>{presentation.icon}</Box>
      <Typography variant="h2">{presentation.title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>{result.message}</Typography>
    </Box>
    {result.identity && <IdentityDetails identity={result.identity} copy={copy} />}
    {result.status === 'verified' && <Typography variant="body2" color="text.secondary">The image’s reconstructed fingerprint matches this identity’s signature.</Typography>}
    {result.status === 'unmarked' && <Typography variant="body2" color="text.secondary">A watermark may be absent, damaged, or use a different format.</Typography>}
    {result.status === 'unavailable' && <Typography variant="body2" color="text.secondary">The chain service could not supply the required data. This is not a failed signature check.</Typography>}
    {result.metadata && ['verified', 'revoked'].includes(result.status) && <VerifiedImageDetails metadata={result.metadata} />}
    <Typography variant="caption" color="text.secondary">Checked on VRSCTEST</Typography>
  </Stack>;
}

function WaitingForWallet({ job, cancel, responseMode }: { job: Job; cancel: () => void; responseMode?: Config['responseMode'] }) {
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [now, setNow] = useState(Date.now());
  const uri = job.walletUri || job.qrText || '';
  useEffect(() => {
    let mounted = true;
    setQr(''); setQrError('');
    if (uri) QRCode.toDataURL(uri, { width: 512, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#1d1d1f', light: '#ffffff' } })
      .then(value => { if (mounted) setQr(value); })
      .catch(() => { if (mounted) setQrError('The QR could not be displayed. Open the request in your wallet using the link below.'); });
    return () => { mounted = false; };
  }, [uri]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const remaining = Math.max(0, Math.ceil((new Date(job.expiresAt).getTime() - now) / 1000));
  return <Stack gap={2.2}>
    <Box><Typography component="p" className="step-label">Approve in Verus Mobile</Typography><Typography variant="h2">Scan with your wallet</Typography></Box>
    <Typography variant="body2" color="text.secondary">Choose your VRSCTEST identity and approve the signing request.</Typography>
    <Box className="qr-surface">
      {qr ? <Box component="img" src={qr} alt="QR code containing the wallet signing request" sx={{ width: '100%', display: 'block', imageRendering: 'pixelated' }} /> : qrError ? <QrCode2Rounded sx={{ color: '#626269', fontSize: 64 }} /> : <CircularProgress size={26} />}
    </Box>
    {qrError && <Alert severity="warning">{qrError}</Alert>}
    <Stack gap={.4} alignItems="center">
      <Stack direction="row" gap={1} alignItems="center" role="status"><CircularProgress size={12} thickness={5} /><Typography variant="body2">Waiting for approval</Typography></Stack>
      <Typography variant="caption" color="text.secondary" aria-live="off">{Number.isFinite(remaining) ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '15:00'} remaining</Typography>
    </Stack>
    {uri && <Button variant="contained" href={uri} endIcon={<OpenInNewRounded sx={{ fontSize: 17 }} />}>Open wallet</Button>}
    {responseMode !== 'post' && <Typography variant="body2" color="text.secondary">Your wallet opens a browser to return the signature. If you scan from another device, come back here to download your image.</Typography>}
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}><Typography variant="body2">Wallet setup</Typography></AccordionSummary>
      <AccordionDetails sx={{ px: 0, pt: 0 }}><Typography variant="body2" color="text.secondary">In Verus Mobile, enable <strong>experimental deeplinks</strong> in General settings. Use an identity linked to your testnet wallet.</Typography></AccordionDetails>
    </Accordion>
    <Button color="inherit" onClick={cancel}>Cancel request</Button>
  </Stack>;
}

function EmptyState({ mode, config, getStarted }: { mode: Mode; config: Config | null; getStarted: () => void }) {
  const steps = mode === 'verify'
    ? [['Choose an image', 'Use a signed PNG or JPEG.'], ['Read its signature', 'The watermark reveals the signing identity.'], ['See the result', 'We check the signature against identity records.']]
    : [['Choose your image', 'Use the image at its original dimensions.'], ['Approve in your wallet', 'Scan a QR and choose your signing identity.'], ['Keep your signed image', 'Download the PNG with its signature embedded.']];
  return <Stack gap={3}>
    <Box className="status-symbol">{mode === 'verify' ? <ShieldOutlined /> : <FingerprintRounded />}</Box>
    <Box><Typography variant="h2">{mode === 'verify' ? 'See who signed it.' : 'Your signature, embedded.'}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>{mode === 'verify' ? 'Check a signature using just the image. No original file or wallet needed.' : 'An invisible watermark connects your image to your identity.'}</Typography></Box>
    <ol className="instruction-list">{steps.map(([title, body], index) => <li key={title}><span className="step-number" aria-hidden="true">{index + 1}</span><Box><Typography variant="body2" fontWeight={600}>{title}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .25 }}>{body}</Typography></Box></li>)}</ol>
    {mode === 'sign' && <Box sx={{ pt: 2, borderTop: '1px solid var(--separator)' }}><Typography variant="body2" color="text.secondary">New to signing with an identity?</Typography><Button onClick={getStarted} size="small" endIcon={<ArrowForwardRounded sx={{ fontSize: 17 }} />} sx={{ ml: -2, mt: .2 }}>Get a test identity</Button></Box>}
    {mode === 'sign' && config && !config.signing.enabled && <Alert severity="info"><Typography variant="body2" fontWeight={600}>Signing needs server setup</Typography>{config.signing.reason || 'The service signing identity is not configured.'}<Accordion sx={{ mt: .5 }}><AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ p: 0 }}><Typography variant="body2">Local setup details</Typography></AccordionSummary><AccordionDetails sx={{ p: 0 }}><Typography variant="body2">Configure <code>VATERMARK_SERVICE_ID</code>, <code>VATERMARK_SERVICE_WIF</code>, and a wallet-reachable <code>PUBLIC_ORIGIN</code> on the server. The default <code>WALLET_RESPONSE_MODE=redirect</code> supports HTTP for local testing; POST delivery requires HTTPS. The secret key stays on the server. Verify is available without it.</Typography></AccordionDetails></Accordion></Alert>}
  </Stack>;
}

export function App() {
  const [mode, setMode] = useState<Mode>('verify');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [getStarted, setGetStarted] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pollError, setPollError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [toast, setToast] = useState('');
  // Reading is pure: React StrictMode may initialize and run effects twice.
  const [walletReturn] = useState(readWalletReturn);
  const [returnNotice, setReturnNotice] = useState<{ severity: 'info' | 'warning'; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const statusPanel = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const metadataController = useRef<AbortController | null>(null);
  const jobRef = useRef<Job | null>(null);
  const generation = useRef(0);
  jobRef.current = job;

  useEffect(() => {
    const abort = new AbortController();
    request<Config>('/api/config', { signal: abort.signal }).then(setConfig).catch(err => { if (!abort.signal.aborted) setConfigError((err as Error).message); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!walletReturn) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('walletReturn');
    url.searchParams.delete('returnError');
    url.searchParams.delete('metadataReturn');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    setMode('sign');
    const reportedError = walletReturn.error ? walletReturnError(walletReturn.error, walletReturn.metadata) : '';
    if (!walletReturn.id) {
      setReturnNotice({ severity: 'warning', message: reportedError || 'This wallet return link is incomplete. Return to the browser where you started signing to check the result.' });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const currentGeneration = ++generation.current;
    setBusy(true);
    if (reportedError) setReturnNotice({ severity: 'warning', message: reportedError });
    request<Job>(`/api/sign-jobs/${walletReturn.id}`, { signal: abort.signal }).then(value => {
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      setJob(value);
      // Only the authenticated job response can indicate successful signing.
      if (!reportedError) setReturnNotice(null);
    }).catch(err => {
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      const guidance = 'Return to the browser where you started signing to check the result.';
      setReturnNotice(err instanceof RequestError && err.status === 404
        ? { severity: reportedError ? 'warning' : 'info', message: reportedError ? `${reportedError} ${guidance}` : guidance }
        : { severity: 'warning', message: `Could not load your signing request. ${guidance}` });
    }).finally(() => {
      if (!abort.signal.aborted && generation.current === currentGeneration) setBusy(false);
    });
    return () => abort.abort();
  }, [walletReturn]);

  useEffect(() => {
    if (!file) { setLocalPreview(''); return; }
    const url = URL.createObjectURL(file);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => { controller.current?.abort(); downloadController.current?.abort(); metadataController.current?.abort(); }, []);

  useEffect(() => {
    if ((result || job) && window.matchMedia('(max-width: 899px)').matches) {
      statusPanel.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  }, [result, job?.status]);

  useEffect(() => {
    if ((!pending(job) && !pendingMetadata(job)) || metadataBusy) return;
    const id = job!.id;
    const currentGeneration = generation.current;
    const abort = new AbortController();
    let timer: number;
    const interval = pending(job) ? 2000 : 4000;
    async function poll() {
      try {
        const next = await request<Job>(`/api/sign-jobs/${encodeURIComponent(id)}`, { signal: abort.signal });
        if (abort.signal.aborted || generation.current !== currentGeneration) return;
        setPollError('');
        setJob(next);
      } catch (err) {
        if (abort.signal.aborted || generation.current !== currentGeneration) return;
        setPollError(`Connection interrupted. Reconnecting automatically. ${(err as Error).message}`);
      }
      if (!abort.signal.aborted) timer = window.setTimeout(poll, interval);
    }
    timer = window.setTimeout(poll, interval);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [job?.id, job?.status, job?.metadata?.status, metadataBusy]);

  const reset = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    downloadController.current?.abort();
    metadataController.current?.abort();
    if (pending(jobRef.current)) void fetch(`/api/sign-jobs/${encodeURIComponent(jobRef.current!.id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
    setJob(null); setResult(null); setError(''); setPollError(''); setBusy(false); setReturnNotice(null);
    setDownloading(false); setDownloadError('');
    setMetadataBusy(false);
  }, []);

  function selectFile(next: File | undefined) {
    if (!next) return;
    reset();
    if (!['image/png', 'image/jpeg'].includes(next.type) && !/\.(png|jpe?g)$/i.test(next.name)) { setFile(null); setError('Choose a PNG or JPEG image. Other file types are not supported.'); return; }
    if (config && next.size > config.maxUploadBytes) { setFile(null); setError(`This file is too large. Choose an image under ${formatBytes(config.maxUploadBytes)}.`); return; }
    setFile(next);
  }

  async function submit() {
    if (!file || busy || pending(job)) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const currentGeneration = ++generation.current;
    setBusy(true); setError(''); setResult(null); setJob(null); setPollError('');
    const body = new FormData(); body.append('image', file);
    try {
      if (mode === 'verify') {
        const value = await request<VerifyResult>('/api/verify', { method: 'POST', body, signal: abort.signal });
        if (generation.current === currentGeneration) setResult(value);
      } else {
        const value = await request<Job>('/api/sign-jobs', { method: 'POST', body, signal: abort.signal });
        if (generation.current === currentGeneration) setJob(value);
      }
    } catch (err) { if (!abort.signal.aborted && generation.current === currentGeneration) setError((err as Error).message); }
    finally { if (generation.current === currentGeneration) setBusy(false); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setToast('Identity address copied'); }
    catch { setToast('Copy is unavailable in this browser. Select the address to copy it.'); }
  }

  async function downloadImage() {
    if (!job?.downloadUrl || downloading) return;
    const abort = new AbortController();
    downloadController.current = abort;
    const currentGeneration = generation.current;
    setDownloading(true); setDownloadError('');
    try {
      const response = await fetch(job.downloadUrl, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message || `The signed image could not be downloaded (${response.status}). Please try again.`);
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
        throw new Error('The server did not return a PNG image. Please try downloading again.');
      }
      const blob = await response.blob();
      const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (header.length !== 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value)) {
        throw new Error('The downloaded file is not a valid PNG image. Please try again.');
      }
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'vatermark-signed.png';
      try { document.body.appendChild(link); link.click(); }
      finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (err) {
      if (!abort.signal.aborted && generation.current === currentGeneration) setDownloadError((err as Error).message);
    } finally {
      if (!abort.signal.aborted && generation.current === currentGeneration) setDownloading(false);
    }
  }

  async function updateMetadata(action: 'create' | 'check' | 'cancel', data?: ImageDetails) {
    if (job?.status !== 'complete' || metadataBusy) return;
    const abort = new AbortController();
    metadataController.current?.abort();
    metadataController.current = abort;
    const currentGeneration = generation.current;
    setMetadataBusy(true);
    try {
      const next = await request<Job>(`/api/sign-jobs/${encodeURIComponent(job.id)}/metadata${action === 'check' ? '/check' : ''}`, {
        method: action === 'cancel' ? 'DELETE' : 'POST', signal: abort.signal,
        ...(action === 'create' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: data }) } : {}),
      });
      if (!abort.signal.aborted && generation.current === currentGeneration) { setJob(next); setPollError(''); }
    } finally {
      if (!abort.signal.aborted && generation.current === currentGeneration) setMetadataBusy(false);
    }
  }

  const preview = job?.previewUrl || result?.previewUrl || localPreview;
  const working = busy || job?.status === 'preparing' || job?.status === 'finalizing';
  const signDisabled = mode === 'sign' && (!config || !config.signing.enabled);
  const jobFailed = job && ['failed', 'expired', 'cancelled'].includes(job.status);

  return <Box className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Box component="header" className="site-header">
      <Container maxWidth="lg" sx={{ px: { xs: 2.5, md: 5 } }}>
        <Box className="header-content">
          <Box component="a" href="#main-content" className="brand" aria-label="Vatermark home"><BrandMark /><span className="brand-name">vatermark</span></Box>
          <Stack component="nav" aria-label="Main navigation" direction="row" gap={{ xs: .5, sm: 2 }} alignItems="center">
            <Button color="inherit" href="#verification-info" onClick={() => setAboutOpen(true)} sx={{ display: { xs: 'none', sm: 'inline-flex' }, color: 'text.secondary' }}>About verification</Button>
            <span className="network-label"><span className="network-dot" />Testnet preview</span>
            <Button variant="contained" size="small" onClick={() => setGetStarted(true)} sx={{ borderRadius: '999px' }}>Get started</Button>
          </Stack>
        </Box>
      </Container>
    </Box>

    <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3, md: 5 } }}>
      <Box component="main" id="main-content" tabIndex={-1} className="main-content" sx={{ scrollMarginTop: '90px', '&:focus': { outline: 'none' } }}>
        <Box className="intro">
          <div className="intro-label">A personal mark. A verifiable signature.</div>
          <Typography variant="h1">Images with identity.</Typography>
          <Typography color="text.secondary" sx={{ mt: 2, fontSize: { xs: '1rem', sm: '1.125rem' }, lineHeight: 1.6 }}>Sign your images. Verify the ones you receive.</Typography>
        </Box>

        {configError && <Alert severity="warning" sx={{ mb: 2 }}>Could not load the server configuration. {configError} <Button size="small" color="inherit" onClick={() => window.location.reload()}>Reload</Button></Alert>}
        {returnNotice && <Alert severity={returnNotice.severity} sx={{ mb: 2 }}>{returnNotice.message}</Alert>}

        <Box className="workspace">
          <Box className="workspace-toolbar">
            <span className="workspace-label">Image workspace</span>
            <Tabs value={mode} onChange={(_, next: Mode) => { reset(); setMode(next); }} aria-label="Image action" className="mode-switch">
              <Tab id="verify-tab" aria-controls="image-panel" value="verify" icon={<VerifiedOutlined />} iconPosition="start" label="Verify" aria-label="Verify an image" />
              <Tab id="sign-tab" aria-controls="image-panel" value="sign" icon={<FingerprintRounded />} iconPosition="start" label="Sign" aria-label="Sign an image" />
            </Tabs>
            <span className="network-label"><span className="network-dot" />VRSCTEST</span>
          </Box>

          <Box id="image-panel" role="tabpanel" aria-labelledby={`${mode}-tab`} className="workspace-content">
            <Box className="image-editor">
              <Box className="panel-heading">
                <Box><div className="step-label">{mode === 'verify' ? 'Check a signature' : 'Create a signature'}</div><Typography variant="h2">Start with an image</Typography></Box>
                <ImageOutlined sx={{ color: 'text.secondary', fontSize: 24 }} aria-hidden="true" />
              </Box>
              <input ref={input} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="sr-only" tabIndex={-1} aria-label="Choose a PNG or JPEG image" onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />

              {!file && !preview ? <Box component="button" type="button" aria-label="Upload an image. Choose a PNG or JPEG file." className={`upload-area${dragging ? ' is-dragging' : ''}`} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}>
                <UploadArtwork />
                <Typography component="span" fontWeight={600}>Drop an image here</Typography>
                <span className="browse-label">or choose a file</span>
                <span className="file-types">PNG or JPEG{config ? ` · up to ${formatBytes(config.maxUploadBytes)}` : ''}</span>
              </Box> : <Box>
                <Box className="preview-background preview-frame">{preview && <img className="image-preview" src={preview} alt={job?.status === 'complete' ? 'Completed signed image' : 'Selected image preview'} />}</Box>
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} sx={{ mt: 1.5 }}>
                  <Box sx={{ minWidth: 0 }}><Typography variant="body2" fontWeight={600} noWrap title={file?.name}>{file?.name || (job?.status === 'complete' ? 'Signed image' : 'Prepared image')}</Typography><Typography variant="caption" color="text.secondary">{file ? formatBytes(file.size) : 'Restored signing request'}{job?.width && job?.height ? ` · ${job.width} × ${job.height}` : ''}</Typography></Box>
                  <Tooltip title="Choose another image"><IconButton aria-label="Choose another image" onClick={() => input.current?.click()}><RefreshRounded sx={{ fontSize: 20 }} /></IconButton></Tooltip>
                </Stack>
              </Box>}

              {error && <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>{error}</Alert>}
              {working && <Box role="status" sx={{ mt: 2.5 }}><LinearProgress /><Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{mode === 'verify' ? 'Reading the watermark and checking its signature…' : job?.status === 'finalizing' ? 'Embedding the signature and checking the finished PNG…' : 'Preparing the image and your wallet request…'}</Typography></Box>}
              <Button variant="contained" fullWidth disabled={!file || busy || pending(job) || signDisabled || job?.status === 'complete'} onClick={() => void submit()} endIcon={working ? <CircularProgress size={17} color="inherit" /> : mode === 'verify' ? <ArrowForwardRounded /> : <QrCode2Rounded />} sx={{ mt: 2.5, minHeight: 48 }}>{mode === 'verify' ? result ? 'Verify again' : 'Verify signature' : job?.status === 'complete' ? 'Image signed' : pending(job) ? 'Signing in progress' : 'Create signing request'}</Button>
              {(file || job) && !working && !pending(job) && <Button fullWidth color="inherit" onClick={() => { reset(); setFile(null); }} sx={{ mt: .7, color: 'text.secondary' }}>Clear image</Button>}
            </Box>

            <Box ref={statusPanel} className="inspector" aria-label={mode === 'verify' ? 'Verification information' : 'Signing information'}>
              {result ? <Verification result={result} copy={value => void copy(value)} /> : job?.status === 'awaiting_signature' ? <WaitingForWallet job={job} cancel={reset} responseMode={config?.responseMode} /> : job?.status === 'complete' ? <Stack gap={2.5}>
                <Box role="status"><Box className="status-symbol" sx={{ color: 'var(--success)', bgcolor: 'var(--success-soft)', mb: 2.5 }}><CheckCircleRounded /></Box><Typography variant="h2">Signed and ready to share.</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>The signature is embedded and the finished image has passed verification.</Typography></Box>
                {job.identity && <IdentityDetails identity={job.identity} copy={value => void copy(value)} />}
                {job.downloadUrl && <Button variant="contained" onClick={() => void downloadImage()} disabled={downloading} aria-busy={downloading} startIcon={downloading ? <CircularProgress size={18} color="inherit" /> : <DownloadRounded />}>{downloading ? 'Preparing download…' : 'Download signed image'}</Button>}
                {downloadError && <Alert severity="error" onClose={() => setDownloadError('')}>{downloadError}</Alert>}
                <Typography variant="body2" color="text.secondary">Your PNG keeps the image’s original dimensions. Original file metadata is not retained. Save it before this session expires.</Typography>
                {config?.metadata?.enabled !== false && <MetadataPanel key={job.id} metadata={job.metadata} busy={metadataBusy} create={data => updateMetadata('create', data)} check={() => updateMetadata('check')} cancel={() => updateMetadata('cancel')} />}
              </Stack> : jobFailed ? <Stack gap={2.5}>
                <Box role="status"><Box className="status-symbol" sx={{ color: 'var(--warning)', bgcolor: 'var(--warning-soft)', mb: 2.5 }}><WarningAmberRounded /></Box><Typography variant="h2">{job.status === 'expired' ? 'This request has expired' : job.status === 'cancelled' ? 'Request cancelled' : 'Could not complete signing'}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>{job.message || 'Create a new request to try again.'}</Typography></Box>
                <Button variant="outlined" onClick={reset} startIcon={<RefreshRounded />}>Start a new request</Button>
              </Stack> : working ? <Stack alignItems="center" justifyContent="center" gap={2.5} role="status" sx={{ minHeight: 360, textAlign: 'center' }}><CircularProgress size={34} thickness={3} /><Box><Typography variant="h2">{mode === 'verify' ? 'Checking your image' : job?.status === 'finalizing' ? 'Adding the signature' : 'Preparing your request'}</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: 1.2 }}>{mode === 'verify' ? 'Recovering the image fingerprint and looking up the signing identity.' : job?.status === 'finalizing' ? 'Your wallet signature was received. The output image is being checked before download.' : 'Creating a request for your wallet. This may take a moment.'}</Typography></Box></Stack> : <EmptyState mode={mode} config={config} getStarted={() => setGetStarted(true)} />}
              {pollError && <Alert severity="warning" sx={{ mt: 2 }}>{pollError}</Alert>}
            </Box>
          </Box>
          <Box className="workspace-footnote"><LockOutlined sx={{ fontSize: 14 }} /><span>Private uploads</span><span aria-hidden="true">·</span><span>Automatic cleanup</span></Box>
        </Box>

        <Box className="learn-section" id="verification-info" sx={{ scrollMarginTop: '96px' }}>
          <Accordion expanded={aboutOpen} onChange={(_, expanded) => setAboutOpen(expanded)}>
            <AccordionSummary expandIcon={<ExpandMoreRounded sx={{ fontSize: 20 }} />} sx={{ px: 1, '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1.2 } }}><InfoOutlined sx={{ fontSize: 18, color: 'text.secondary' }} /><Typography variant="body2" color="text.secondary">What does image verification tell me?</Typography></AccordionSummary>
            <AccordionDetails sx={{ px: 1, pt: 0, pb: 2 }}><Stack gap={2}>
              <Box><Typography variant="body2" fontWeight={600}>A signature linked to an identity</Typography><Typography variant="body2" color="text.secondary">Vatermark checks a signature over a reconstructed image fingerprint. Verification does not prove authorship, ownership, or that every pixel is unchanged.</Typography></Box>
              <Box><Typography variant="body2" fontWeight={600}>Keep the original dimensions</Typography><Typography variant="body2" color="text.secondary">The experimental fingerprint tolerates some same-size JPEG compression. Cropping, resizing, and screenshots can break the watermark. Images can be rectangular, with each side at least 32 pixels and enough area for the watermark, such as 512 × 512 or 1024 × 256. Actual transparency is not supported; a fully opaque alpha channel is removed.</Typography></Box>
              <Box><Typography variant="body2" fontWeight={600}>A testnet preview</Typography><Typography variant="body2" color="text.secondary">Only VRSCTEST identities are supported. Identity records come from api.verustest.net and are not independently validated chain proofs. A currently revoked identity is shown separately from a valid historical signature.</Typography></Box>
            </Stack></AccordionDetails>
          </Accordion>
        </Box>
      </Box>
      <Box component="footer" className="site-footer"><span>Vatermark · Image signatures</span><span>Experimental preview · VRSCTEST</span></Box>
    </Container>
    <GetStarted open={getStarted} close={() => setGetStarted(false)} config={config ? config.gifts || { enabled: false } : undefined} onSign={() => { setGetStarted(false); reset(); setMode('sign'); }} />
    <Snackbar open={!!toast} autoHideDuration={4500} onClose={() => setToast('')} message={toast} action={<IconButton color="inherit" aria-label="Dismiss notification" onClick={() => setToast('')}><CloseRounded fontSize="small" /></IconButton>} />
  </Box>;
}
