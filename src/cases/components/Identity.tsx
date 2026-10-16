import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { ContentCopyRounded } from '@mui/icons-material';
import type { IdentityRef } from '../api';
import { initials } from '../format';

export function IdentityLine({ identity, copy, compact }: { identity: IdentityRef; copy: (value: string, what?: string) => void; compact?: boolean }) {
  return <Box sx={{ minWidth: 0 }}>
    <Typography sx={{ fontSize: compact ? '0.9375rem' : '1.0625rem', fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{identity.name}</Typography>
    <Stack direction="row" alignItems="center" gap={.25} sx={{ minWidth: 0 }}>
      <Typography className="mono" sx={{ fontSize: '0.75rem', color: 'text.secondary', flex: 1, minWidth: 0 }}>{identity.id}</Typography>
      <Tooltip title="Copy address"><IconButton size="small" aria-label={`Copy the address of ${identity.name}`} onClick={() => copy(identity.id, 'Address')} sx={{ minWidth: 36, minHeight: 36 }}><ContentCopyRounded sx={{ fontSize: 15 }} /></IconButton></Tooltip>
    </Stack>
  </Box>;
}

/** A person on the case: avatar, role, name and address. */
export function Party({ role, identity, note, copy }: { role: string; identity?: IdentityRef; note?: string; copy: (value: string, what?: string) => void }) {
  return <div className="party">
    <div className={`party-avatar${identity ? '' : ' is-empty'}`} aria-hidden="true">{identity ? initials(identity.name) : '·'}</div>
    <Box sx={{ minWidth: 0 }}>
      <div className="panel-label" style={{ marginBottom: 2 }}>{role}</div>
      {identity ? <IdentityLine identity={identity} copy={copy} compact /> : <Typography variant="body2" color="text.secondary">{note || 'Nobody yet'}</Typography>}
      {identity && note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: .4 }}>{note}</Typography>}
    </Box>
  </div>;
}
