import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, TextField, Typography } from '@mui/material';
import { AddRounded, CheckCircleRounded, NotesRounded, OpenInNewRounded, QrCode2Rounded, RefreshRounded, ZoomInRounded } from '@mui/icons-material';
import QRCode from 'qrcode';

export type ImageDetails = { title?: string; description?: string; url?: string };
export type MetadataState = {
  status: 'preparing' | 'awaiting_approval' | 'submitted' | 'published' | 'expired' | 'failed';
  expiresAt: string; walletUri?: string; qrText?: string; message?: string; txid?: string;
};
export type VerifiedMetadata = {
  status: 'decrypted' | 'not_found' | 'unavailable' | 'invalid';
  message?: string; data?: ImageDetails; txid?: string; height?: number;
};

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

function validateDetails(values: Required<ImageDetails>) {
  const data: ImageDetails = {};
  for (const key of ['title', 'description', 'url'] as const) {
    const value = values[key].trim();
    if (value) data[key] = value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
  let error = '';
  if (!Object.keys(data).length) error = 'Add a title, description, or link.';
  else if ((data.title?.length || 0) > 120) error = 'Keep the title to 120 characters or fewer.';
  else if ((data.description?.length || 0) > 400) error = 'Keep the description to 400 characters or fewer.';
  else if ((data.url?.length || 0) > 300) error = 'Keep the link to 300 characters or fewer.';
  else if (data.url && !safeUrl(data.url)) error = 'Use a full HTTP or HTTPS link without a username or password.';
  else if (bytes > 512) error = 'These details exceed 512 bytes. Shorten the text or link.';
  return { data, bytes, error };
}

export function VerifiedImageDetails({ metadata }: { metadata: VerifiedMetadata }) {
  if (metadata.status === 'not_found') return <Typography variant="body2" color="text.secondary">No published image details were found for this signature.</Typography>;
  if (metadata.status !== 'decrypted' || !metadata.data) {
    return <Alert severity={metadata.status === 'invalid' ? 'warning' : 'info'}>
      <Typography variant="body2" fontWeight={600}>Image details {metadata.status === 'invalid' ? 'could not be authenticated' : 'are unavailable'}</Typography>
      {metadata.message || 'The optional identity details could not be read. The image signature result above is separate.'}
    </Alert>;
  }
  const { title, description, url } = metadata.data;
  const href = safeUrl(url);
  return <Box sx={{ p: { xs: 2.5, sm: 3 }, bgcolor: 'var(--surface-secondary)', border: '1px solid var(--separator)', borderRadius: '18px', minWidth: 0 }}>
    <Typography sx={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', mb: 1.5 }}>Image details</Typography>
    <Stack gap={1.5}>
      {title && <Typography variant="h3" sx={{ fontSize: '22px', lineHeight: 1.3, fontWeight: 600, letterSpacing: '-.025em', overflowWrap: 'anywhere' }}>{title}</Typography>}
      {description && <Typography sx={{ fontSize: '15px', lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{description}</Typography>}
      {href && <Link href={href} target="_blank" rel="noopener noreferrer" sx={{ fontSize: '15px', lineHeight: 1.6, minHeight: 44, display: 'flex', alignItems: 'center', gap: .75, overflowWrap: 'anywhere', color: 'var(--accent)' }}><Box component="span" sx={{ minWidth: 0 }}>{url}</Box><OpenInNewRounded sx={{ fontSize: 16, flexShrink: 0 }} /></Link>}
      {url && !href && <Typography variant="body2" color="text.secondary">The stored link is not a supported web address.</Typography>}
      <Typography sx={{ pt: 1.5, borderTop: '1px solid var(--separator)', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>Read from the signing identity and decrypted using this image.{metadata.height !== undefined ? ` Published at block ${metadata.height.toLocaleString()}.` : ''}</Typography>
    </Stack>
  </Box>;
}

type Props = {
  metadata?: MetadataState; busy: boolean;
  create: (data: ImageDetails) => Promise<void>;
  check: () => Promise<void>;
  cancel: () => Promise<void>;
};

export function MetadataPanel({ metadata, busy, create, check, cancel }: Props) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Required<ImageDetails>>({ title: '', description: '', url: '' });
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const mounted = useRef(false);
  const uri = metadata?.walletUri || metadata?.qrText || '';
  const awaiting = metadata?.status === 'awaiting_approval';
  const submitted = metadata?.status === 'submitted';
  const preparing = metadata?.status === 'preparing';
  const published = metadata?.status === 'published';
  const validation = validateDetails(values);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setQr(''); setQrError(''); setQrOpen(false);
    if (awaiting && uri) void QRCode.toDataURL(uri, { width: 1024, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#1d1d1f', light: '#ffffff' } })
      .then(value => { if (active) setQr(value); })
      .catch(() => { if (active) setQrError('The QR could not be displayed. Use the wallet link below.'); });
    return () => { active = false; };
  }, [awaiting, uri]);

  async function run(action: () => Promise<void>) {
    setError('');
    try { await action(); }
    catch (err) { if (mounted.current && !(err instanceof DOMException && err.name === 'AbortError')) setError((err as Error).message); }
  }

  const fieldStyle = {
    '& .MuiInputBase-root': { bgcolor: 'var(--surface)', borderRadius: '12px', fontSize: '16px' },
    '& .MuiInputBase-input': { fontSize: '16px', py: 1.75 },
    '& .MuiInputBase-multiline': { py: 1.75 },
    '& .MuiInputBase-inputMultiline': { p: 0, lineHeight: 1.6 },
    '& .MuiInputLabel-root': { fontSize: '16px' },
    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--separator)' },
  };
  return <Stack gap={2.25} aria-label="Optional image details" sx={{ pt: 3, borderTop: '1px solid var(--separator)', minWidth: 0 }}>
    <Stack direction="row" alignItems="center" gap={1.5}>
      <Box sx={{ width: 40, height: 40, borderRadius: '12px', flexShrink: 0, display: 'grid', placeItems: 'center', bgcolor: 'var(--surface-secondary)', color: 'var(--text-secondary)' }}><NotesRounded sx={{ fontSize: 22 }} /></Box>
      <Box><Typography sx={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', mb: .35 }}>Optional next step</Typography><Typography variant="h3" sx={{ fontSize: '21px', lineHeight: 1.25, fontWeight: 600, letterSpacing: '-.025em' }}>Add image details</Typography></Box>
    </Stack>
    <Typography sx={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--text-secondary)' }}>Add a title, description, or link to the identity that signed this image. Publishing requires a separate wallet approval and a network fee.</Typography>
    {(open || awaiting || submitted) && <Box sx={{ px: 2, py: 1.75, bgcolor: 'var(--surface-secondary)', borderRadius: '14px' }}>
      <Typography sx={{ fontSize: '13px', lineHeight: 1.65, color: 'var(--text-secondary)' }}>The QR and wallet link contain these details. Your wallet encrypts them before publication. Anyone with the signed image can read them.</Typography>
      <Typography sx={{ mt: .75, fontSize: '13px', lineHeight: 1.65, color: 'var(--text-secondary)' }}>This step does not change the image or increase its watermark size.</Typography>
    </Box>}

    {preparing ? <Stack direction="row" alignItems="center" gap={1.5} sx={{ py: 1 }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">Preparing the details request…</Typography></Stack> : published ? <Alert severity="success" icon={<CheckCircleRounded fontSize="inherit" />} sx={{ borderRadius: '14px' }}><Typography variant="body2" fontWeight={600}>Image details published</Typography>{metadata.message || 'Verify the signed image to read its details from the identity.'}</Alert> : awaiting || submitted ? <>
      <Box>
        <Typography sx={{ fontSize: '15px', lineHeight: 1.5, fontWeight: 600 }}>{awaiting ? 'Approve the identity update in your wallet' : 'Waiting for the identity update to appear on chain'}</Typography>
        {metadata.message && <Typography sx={{ mt: .75, fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>{metadata.message}</Typography>}
      </Box>
      {awaiting && uri && <>
        <Box sx={{ alignSelf: 'center', width: '100%', maxWidth: 280, aspectRatio: '1', display: 'grid', placeItems: 'center', border: '1px solid var(--separator)', borderRadius: '18px', overflow: 'hidden', bgcolor: '#fff' }}>
          {qr ? <Box component="img" src={qr} alt="QR code containing the optional identity update request" sx={{ width: '100%', display: 'block', imageRendering: 'pixelated' }} /> : qrError ? <QrCode2Rounded sx={{ color: '#6e6e73', fontSize: 64 }} /> : <CircularProgress size={26} />}
        </Box>
        {qrError && <Alert severity="warning" sx={{ borderRadius: '14px' }}>{qrError}</Alert>}
        {qr && <Button size="small" startIcon={<ZoomInRounded />} onClick={() => setQrOpen(true)} sx={{ alignSelf: 'center' }}>Enlarge QR</Button>}
        <Button variant="contained" href={uri} endIcon={<OpenInNewRounded sx={{ fontSize: 18 }} />}>Open wallet for details</Button>
        <Typography sx={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>Use the same signing identity. After approving, return here to check publication.</Typography>
      </>}
      <Button variant="outlined" onClick={() => void run(check)} disabled={busy} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <RefreshRounded />}>Check publication</Button>
      {awaiting && <Button color="inherit" size="small" disabled={busy} onClick={() => void run(async () => { await cancel(); if (mounted.current) setOpen(false); })} sx={{ color: 'var(--text-secondary)' }}>Cancel details request</Button>}
      {submitted && <Typography variant="body2" color="text.secondary">An identity update already submitted to the chain cannot be cancelled here.</Typography>}
    </> : <>
      {(metadata?.status === 'failed' || metadata?.status === 'expired') && <Alert severity="warning" sx={{ borderRadius: '14px' }}>{metadata.message || (metadata.status === 'expired' ? 'The details request expired. You can create another one.' : 'The details update could not be completed. You can try again.')} Your signed image is still available.</Alert>}
      {open ? <Box component="form" onSubmit={event => { event.preventDefault(); if (validation.error) { setError(validation.error); return; } void run(() => create(validation.data)); }}>
        <Stack gap={2.5}>
          <Stack gap={2.5} sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: 'var(--surface-secondary)', border: '1px solid var(--separator)', borderRadius: '18px' }}>
            <TextField label="Image title" value={values.title} onChange={event => setValues(previous => ({ ...previous, title: event.target.value }))} disabled={busy} fullWidth size="small" slotProps={{ htmlInput: { maxLength: 120 } }} sx={fieldStyle} />
            <TextField label="Description" value={values.description} onChange={event => setValues(previous => ({ ...previous, description: event.target.value }))} disabled={busy} fullWidth multiline minRows={3} size="small" slotProps={{ htmlInput: { maxLength: 400 } }} sx={fieldStyle} />
            <TextField label="Website link" value={values.url} onChange={event => setValues(previous => ({ ...previous, url: event.target.value }))} disabled={busy} fullWidth size="small" placeholder="https://example.com" slotProps={{ htmlInput: { maxLength: 300, inputMode: 'url' } }} sx={fieldStyle} />
            <Typography sx={{ fontSize: '12px', lineHeight: 1.5, color: validation.bytes > 512 ? 'var(--error)' : 'var(--text-secondary)', textAlign: 'right' }}>{validation.bytes} / 512 bytes</Typography>
          </Stack>
          <Button type="submit" variant="contained" disabled={busy} startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <QrCode2Rounded />}>Create details request</Button>
          <Button size="small" color="inherit" disabled={busy} onClick={() => { setOpen(false); setError(''); }} sx={{ color: 'var(--text-secondary)' }}>Skip details</Button>
        </Stack>
      </Box> : <Button variant="outlined" startIcon={<AddRounded />} onClick={() => { setOpen(true); setError(''); }} sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}>Add image details</Button>}
    </>}
    {error && <Alert severity="error" onClose={() => setError('')} sx={{ borderRadius: '14px' }}>{error}</Alert>}
    <Dialog open={qrOpen && awaiting && !!qr} onClose={() => setQrOpen(false)} maxWidth="md" fullWidth aria-labelledby="metadata-qr-title" slotProps={{ paper: { sx: { borderRadius: '24px', bgcolor: 'var(--surface)', backgroundImage: 'none', m: 2, width: 'calc(100% - 32px)' } } }}>
      <DialogTitle id="metadata-qr-title" sx={{ px: { xs: 2.5, sm: 4 }, pt: 3, fontSize: '23px', fontWeight: 600, letterSpacing: '-.03em' }}>Scan image details request</DialogTitle>
      <DialogContent sx={{ px: { xs: 2.5, sm: 4 } }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.6 }}>Scan with your wallet and approve using the identity that signed the image.</Typography>
        <Box sx={{ bgcolor: '#fff', borderRadius: '16px', overflow: 'hidden', mx: 'auto', maxWidth: 720 }}><Box component="img" src={qr || undefined} alt="Enlarged QR code containing the optional identity update request" sx={{ display: 'block', width: '100%', imageRendering: 'pixelated' }} /></Box>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2.5, sm: 4 }, pb: 3 }}><Button onClick={() => setQrOpen(false)}>Close QR</Button></DialogActions>
    </Dialog>
  </Stack>;
}
