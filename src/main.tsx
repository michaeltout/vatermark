import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { App } from './App';
import { CasesApp } from './cases/CasesApp';
import { createAppTheme } from './theme';
import './styles.css';

// Cases (beta) lives under /cases; everything else is the Vatermark app.
const cases = /^\/cases(?:\/|$)/.test(window.location.pathname);

function Appearance() {
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = useMemo(() => createAppTheme(dark ? 'dark' : 'light'), [dark]);
  return <ThemeProvider theme={theme}><CssBaseline />{cases ? <CasesApp /> : <App />}</ThemeProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Appearance /></React.StrictMode>,
);
