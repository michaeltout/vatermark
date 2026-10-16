import { useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { ExpandMoreRounded, OpenInNewRounded, QrCode2Rounded } from '@mui/icons-material';
import QRCode from 'qrcode';
import type { IdentityRef } from '../api';
import { IdentityLine } from './Identity';
import { countdown } from '../format';

interface Props {
  stepLabel: string; title: string; description: string;
  walletUri: string; expiresAt: number; signer: IdentityRef; statement: string;
  responseMode?: 'redirect' | 'post'; copy: (value: string, what?: string) => void;
  onWithdraw?: () => void;
}
/** The hand-off to the wallet: who has to sign, the QR, and the exact text they are signing. Mirrors Vatermark's signing panel. */
export function WalletStep({ stepLabel, title, description, walletUri, expiresAt, signer, statement, responseMode, copy, onWithdraw }: Props) {
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let mounted = true;
    setQr(''); setQrError('');
    QRCode.toDataURL(walletUri, { width: 512, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#1d1d1f', light: '#ffffff' } })
      .then(value => { if (mounted) setQr(value); })
      .catch(() => { if (mounted) setQrError('The QR could not be shown. Use the wallet link below instead.'); });
    return () => { mounted = false; };
  }, [walletUri]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 232px' }, gap: 3, alignItems: 'start' }} role="status">
    <Stack gap={2}>
      <Box><div className="step-label">{stepLabel}</div><Typography variant="h2">{title}</Typography></Box>
      <Typography variant="body2" color="text.secondary">{description}</Typography>
      <Box className="inset">
        <div className="panel-label">Sign with this identity</div>
        <IdentityLine identity={signer} copy={copy} compact />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Any other identity is turned away and the step stays open.</Typography>
      </Box>
      <Accordion sx={{ border: '1px solid var(--separator)', borderRadius: '14px', overflow: 'hidden' }}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 2 }}><Typography variant="body2" fontWeight={600}>What you’re signing</Typography></AccordionSummary>
        <AccordionDetails sx={{ px: 2, pt: 0 }}><pre className="statement" style={{ marginTop: 0 }}>{statement}</pre></AccordionDetails>
      </Accordion>
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <CircularProgress size={12} thickness={5} />
        <Typography variant="body2">Waiting for the signature</Typography>
        <Typography variant="caption" color="text.secondary" aria-live="off">{countdown(expiresAt, now)} left</Typography>
        {onWithdraw && <Button color="inherit" size="small" onClick={onWithdraw} sx={{ ml: 'auto', color: 'text.secondary' }}>Take this step back</Button>}
      </Stack>
    </Stack>
    <Stack gap={1.5} alignItems="center">
      <Box className="qr-surface" sx={{ maxWidth: 232 }}>
        {qr ? <Box component="img" src={qr} alt="QR code containing the wallet signing request" sx={{ width: '100%', display: 'block', imageRendering: 'pixelated' }} />
          : qrError ? <QrCode2Rounded sx={{ color: '#626269', fontSize: 64 }} /> : <CircularProgress size={26} />}
      </Box>
      {qrError && <Alert severity="warning">{qrError}</Alert>}
      <Button variant="contained" href={walletUri} endIcon={<OpenInNewRounded sx={{ fontSize: 17 }} />} fullWidth>Open wallet</Button>
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
        {responseMode !== 'post' ? 'After you sign, the wallet brings you back here. ' : ''}Needs experimental deeplinks on in Verus Mobile.
      </Typography>
    </Stack>
  </Box>;
}
