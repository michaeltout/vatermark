import type { CSSProperties } from 'react';
import type { CaseStatus } from '../api';

/**
 * The five stages of a case as a path. On a case page the progress line stops
 * at the current stage; on the home page a traveller keeps moving along it.
 * Wide layouts draw the path left to right, narrow ones top to bottom; a
 * stacked variant is always top to bottom for narrow cards. Pure SVG and CSS;
 * motion is switched off by the app's prefers-reduced-motion rule.
 */
const STAGES = [
  { key: 'open', label: 'Open', sub: 'owner signs', icon: <path d="M-6-4h12v8H-6zM-6-4l2-3h8l2 3" /> },
  { key: 'assign', label: 'Assign', sub: 'owner signs', icon: <><circle cx="-3" cy="-2" r="3" /><path d="M-8 6c0-3 2-5 5-5s5 2 5 5M5-2h4M7-4v4" /></> },
  { key: 'accept', label: 'Accept', sub: 'reviewer signs', icon: <path d="M-6 0l4 4 8-8" /> },
  { key: 'complete', label: 'Complete', sub: 'reviewer signs', icon: <><circle cx="0" cy="0" r="7" /><path d="M-3 0l2 2 4-4" /></> },
  { key: 'close', label: 'Close', sub: 'owner signs', icon: <><rect x="-5" y="-1" width="10" height="8" rx="2" /><path d="M-3-1v-3a3 3 0 0 1 6 0v3" /></> },
] as const;
const PATH_H = 'M 40 44 C 110 44, 120 44, 190 44 S 300 44, 340 44 S 450 44, 490 44 S 600 44, 640 44';
const X = [40, 190, 340, 490, 640];
const PATH_V = 'M 30 30 V 300';
const Y = [30, 97.5, 165, 232.5, 300];
function reached(status: CaseStatus | undefined): number {
  switch (status) {
    case 'open': case 'rejected': case 'reopened': return 0;
    case 'assigned': return 1;
    case 'accepted': return 2;
    case 'completed': return 3;
    case 'closed': return 4;
    default: return -1;
  }
}
const nodeClass = (index: number, current: number) => `flow-node${index < current ? ' is-done' : index === current ? ' is-current' : ''}`;

export function Flow({ status, animate = false, orientation = 'auto' }: { status?: CaseStatus; animate?: boolean; orientation?: 'auto' | 'stacked' }) {
  const current = reached(status);
  const label = `How a case moves: ${STAGES.map(s => s.label).join(', ')}.${status ? ` This case is at ${STAGES[Math.max(current, 0)].label.toLowerCase()}.` : ''}`;
  const traveller = animate && <><circle className="flow-traveller-halo" r="11" /><circle className="flow-traveller" r="4.5" /></>;
  return <div className={`flow${orientation === 'stacked' ? ' flow-stacked' : ''}`} role="img" aria-label={label}>
    {orientation !== 'stacked' && <svg className="flow-horizontal" viewBox="0 0 680 100" style={{ '--flow-path': `path("${PATH_H}")` } as CSSProperties}>
      <path className="flow-track" d={PATH_H} />
      {current >= 0 && <path className="flow-progress" d={PATH_H} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - X[current] / 640 }} />}
      {traveller}
      {STAGES.map((stage, index) => <g key={stage.key} transform={`translate(${X[index]} 44)`}>
        <circle className={nodeClass(index, current)} r="18" />
        <g className="flow-icon">{stage.icon}</g>
        <text className="flow-label" y="40">{stage.label}</text>
        <text className="flow-sub" y="55">{stage.sub}</text>
      </g>)}
    </svg>}
    <svg className="flow-vertical" viewBox="0 0 240 330" style={{ '--flow-path': `path("${PATH_V}")` } as CSSProperties}>
      <path className="flow-track" d={PATH_V} />
      {current >= 0 && <path className="flow-progress" d={PATH_V} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - (Y[current] - 30) / 270 }} />}
      {traveller}
      {STAGES.map((stage, index) => <g key={stage.key} transform={`translate(30 ${Y[index]})`}>
        <circle className={nodeClass(index, current)} r="18" />
        <g className="flow-icon">{stage.icon}</g>
        <text className="flow-label" x="40" y="-2" style={{ textAnchor: 'start' }}>{stage.label}</text>
        <text className="flow-sub" x="40" y="14" style={{ textAnchor: 'start' }}>{stage.sub}</text>
      </g>)}
    </svg>
  </div>;
}
