import { useRef, useState } from 'react';
import { Box, CircularProgress, LinearProgress, Typography } from '@mui/material';
import { formatBytes } from '../format';

interface Props {
  onFile: (file: File) => void;
  onReject: (message: string) => void;
  busy?: boolean; busyText?: string; disabled?: boolean; maxBytes?: number;
  title: string; hint?: string; label: string; compact?: boolean;
}
function CaseArtwork() {
  return <svg className="case-art" viewBox="0 0 92 84" fill="none" aria-hidden="true">
    <path d="M8 22a6 6 0 0 1 6-6h18l6 7h30a6 6 0 0 1 6 6v33a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" fill="var(--surface-tertiary)" stroke="var(--separator)" />
    <rect x="26" y="12" width="46" height="46" rx="8" transform="rotate(-6 26 12)" fill="var(--surface)" stroke="var(--border-strong)" />
    <circle cx="43" cy="30" r="4.5" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
    <path d="m32 50 11-12 7 6 7-9 10 15" stroke="var(--accent)" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx="76" cy="66" r="12" fill="var(--accent)" stroke="var(--surface)" strokeWidth="3" />
    <path d="m70 66 4 4 8-8" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
/** Choosing or dropping a file hands it straight to the action; nothing is pre-filled. Styled like the Vatermark upload area. */
export function Dropzone({ onFile, onReject, busy, busyText, disabled, maxBytes, title, hint, label, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const inactive = disabled || busy;
  function select(file: File | undefined) {
    if (!file || inactive) return;
    if (maxBytes && file.size > maxBytes) { onReject(`That file is too big. Choose one under ${formatBytes(maxBytes)}.`); return; }
    onFile(file);
  }
  return <Box>
    <input ref={input} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg,.dcm,application/dicom" className="sr-only" tabIndex={-1} aria-label={label}
      onChange={event => { select(event.target.files?.[0]); event.target.value = ''; }} />
    <button type="button" className={`upload-area${dragging ? ' is-dragging' : ''}`} aria-label={label} aria-disabled={inactive || undefined} aria-busy={busy || undefined}
      style={compact ? { minHeight: 150, padding: '18px 14px' } : undefined}
      onClick={() => { if (!inactive) input.current?.click(); }}
      onDragOver={event => { event.preventDefault(); if (!inactive) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); select(event.dataTransfer.files[0]); }}>
      {busy ? <Box sx={{ width: '100%', maxWidth: 280 }} role="status">
        <CircularProgress size={26} thickness={4} sx={{ mb: 2 }} />
        <LinearProgress />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{busyText || 'One moment…'}</Typography>
      </Box> : <>
        {!compact && <CaseArtwork />}
        <Typography sx={{ fontSize: '1.0625rem', fontWeight: 600 }}>{title}</Typography>
        <span className="browse-label">or choose a file</span>
        <span className="file-types">{hint || `PNG, JPEG or DICOM${maxBytes ? ` · up to ${formatBytes(maxBytes)}` : ''}`}</span>
      </>}
    </button>
  </Box>;
}
