/**
 * The staff dashboard's navigation: All Calls and Reservations. VP-14 retired the separate
 * Callbacks tab — callbacks are the "Needs Callback" filter of All Calls.
 */
import { STAFF_CALLS_PATH, STAFF_RESERVATIONS_PATH } from './staffPaths.js';

export type StaffSection = 'calls' | 'reservations';

const SECTIONS: ReadonlyArray<{ key: StaffSection; label: string; href: string }> = [
  { key: 'calls', label: 'All Calls', href: STAFF_CALLS_PATH },
  { key: 'reservations', label: 'Reservations', href: STAFF_RESERVATIONS_PATH },
];

export function staffNavHtml(active: StaffSection): string {
  const links = SECTIONS.map(
    (section) =>
      `<a href="${section.href}"${section.key === active ? ' aria-current="page"' : ''}>${section.label}</a>`,
  ).join('\n  ');
  return `<nav class="staff-nav" aria-label="Staff sections">
  ${links}
</nav>`;
}
