import { createTheme, type PaletteMode } from '@mui/material/styles';

export function createAppTheme(mode: PaletteMode) {
  const dark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? '#6bb6ff' : '#0066cc', dark: dark ? '#8ac5ff' : '#004f9f', contrastText: dark ? '#081b30' : '#ffffff' },
      background: { default: dark ? '#111113' : '#f5f5f7', paper: dark ? '#1c1c1e' : '#ffffff' },
      text: { primary: dark ? '#f5f5f7' : '#1d1d1f', secondary: dark ? '#b3b3ba' : '#626269' },
      divider: dark ? '#38383c' : '#e2e2e7',
      success: { main: dark ? '#67d98e' : '#217845' },
      warning: { main: dark ? '#f2c66d' : '#805800' },
      error: { main: dark ? '#ff9891' : '#bf302b' },
      info: { main: dark ? '#6bb6ff' : '#0066cc' },
    },
    typography: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      h1: { fontSize: 'clamp(2.25rem, 4.8vw, 3.5rem)', fontWeight: 650, letterSpacing: '-0.045em', lineHeight: 1.08 },
      h2: { fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1.25 },
      h3: { fontSize: '1.125rem', fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.4 },
      body1: { fontSize: '1rem', lineHeight: 1.6, letterSpacing: '-0.015em' },
      body2: { fontSize: '0.875rem', lineHeight: 1.6, letterSpacing: '-0.008em' },
      button: { fontSize: '0.9375rem', fontWeight: 550, textTransform: 'none', letterSpacing: '-0.015em' },
      caption: { fontSize: '0.8125rem', lineHeight: 1.5 },
      overline: { fontSize: '0.75rem', lineHeight: 1.5, fontWeight: 600, letterSpacing: '0.06em' },
    },
    shape: { borderRadius: 8 },
    components: {
      MuiButtonBase: { defaultProps: { disableRipple: true }, styleOverrides: { root: { '&.Mui-focusVisible': { outline: '3px solid var(--accent)', outlineOffset: 3 } } } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: '12px', minHeight: 44, paddingInline: 20, transition: 'background-color 160ms ease, border-color 160ms ease', boxShadow: 'none' },
          sizeSmall: { minHeight: 44, fontSize: '0.875rem', paddingInline: 16 },
          outlined: { borderColor: 'var(--separator)', backgroundColor: 'var(--surface)', '&:hover': { borderColor: 'var(--accent)', backgroundColor: 'var(--accent-soft)' } },
          text: { '&:hover': { backgroundColor: 'var(--accent-soft)' } },
        },
      },
      MuiIconButton: { styleOverrides: { root: { minWidth: 44, minHeight: 44, borderRadius: '50%' } } },
      MuiCard: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: '1px solid var(--separator)', borderRadius: '24px', backgroundImage: 'none' } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiChip: { styleOverrides: { root: { fontSize: '0.75rem', fontWeight: 550, borderRadius: '8px' } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 44 }, indicator: { display: 'none' } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', minHeight: 44, padding: '10px 18px', fontSize: '0.875rem', fontWeight: 550, borderRadius: '10px' } } },
      MuiAccordion: { defaultProps: { elevation: 0, disableGutters: true }, styleOverrides: { root: { background: 'transparent', '&:before': { display: 'none' } } } },
      MuiAccordionSummary: { styleOverrides: { root: { minHeight: 52 }, content: { marginBlock: 14 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: '14px', padding: '12px 16px', alignItems: 'flex-start' }, message: { fontSize: '0.875rem', lineHeight: 1.6, minWidth: 0, overflowWrap: 'anywhere' }, standardInfo: { background: 'var(--accent-soft)' }, standardSuccess: { background: 'var(--success-soft)' }, standardWarning: { background: 'var(--warning-soft)' }, standardError: { background: 'var(--error-soft)' } } },
      MuiOutlinedInput: { styleOverrides: { root: { background: 'var(--surface)', borderRadius: '12px', fontSize: '1rem', '& fieldset': { borderColor: 'var(--separator)' } }, input: { minHeight: '1.5em' } } },
      MuiInputLabel: { styleOverrides: { root: { fontSize: '1rem' } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: '28px', border: '1px solid var(--separator)', boxShadow: '0 24px 100px #00000030', maxHeight: 'calc(100% - 40px)', '@media (max-width: 600px)': { margin: 12, width: 'calc(100% - 24px)', maxHeight: 'calc(100% - 24px)', borderRadius: '24px' } } } },
      MuiDialogTitle: { styleOverrides: { root: { padding: '28px 28px 16px', fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.03em', '@media (max-width: 600px)': { paddingInline: 22 } } } },
      MuiDialogContent: { styleOverrides: { root: { padding: '8px 28px 28px', '@media (max-width: 600px)': { paddingInline: 22 } } } },
      MuiDialogActions: { styleOverrides: { root: { padding: '12px 28px 24px' } } },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: '#00000055' } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiSnackbarContent: { styleOverrides: { root: { borderRadius: '14px', fontSize: '0.875rem' } } },
      MuiLinearProgress: { styleOverrides: { root: { height: 4, borderRadius: '4px' } } },
    },
  });
}
