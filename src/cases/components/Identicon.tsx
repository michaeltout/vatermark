import { Box } from '@mui/material';

/** A small glyph derived from the file's fingerprint, so a case is recognisable without storing the image. */
export function Identicon({ seed, size = 56, title }: { seed: string; size?: number; title?: string }) {
  const hex = (seed || '').padEnd(8, '0');
  const bits = parseInt(hex.slice(0, 4), 16) || 0;
  const hue = Math.round((parseInt(hex.slice(4, 6), 16) || 0) / 255 * 360);
  const cells: Array<[number, number]> = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
    if ((bits >> (row * 3 + col)) & 1) { cells.push([col, row]); if (col < 2) cells.push([4 - col, row]); }
  }
  return <Box component="svg" viewBox="-0.5 -0.5 6 6" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
    sx={{ width: size, height: size, borderRadius: '14px', flexShrink: 0, bgcolor: `hsl(${hue} 60% 94% / .9)`, border: '1px solid var(--separator)', '@media (prefers-color-scheme: dark)': { bgcolor: `hsl(${hue} 35% 20%)` } }}>
    {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" rx=".2" fill={`hsl(${hue} 55% 42%)`} />)}
  </Box>;
}
