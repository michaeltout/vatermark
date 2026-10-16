import { useState, type ReactNode } from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import {
  AssignmentIndRounded, AssignmentTurnedInRounded, BlockRounded, FolderOpenRounded, HourglassTopRounded, LockOpenRounded, LockRounded,
  TaskAltRounded, UndoRounded, WarningAmberRounded,
} from '@mui/icons-material';
import type { CaseEventView, EventType, PendingStep } from '../api';
import { IdentityLine } from './Identity';
import { formatTime, relativeTime, shortHex } from '../format';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';
const look: Record<EventType, { tone: Tone; icon: ReactNode }> = {
  CASE_CREATED: { tone: 'accent', icon: <FolderOpenRounded /> },
  TASK_ASSIGNED: { tone: 'accent', icon: <AssignmentIndRounded /> },
  TASK_ACCEPTED: { tone: 'success', icon: <AssignmentTurnedInRounded /> },
  TASK_REJECTED: { tone: 'warning', icon: <BlockRounded /> },
  TASK_WITHDRAWN: { tone: 'neutral', icon: <UndoRounded /> },
  REVIEW_COMPLETED: { tone: 'success', icon: <TaskAltRounded /> },
  CASE_CLOSED: { tone: 'neutral', icon: <LockRounded /> },
  CASE_REOPENED: { tone: 'neutral', icon: <LockOpenRounded /> },
};
function headline(e: CaseEventView): string {
  switch (e.type) {
    case 'CASE_CREATED': return `${e.actor.name} opened the case`;
    case 'TASK_ASSIGNED': return `${e.actor.name} asked ${e.to?.name ?? 'a reviewer'} to review`;
    case 'TASK_ACCEPTED': return `${e.actor.name} took the review on`;
    case 'TASK_REJECTED': return `${e.actor.name} declined`;
    case 'TASK_WITHDRAWN': return `${e.actor.name} took the request back`;
    case 'REVIEW_COMPLETED': return `${e.actor.name} finished the review`;
    case 'CASE_CLOSED': return `${e.actor.name} closed the case`;
    case 'CASE_REOPENED': return `${e.actor.name} reopened the case`;
  }
}
function detail(e: CaseEventView): string | undefined {
  switch (e.type) {
    case 'TASK_ASSIGNED': return e.deadline ? `Asked for it by ${formatTime(e.deadline)}.` : undefined;
    case 'TASK_REJECTED': return 'The case goes back to where it was before the request.';
    case 'TASK_WITHDRAWN': return `The request to ${e.to?.name ?? 'the reviewer'} no longer stands.`;
    case 'REVIEW_COMPLETED': return 'Signed as complete under the case policy. Findings live in the clinical record, not here.';
    default: return undefined;
  }
}
function pendingHeadline(p: PendingStep): string {
  switch (p.type) {
    case 'CASE_CREATED': return `Waiting for ${p.expectedSigner.name} to open the case`;
    case 'TASK_ASSIGNED': return `Waiting for ${p.expectedSigner.name} to sign the request to ${p.to?.name ?? 'the reviewer'}`;
    case 'TASK_ACCEPTED': return `Waiting for ${p.expectedSigner.name} to accept`;
    case 'TASK_REJECTED': return `Waiting for ${p.expectedSigner.name} to decline`;
    case 'TASK_WITHDRAWN': return `Waiting for ${p.expectedSigner.name} to take the request back`;
    case 'REVIEW_COMPLETED': return `Waiting for ${p.expectedSigner.name} to sign off the review`;
    case 'CASE_CLOSED': return `Waiting for ${p.expectedSigner.name} to close the case`;
    case 'CASE_REOPENED': return `Waiting for ${p.expectedSigner.name} to reopen the case`;
  }
}
function AnchorTag({ anchor }: { anchor: CaseEventView['anchor'] }) {
  const text = anchor.status === 'anchored' ? `On chain · block ${anchor.height?.toLocaleString()}` : anchor.status === 'failed' ? 'Anchoring failed' : 'Not on chain yet';
  const tone = anchor.status === 'anchored' ? ' tag-success' : anchor.status === 'failed' ? ' tag-error' : '';
  return <Tooltip title={anchor.detail || (anchor.txid ? `Transaction ${anchor.txid}` : 'The event hash is recorded here; it hasn’t been committed to the Verus chain.')}><span className={`tag${tone}`}>{text}</span></Tooltip>;
}

/** Newest first, like a chart. Each entry is a signed, chained event; the waiting step sits on top until it is signed. */
export function Timeline({ events, pending, copy, now }: { events: CaseEventView[]; pending?: PendingStep; copy: (value: string, what?: string) => void; now: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const ordered = [...events].reverse();
  let index = 0;
  const delay = () => ({ '--delay': `${Math.min(index++, 8) * 70}ms` } as React.CSSProperties);
  return <ol className="timeline" aria-label="Case history">
    {pending && <li className="timeline-item" style={delay()}>
      <span className="timeline-spine" />
      <div className="timeline-node tone-accent is-waiting" aria-hidden="true"><HourglassTopRounded /></div>
      <div className="timeline-card is-waiting">
        <div className="timeline-title"><Typography sx={{ fontWeight: 650, lineHeight: 1.3 }}>{pendingHeadline(pending)}</Typography><span className="timeline-when">issued {relativeTime(pending.issuedAt, now)}</span></div>
        <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>Nothing is recorded until the signature arrives.</Typography>
      </div>
    </li>}
    {ordered.map(e => {
      const { tone, icon } = look[e.type];
      const note = detail(e);
      return <li className="timeline-item" key={e.hash} style={delay()}>
        <span className="timeline-spine" />
        <div className={`timeline-node tone-${tone}`} aria-hidden="true">{icon}</div>
        <div className="timeline-card">
          <div className="timeline-title">
            <Typography sx={{ fontWeight: 650, lineHeight: 1.3 }}>{headline(e)}</Typography>
            <span className="timeline-when" title={formatTime(e.at)}>{relativeTime(e.at, now)} · {formatTime(e.at)}</span>
          </div>
          {note && <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>{note}</Typography>}
          <div className="timeline-meta">
            <span className="tag">#{e.seq} · signed at block {e.signingHeight.toLocaleString()}</span>
            <AnchorTag anchor={e.anchor} />
            {e.keyState !== 'unchanged' && <Tooltip title={e.keyState === 'rotated' ? 'This identity’s keys changed after it signed. The signature was valid at the time; read what came after with that in mind.' : 'This identity has been revoked since it signed. The signature was valid at the time.'}>
              <span className="tag tag-warning"><WarningAmberRounded sx={{ fontSize: 15 }} />{e.keyState === 'rotated' ? 'Keys changed since' : 'Revoked since'}</span>
            </Tooltip>}
            <Button size="small" color="inherit" onClick={() => setOpen(open === e.seq ? null : e.seq)} sx={{ minHeight: 26, px: 1, ml: 'auto', color: 'text.secondary', fontSize: '0.75rem' }}>{open === e.seq ? 'Less' : 'Details'}</Button>
          </div>
          {open === e.seq && <Box sx={{ mt: 1.5 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              <div><div className="panel-label">Signed by</div><IdentityLine identity={e.actor} copy={copy} compact /></div>
              {e.to && <div><div className="panel-label">To</div><IdentityLine identity={e.to} copy={copy} compact /></div>}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Event <span className="mono">{shortHex(e.hash, 18)}</span> · links to <span className="mono">{shortHex(e.prev, 10)}</span> · issued {formatTime(e.issuedAt)} against block {e.block.height.toLocaleString()}</Typography>
            <pre className="statement">{e.statement}</pre>
          </Box>}
        </div>
      </li>;
    })}
  </ol>;
}
