/**
 * The staff dashboard's three-section navigation (VP-12): All Calls, Callbacks, Reservations.
 * Its own module so staffViews.ts (the shared page shell and the callbacks page) and
 * staffCallViews.ts (the new pages) can both use it without importing each other.
 */
import { STAFF_CALLS_PATH, STAFF_DASHBOARD_PATH, STAFF_RESERVATIONS_PATH } from './staffPaths.js';

export type StaffSection = 'calls' | 'callbacks' | 'reservations';

const SECTIONS: ReadonlyArray<{ key: StaffSection; label: string; href: string }> = [
  { key: 'calls', label: 'All Calls', href: STAFF_CALLS_PATH },
  { key: 'callbacks', label: 'Callbacks', href: STAFF_DASHBOARD_PATH },
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
