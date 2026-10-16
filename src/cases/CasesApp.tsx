import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Container, IconButton, Snackbar, Stack, Typography } from '@mui/material';
import { AddRounded, CloseRounded } from '@mui/icons-material';
import { api, type Config } from './api';
import { Home } from './pages/Home';
import { NewCase } from './pages/NewCase';
import { CasePage } from './pages/CasePage';
import { casePath, normalizeCaseNumber } from './format';
import './cases.css';

/**
 * Cases (beta): a signed review workflow for images, reachable from the
 * Vatermark header. It lives under /cases and shares the app's design tokens
 * and server session. See CASES.md.
 */
type Notice = { severity: 'success' | 'info' | 'warning'; message: string };
type Route = { name: 'home' } | { name: 'new' } | { name: 'case'; number: string };

function parseRoute(pathname: string): Route {
  if (/^\/cases\/new\/?$/.test(pathname)) return { name: 'new' };
  const match = /^\/cases\/c\/([^/]+)\/?$/.exec(pathname);
  if (match) { const raw = decodeURIComponent(match[1]); return { name: 'case', number: normalizeCaseNumber(raw) ?? raw.toUpperCase() }; }
  return { name: 'home' };
}
/** Wallet redirects land on `/cases?caseReturn=<number>`, optionally with `returnError`. */
function readWalletReturn() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('caseReturn') && !params.has('returnError')) return null;
  return { number: normalizeCaseNumber(params.get('caseReturn') || '') ?? null, error: params.get('returnError') };
}
function returnErrorMessage(code: string) {
  switch (code) {
    case 'WRONG_IDENTITY': return 'That signature came from a different identity than the step needs. Pick the one shown on the step and sign again.';
    case 'STALE_SIGNATURE': return 'The wallet signed with a block height that is too old for this step. Let it sync and sign again.';
    case 'JOB_CLOSED': return 'That step isn’t waiting for a signature any more. It may have expired or been replaced; start it again.';
    case 'CHAIN_UNAVAILABLE': case 'SERVICE_UNAVAILABLE': return 'We couldn’t check the signature because the chain service was unavailable. Scan the request again in a moment.';
    default: return 'The wallet response couldn’t be accepted. Have a look at the step and try again.';
  }
}
function BrandMark() {
  return <Box component="svg" viewBox="0 0 40 40" aria-hidden="true" sx={{ width: 32, height: 32, color: 'text.primary', flexShrink: 0 }}>
    <rect width="40" height="40" rx="12" fill="currentColor" />
    <path d="M10 12l10 17 10-17M15 12l5 8 5-8" fill="none" stroke="var(--surface)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </Box>;
}

export function CasesApp() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toast, setToast] = useState('');
  const [walletReturn] = useState(readWalletReturn);

  const navigate = useCallback((path: string, next?: Notice, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setRoute(parseRoute(path));
    setNotice(next ?? null);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);
  useEffect(() => {
    const onPop = () => { setRoute(parseRoute(window.location.pathname)); setNotice(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    api.config(abort.signal).then(setConfig).catch(err => { if (!abort.signal.aborted) setConfigError((err as Error).message); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!walletReturn) return;
    const url = new URL(window.location.href);
    for (const key of ['caseReturn', 'returnError']) url.searchParams.delete(key);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const reported = walletReturn.error ? returnErrorMessage(walletReturn.error) : '';
    if (walletReturn.number) navigate(casePath(walletReturn.number), reported ? { severity: 'warning', message: reported } : { severity: 'success', message: 'Signed and recorded. The history below is up to date.' }, true);
    else setNotice({ severity: 'warning', message: reported || 'This wallet link is missing its case. Go back to the case page to see where things stand.' });
  }, [walletReturn, navigate]);

  const copy = useCallback(async (value: string, what = 'Copied') => {
    try { await navigator.clipboard.writeText(value); setToast(`${what} copied`); }
    catch { setToast('Copying isn’t available here. Select the text to copy it.'); }
  }, []);
  const copyValue = useCallback((value: string, what?: string) => { void copy(value, what); }, [copy]);

  return <Box className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Box component="header" className="site-header">
      <Container maxWidth="lg" sx={{ px: { xs: 2.5, md: 5 } }}>
        <Box className="header-content">
          <Box component="a" href="/" className="brand" aria-label="Back to Vatermark"><BrandMark /><span className="brand-name">vatermark</span><span className="beta-pill" style={{ marginLeft: 2 }}>CASES · BETA</span></Box>
          <Stack component="nav" aria-label="Cases navigation" direction="row" gap={{ xs: .5, sm: 2 }} alignItems="center">
            <Button color="inherit" href="/cases" onClick={event => { event.preventDefault(); navigate('/cases'); }} sx={{ display: { xs: 'none', sm: 'inline-flex' }, color: route.name === 'home' ? 'text.primary' : 'text.secondary' }}>Find a case</Button>
            <span className="network-label"><span className="network-dot" />Testnet preview</span>
            <Button variant="contained" size="small" startIcon={<AddRounded />} onClick={() => navigate('/cases/new')} sx={{ borderRadius: '999px' }}>New case</Button>
          </Stack>
        </Box>
      </Container>
    </Box>
    <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3, md: 5 } }}>
      <Box component="main" id="main-content" tabIndex={-1} className="cases-main" sx={{ scrollMarginTop: '90px', '&:focus': { outline: 'none' } }}>
        {configError && <Alert severity="warning" sx={{ mb: 2 }}>Couldn’t reach the server for its settings. {configError} <Button size="small" color="inherit" onClick={() => window.location.reload()}>Reload</Button></Alert>}
        {notice && <Alert severity={notice.severity} sx={{ mb: 2.5 }} onClose={() => setNotice(null)}>{notice.message}</Alert>}
        {route.name === 'home' && <Home config={config} navigate={navigate} copy={copyValue} />}
        {route.name === 'new' && <NewCase config={config} navigate={navigate} />}
        {route.name === 'case' && <CasePage key={route.number} number={route.number} config={config} navigate={navigate} copy={copyValue} toast={setToast} />}
      </Box>
      <footer className="site-footer">
        <Typography variant="caption">vatermark cases · every hand-off, signed</Typography>
        <Typography variant="caption">Testnet preview · no patient data</Typography>
      </footer>
    </Container>
    <Snackbar open={!!toast} autoHideDuration={4500} onClose={() => setToast('')} message={toast} action={<IconButton color="inherit" size="small" aria-label="Dismiss" onClick={() => setToast('')}><CloseRounded fontSize="small" /></IconButton>} />
  </Box>;
}
