/**
 * The one rule for two clients pointing at the same archive location (a variable NAME in
 * client.yaml, or a resolved Sheet / folder ID): it is allowed only when EVERY client involved
 * carries `archive.sharedDemoArchive: true`. Any group with even one unflagged client is a conflict,
 * so a real client or TechMirai's own agent can never silently land in someone else's archive.
 *
 * Pure: callers decide what the keys are (e.g. `env:GOOGLE_ARCHIVE_SHEET_ID`, `sheetId:<id>`).
 */
export interface SharingEntry {
  clientId: string;
  /** True when the client's archive block has `sharedDemoArchive: true`. */
  shared: boolean;
  /** Every location key this client uses. */
  keys: readonly string[];
}

export interface SharingGroup {
  key: string;
  /** Sorted client ids; always two or more. */
  clients: string[];
}

export interface SharingReport {
  /** Locations used by 2+ clients where at least one is NOT flagged: must fail. */
  conflicts: SharingGroup[];
  /** Locations used by 2+ clients that ALL carry the flag: informational. */
  sharedByDemo: SharingGroup[];
}

export function analyzeSharing(entries: readonly SharingEntry[]): SharingReport {
  const owners = new Map<string, SharingEntry[]>();
  for (const entry of entries) {
    for (const key of new Set(entry.keys)) {
      owners.set(key, [...(owners.get(key) ?? []), entry]);
    }
  }

  const conflicts: SharingGroup[] = [];
  const sharedByDemo: SharingGroup[] = [];
  for (const [key, group] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    const clients = group.map((entry) => entry.clientId).sort();
    (group.every((entry) => entry.shared) ? sharedByDemo : conflicts).push({ key, clients });
  }
  return { conflicts, sharedByDemo };
}
