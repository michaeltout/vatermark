const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
export const shortHex = (value: string | undefined, chars = 12) => value ? `${value.slice(0, chars)}…` : '';
export function formatTime(value: number | string) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}
export function relativeTime(value: number | string, now = Date.now()) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  const seconds = Math.round((ms - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400], ['hour', 3_600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return Math.abs(seconds) < 10 ? 'just now' : formatter.format(seconds, 'second');
}
export function countdown(untilMs: number, now = Date.now()) {
  const remaining = Math.max(0, Math.ceil((untilMs - now) / 1000));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
}
/** Same tolerant normalization as the server; undefined when the input cannot be a case number. */
export function normalizeCaseNumber(input: string): string | undefined {
  const text = input.toUpperCase().replace(/[\s_-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!text.startsWith('VC')) return undefined;
  const body = text.slice(2);
  if (body.length !== 12 || [...body].some(c => !CROCKFORD.includes(c))) return undefined;
  return `VC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}
export const casePath = (number: string) => `/cases/c/${number}`;
export const mediaLabel = (mediaType: string) => ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'application/dicom': 'DICOM' } as Record<string, string>)[mediaType] ?? 'File';
/** Initials for an avatar from a VerusID name such as "dr.novak@". */
export const initials = (name: string) => name.replace(/@.*$/, '').split(/[.\s_-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';
