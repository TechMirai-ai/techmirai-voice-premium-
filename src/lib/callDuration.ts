/**
 * Display format for a call's length, shared by the staff dashboard and the archive Sheet.
 * The length itself (started_at → ended_at, whole seconds) is computed in SQL, in
 * callLogRepository.ts and archiveJobRepository.ts, so both read the same number.
 */

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 187 → "3:07"; 3725 → "1:02:05". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = pad2(seconds % 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${rest}` : `${minutes}:${rest}`;
}
