import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { App } from './App';
import { createAppTheme } from './theme';
import './styles.css';

function Appearance() {
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = useMemo(() => createAppTheme(dark ? 'dark' : 'light'), [dark]);
  return <ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Appearance /></React.StrictMode>,
);
