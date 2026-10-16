import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography } from '@mui/material';
import { AccountBalanceWalletOutlined, BadgeOutlined, CheckCircleRounded, CloseRounded, ExpandMoreRounded, OpenInNewRounded } from '@mui/icons-material';
import QRCode from 'qrcode';

export type GiftConfig = { enabled: boolean; reason?: string };
type Gift = { identityName: string; identityId: string; walletUri: string; amount: string };
async function giftRequest(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || 'Could not load your gift card. Please retry.');
  return value as { card?: Gift };
}

function GiftContent({ config, onSign }: { config: GiftConfig; onSign: () => void }) {
  const [card, setCard] = useState<Gift>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    if (!config.enabled) { setLoading(false); return; }
    giftRequest('/api/gifts/current', { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setCard(value.card); })
      .catch(err => { if (!abort.signal.aborted) setError((err as Error).message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [config.enabled]);
  useEffect(() => {
    if (!card) return;
    let active = true;
    QRCode.toDataURL(card.walletUri, { width: 360, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#1d1d1f', light: '#ffffff' } })
      .then(value => { if (active) setQr(value); }).catch(() => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [card]);
  async function claim() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const value = await giftRequest('/api/gifts/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (!value.card) throw new Error('No gift card was returned. Please retry.');
      setCard(value.card);
    } catch (err) {
      // A lost response may already have allocated a card. Retry retrieves the
      // same private allocation; it never silently consumes a second card.
      setError((err as Error).message);
    } finally { setBusy(false); }
  }
  if (!config.enabled) return <Alert severity="info" sx={{ borderRadius: '16px' }}>{config.reason || 'Test identities are not available yet. You can still sign with your own VRSCTEST identity.'}</Alert>;
  if (loading) return <Stack alignItems="center" justifyContent="center" gap={2} sx={{ minHeight: 200 }}><CircularProgress size={26} aria-label="Checking for your gift card" /><Typography variant="body2" color="text.secondary">Checking for your gift card…</Typography></Stack>;
  return <Stack gap={2.5}>
    {card ? <>
      <Box>
        <Stack direction="row" alignItems="center" gap={.75} sx={{ color: 'var(--success)', mb: 1.25 }}>
          <CheckCircleRounded sx={{ fontSize: 18 }} /><Typography sx={{ fontSize: '13px', fontWeight: 600 }}>Your gift card is ready</Typography>
        </Stack>
        <Typography variant="h3" sx={{ fontSize: { xs: '22px', sm: '25px' }, fontWeight: 600, letterSpacing: '-.035em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{card.identityName}</Typography>
        <Typography sx={{ mt: 1.25, fontSize: '15px', lineHeight: 1.55, color: 'var(--text-secondary)' }}>Your card contains this test identity and 1 VRSCTEST before wallet claim fees. Scan it in Verus Mobile or open the wallet on this device.</Typography>
      </Box>
      <Box sx={{ width: '100%', maxWidth: 280, alignSelf: 'center', aspectRatio: '1', bgcolor: '#fff', border: '1px solid var(--separator)', borderRadius: '20px', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
        {qr ? <Box component="img" src={qr} alt="Private gift card QR code" sx={{ width: '100%', display: 'block', imageRendering: 'pixelated' }} /> : qrError ? <Typography sx={{ p: 2, color: '#1d1d1f', fontSize: '14px', textAlign: 'center' }}>Use the wallet link below to claim your card.</Typography> : <CircularProgress size={24} />}
      </Box>
      <Button variant="contained" href={card.walletUri} endIcon={<OpenInNewRounded sx={{ fontSize: 18 }} />} fullWidth>Claim in Verus Mobile</Button>
      <Alert severity="warning" sx={{ borderRadius: '14px', fontSize: '13px', lineHeight: 1.55 }}>Keep this QR and wallet link private. Anyone who has either can claim the card. Complete the claim before clearing your browser cookies.</Alert>
      <Box component="details" sx={{ color: 'var(--text-secondary)', '&[open] .gift-disclosure-icon': { transform: 'rotate(180deg)' } }}>
        <Box component="summary" sx={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', listStyle: 'none', borderRadius: '8px', '&::-webkit-details-marker': { display: 'none' } }}>
          <Typography sx={{ fontSize: '14px', fontWeight: 500 }}>Wallet setup</Typography><ExpandMoreRounded className="gift-disclosure-icon" sx={{ fontSize: 20 }} />
        </Box>
        <Typography variant="body2" sx={{ pt: .5, pb: 1, fontSize: '14px', lineHeight: 1.6 }}>Enable testnet and experimental deeplinks in Verus Mobile. Claim the identity into your wallet, then wait for the claim transaction to confirm before signing an image.</Typography>
      </Box>
      <Button variant="outlined" onClick={onSign} fullWidth>Continue to signing</Button>
    </> : <>
      <Typography sx={{ color: 'var(--text-secondary)', fontSize: '16px', lineHeight: 1.6 }}>Get a test identity and 1 VRSCTEST to try signing your own images. No payment is needed; these are testnet assets.</Typography>
      <Box sx={{ bgcolor: 'var(--surface-secondary)', border: '1px solid var(--separator)', borderRadius: '18px', px: 2.25 }}>
        <Stack direction="row" gap={1.75} alignItems="center" sx={{ py: 2.25, borderBottom: '1px solid var(--separator)' }}>
          <BadgeOutlined sx={{ color: 'var(--accent)', fontSize: 25 }} />
          <Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: '15px', fontWeight: 600 }}>An identity of your own</Typography><Typography sx={{ mt: .35, fontSize: '13px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>Sign images with your Verus Mobile wallet.</Typography></Box>
        </Stack>
        <Stack direction="row" gap={1.75} alignItems="center" sx={{ py: 2.25 }}>
          <AccountBalanceWalletOutlined sx={{ color: 'var(--accent)', fontSize: 25 }} />
          <Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: '15px', fontWeight: 600 }}>1 VRSCTEST included</Typography><Typography sx={{ mt: .35, fontSize: '13px', lineHeight: 1.5, color: 'var(--text-secondary)' }}>Test funds, before wallet claim fees.</Typography></Box>
        </Stack>
      </Box>
      <Button variant="contained" disabled={busy} onClick={() => void claim()} startIcon={busy ? <CircularProgress size={18} color="inherit" /> : undefined} fullWidth>{busy ? 'Preparing your card…' : 'Get a test identity'}</Button>
      <Typography sx={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--text-secondary)', textAlign: 'center' }}>Receive a private gift card for Verus Mobile while test identities are available.</Typography>
    </>}
    {error && <Alert severity="error" sx={{ borderRadius: '14px' }}>{error}</Alert>}
  </Stack>;
}
export function GetStarted({ open, close, config, onSign }: { open: boolean; close: () => void; config?: GiftConfig; onSign: () => void }) {
  return <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="get-started-title" slotProps={{ paper: { sx: { width: 'calc(100% - 32px)', maxWidth: 480, m: 2, borderRadius: '28px', bgcolor: 'var(--surface)', backgroundImage: 'none', border: '1px solid var(--separator)' } } }}>
    <DialogTitle id="get-started-title" sx={{ px: { xs: 3, sm: 4 }, pt: 4, pb: 2.5, pr: 8, fontSize: '28px', fontWeight: 600, lineHeight: 1.15, letterSpacing: '-.04em' }}>
      <Box component="span" sx={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '14px', mb: 2.5 }}><BadgeOutlined sx={{ fontSize: 27 }} /></Box>
      Get an ID for signing images
      <IconButton aria-label="Close get started" onClick={close} sx={{ position: 'absolute', right: 12, top: 12, width: 44, height: 44, bgcolor: 'var(--surface-secondary)', color: 'var(--text-secondary)', '&:hover': { bgcolor: 'var(--surface-tertiary)' } }}><CloseRounded sx={{ fontSize: 21 }} /></IconButton>
    </DialogTitle>
    <DialogContent sx={{ px: { xs: 3, sm: 4 }, pb: 4 }}>{config ? <GiftContent config={config} onSign={onSign} /> : <Typography color="text.secondary">Loading test identity availability…</Typography>}</DialogContent>
  </Dialog>;
}
