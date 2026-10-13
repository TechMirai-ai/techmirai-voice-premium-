import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { hashPassword } from '../../src/lib/auth.js';
import { DEMO_PLACEHOLDER_PHONE } from '../../src/lib/demoCallerPhone.js';
import {
  buildStaffApp,
  MemoryCallbackAdmin,
  MemoryCallLogReader,
  MemoryStaffUsers,
  OTHER_CLIENT_ID,
  sampleCall,
  sampleCallback,
  sampleReservation,
  STAFF_CLIENT_ID,
  type SeededCall,
} from '../helpers/staffFixtures.js';

const CALLS = '/staff/calls';
const NEEDS_CALLBACK = `${CALLS}?status=needs_callback`;
const RESERVATIONS = '/staff/reservations';
const DASHBOARD = '/staff/dashboard';

async function loggedIn(callLogs: MemoryCallLogReader, callbacks = new MemoryCallbackAdmin()) {
  const staffUsers = new MemoryStaffUsers();
  staffUsers.seed({
    email: 'owner@example.com',
    passwordHash: await hashPassword('a-real-password-123'),
    clientId: STAFF_CLIENT_ID,
    mustChangePassword: false,
  });
  const { app } = buildStaffApp({ staffUsers, callbacks, callLogs });
  const agent = request.agent(app);
  await agent
    .post('/staff/login')
    .send({ email: 'owner@example.com', password: 'a-real-password-123' });
  return { app, agent };
}

/** The text of every cell in the first body row, in column order. */
function firstRowCells(html: string): string[] {
  const row = /<tbody>\s*<tr[^>]*>([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? '';
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    (match[1] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function headerLabels(html: string): string[] {
  return [...html.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((match) => match[1] ?? '');
}

describe('access control', () => {
  test.each([CALLS, RESERVATIONS, DASHBOARD])(
    '%s redirects an anonymous visitor to the login page',
    async (url) => {
      const { app } = buildStaffApp();
      const response = await request(app).get(url);
      expect(response.status).toBe(303); // same See-Other redirect the auth middleware gives every staff page
      expect(response.headers.location).toBe('/staff/login');
    },
  );
});

describe('GET /staff/calls — All Calls', () => {
  test('is a table: one row per call, a header row, no stacked cards', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'a' }));
    reader.seed(sampleCall({ id: 'b', createdAt: new Date('2026-10-12T02:00:00.000Z') }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(text).toContain('<table class="data-table" id="call-table">');
    expect(text.match(/<tr class="call-row/g)).toHaveLength(2);
    expect(headerLabels(text)).toEqual([
      'Date / Time (JST)',
      'Language',
      'Duration',
      'Topic',
      'Status',
      'Caller',
      'Summary',
    ]);
    expect(text).not.toContain('<ul');
  });

  test('lists the client’s calls with a readable status badge and the AI summary', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'r1', status: 'needs_callback', summary: 'Wants a callback.' }));
    const { agent } = await loggedIn(reader);

    const { status, text } = await agent.get(CALLS);

    expect(status).toBe(200);
    expect(text).toContain('Wants a callback.');
    expect(text).toContain('class="status-badge status-needs_callback">Needs Callback</span>');
  });

  test('shows the call time in JST, not UTC and not a raw ISO string', async () => {
    const reader = new MemoryCallLogReader();
    // A real call from the live dashboard: stored 2026-10-13T11:14:07.173Z (UTC).
    reader.seed(sampleCall({ startedAt: new Date('2026-10-13T11:14:07.173Z') }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(firstRowCells(text)[0]).toBe('2026-10-13 20:14');
    expect(text).not.toContain('2026-10-13T11:14');
    expect(text).not.toContain('.173Z');
  });

  test('a JST date can differ from the UTC date (a 16:00Z call is next-day 01:00 in Japan)', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ startedAt: new Date('2026-10-12T16:00:00.000Z') }));
    const { agent } = await loggedIn(reader);

    expect(firstRowCells((await agent.get(CALLS)).text)[0]).toBe('2026-10-13 01:00');
  });

  test('falls back to created_at for the time when a call has no start time', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ startedAt: null, createdAt: new Date('2026-10-13T11:14:07.173Z') }));
    const { agent } = await loggedIn(reader);

    expect(firstRowCells((await agent.get(CALLS)).text)[0]).toBe('2026-10-13 20:14');
  });

  test('shows how long each call lasted, as minutes:seconds', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'short', durationSeconds: 187 }));
    reader.seed(sampleCall({ id: 'long', durationSeconds: 3725 }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(text).toContain('>3:07<');
    expect(text).toContain('>1:02:05<');
  });

  test('shows a dash when the call has no duration recorded, rather than inventing 0:00', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ durationSeconds: null }));
    const { agent } = await loggedIn(reader);

    const cells = firstRowCells((await agent.get(CALLS)).text);

    expect(cells[2]).toBe('—');
    expect(cells).not.toContain('0:00');
  });

  test('a call without a summary shows a dash, never the old "(no summary)" placeholder', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ summary: null }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(firstRowCells(text)[6]).toBe('—');
    expect(text).not.toContain('(no summary)');
  });

  test('shows all four status labels exactly as the work order names them', async () => {
    const reader = new MemoryCallLogReader();
    (['reservation_made', 'needs_callback', 'resolved_by_ai', 'unresolved'] as const).forEach(
      (status, index) => reader.seed(sampleCall({ id: `r${index}`, status })),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    for (const label of ['Reservation made', 'Needs Callback', 'Resolved by AI', 'Unresolved']) {
      expect(text).toContain(label);
    }
  });

  test('never shows another client’s calls', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'mine', summary: 'MINE' }));
    reader.seed(sampleCall({ id: 'theirs', clientId: OTHER_CLIENT_ID, summary: 'THEIRS' }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(text).toContain('MINE');
    expect(text).not.toContain('THEIRS');
  });

  test('?status= filters to one status; an unknown value is ignored rather than trusted', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'a', status: 'needs_callback', summary: 'CALLBACK-CALL' }));
    reader.seed(sampleCall({ id: 'b', status: 'resolved_by_ai', summary: 'RESOLVED-CALL' }));
    const { agent } = await loggedIn(reader);

    const filtered = await agent.get(NEEDS_CALLBACK);
    expect(filtered.text).toContain('CALLBACK-CALL');
    expect(filtered.text).not.toContain('RESOLVED-CALL');

    const bogus = await agent.get(`${CALLS}?status=%27%3B%20DROP%20TABLE%20call_logs`);
    expect(bogus.status).toBe(200);
    expect(bogus.text).toContain('CALLBACK-CALL');
    expect(bogus.text).toContain('RESOLVED-CALL');
  });

  test('escapes caller-controlled text (summary and names)', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(
      sampleCall({
        summary: '<script>alert(1)</script>',
        callerName: '<img src=x onerror=alert(2)>',
      }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).not.toContain('<img src=x');
    expect(text).toContain('&lt;script&gt;');
  });

  test('says so when there are no calls yet', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());
    expect((await agent.get(CALLS)).text).toContain('No calls yet.');
  });

  test('shows the matched patient name and caller name when known', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ callerName: 'Hanako Yamada', matchedPatientName: 'ヤマダ タロウ' }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(CALLS);

    expect(text).toContain('Hanako Yamada');
    expect(text).toContain('ヤマダ タロウ');
  });
});

describe('Needs Callback filter — mark as handled (moved here from the old Callbacks page)', () => {
  const callbackCall = (overrides: Partial<SeededCall> = {}): SeededCall =>
    sampleCall({
      id: 'call-row-cb',
      status: 'needs_callback',
      callerName: 'Hanako Yamada',
      callback: {
        id: 'cb-1',
        callerPhone: '090-1234-5678',
        reason: 'Asked about a treatment',
        status: 'pending',
        handledAt: null,
      },
      ...overrides,
    });

  test('adds Phone, Reason and Action columns, and a Mark as handled form for a pending callback', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(callbackCall());
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(headerLabels(text)).toEqual([
      'Date / Time (JST)',
      'Language',
      'Duration',
      'Topic',
      'Status',
      'Caller',
      'Summary',
      'Phone',
      'Reason',
      'Action',
    ]);
    expect(text).toContain('090-1234-5678');
    expect(text).toContain('Asked about a treatment');
    expect(text).toContain('action="/staff/dashboard/callbacks/cb-1/handled"');
    expect(text).toContain('Mark as handled');
  });

  test('a callback on a call that is not marked needs_callback still shows here, with its button', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(callbackCall({ status: 'reservation_made' }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(text).toContain('Mark as handled');
    expect(text).toContain('Reservation made');
  });

  test('the other views carry no callback columns and no Mark as handled button', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(callbackCall());
    const { agent } = await loggedIn(reader);

    for (const url of [CALLS, `${CALLS}?status=resolved_by_ai`, RESERVATIONS]) {
      const { text } = await agent.get(url);
      expect(text, url).not.toContain('Mark as handled');
      expect(headerLabels(text), url).not.toContain('Action');
    }
  });

  test('a handled callback shows when it was handled, in JST, and no button', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(
      callbackCall({
        callback: {
          id: 'cb-1',
          callerPhone: '090-1234-5678',
          reason: null,
          status: 'handled',
          handledAt: new Date('2026-10-13T06:30:00.000Z'),
        },
      }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(text).toContain('Handled 2026-10-13 15:30');
    expect(text).not.toContain('Mark as handled');
  });

  test('a needs_callback call with no callback record shows dashes and no button', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(callbackCall({ callback: null }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(text).not.toContain('Mark as handled');
    expect(firstRowCells(text).slice(-3)).toEqual(['—', '—', '—']);
  });

  test('labels the demo placeholder number so staff never mistake it for a real one', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(
      callbackCall({
        callback: {
          id: 'cb-1',
          callerPhone: DEMO_PLACEHOLDER_PHONE,
          reason: null,
          status: 'pending',
          handledAt: null,
        },
      }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(text).toContain(`${DEMO_PLACEHOLDER_PHONE} (demo placeholder — no caller ID)`);
  });

  test('escapes an HTML-like reason so it renders as inert text', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(
      callbackCall({
        callback: {
          id: 'cb-1',
          callerPhone: '090-1234-5678',
          reason: '<script>alert(document.cookie)</script>',
          status: 'pending',
          handledAt: null,
        },
      }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(NEEDS_CALLBACK);

    expect(text).not.toContain('<script>alert(document.cookie)</script>');
    expect(text).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
    expect(text.match(/<script\b/g)).toBeNull();
  });

  test('the button works end to end: POST marks it handled and returns to the filter', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', status: 'pending' }));
    const { agent } = await loggedIn(new MemoryCallLogReader(), callbacks);

    const response = await agent.post('/staff/dashboard/callbacks/cb-1/handled');

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(NEEDS_CALLBACK);
    expect(callbacks.rows.get('cb-1')?.status).toBe('handled');
  });
});

describe('GET /staff/reservations', () => {
  test('is a table of every reservation with its booking details', async () => {
    const reader = new MemoryCallLogReader();
    reader.seedReservation(
      sampleReservation({
        reservationNumber: 'R000042',
        appointmentDate: '2026-10-20',
        appointmentTime: '10:30',
        serviceName: 'General Consultation',
        patientName: 'Taro Sample',
        isReturningPatient: true,
        language: 'en',
        summary: 'Booked a consultation.',
      }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(RESERVATIONS);

    expect(text).toContain('<table class="data-table" id="reservation-table">');
    expect(headerLabels(text)).toEqual([
      'Reservation #',
      'Appointment',
      'Service',
      'Patient',
      'Patient type',
      'Language',
      'Booked (JST)',
      'Summary',
    ]);
    expect(firstRowCells(text)).toEqual([
      'R000042',
      '2026-10-20 10:30',
      'General Consultation',
      'Taro Sample',
      'Returning',
      'en',
      '2026-10-12 10:00',
      'Booked a consultation.',
    ]);
  });

  test('shows reservations that have no call behind them (a future non-voice booking source)', async () => {
    const reader = new MemoryCallLogReader();
    reader.seedReservation(sampleReservation({ summary: null, serviceName: null }));
    const { agent } = await loggedIn(reader);

    const cells = firstRowCells((await agent.get(RESERVATIONS)).text);

    expect(cells[0]).toBe('R123456');
    expect(cells[2]).toBe('—');
    expect(cells[7]).toBe('—');
  });

  test('shows the booking time in JST while the appointment slot stays as stored', async () => {
    const reader = new MemoryCallLogReader();
    reader.seedReservation(
      sampleReservation({
        appointmentDate: '2026-10-13',
        appointmentTime: '09:00',
        bookedAt: new Date('2026-10-12T06:20:53.437Z'),
      }),
    );
    const { agent } = await loggedIn(reader);

    const cells = firstRowCells((await agent.get(RESERVATIONS)).text);

    expect(cells[1]).toBe('2026-10-13 09:00');
    expect(cells[6]).toBe('2026-10-12 15:20');
  });

  test('never shows another client’s reservations', async () => {
    const reader = new MemoryCallLogReader();
    reader.seedReservation(sampleReservation({ id: 'mine', reservationNumber: 'R-MINE' }));
    reader.seedReservation(
      sampleReservation({ id: 'theirs', clientId: OTHER_CLIENT_ID, reservationNumber: 'R-THEIRS' }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(RESERVATIONS);

    expect(text).toContain('R-MINE');
    expect(text).not.toContain('R-THEIRS');
  });

  test('escapes patient names and summaries', async () => {
    const reader = new MemoryCallLogReader();
    reader.seedReservation(
      sampleReservation({ patientName: '<b>x</b>', summary: '<script>alert(1)</script>' }),
    );
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(RESERVATIONS);

    expect(text).not.toContain('<b>x</b>');
    expect(text).not.toContain('<script>alert(1)</script>');
  });

  test('says so when there are no reservations yet', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());
    expect((await agent.get(RESERVATIONS)).text).toContain('No reservations yet.');
  });
});

describe('navigation', () => {
  test('every staff page has exactly two tabs — All Calls and Reservations — and marks the current one', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());

    for (const [url, current] of [
      [CALLS, 'All Calls'],
      [NEEDS_CALLBACK, 'All Calls'],
      [RESERVATIONS, 'Reservations'],
    ] as const) {
      const { text } = await agent.get(url);
      const nav = /<nav class="staff-nav"[\s\S]*?<\/nav>/.exec(text)?.[0] ?? '';
      expect([...nav.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1])).toEqual([
        'All Calls',
        'Reservations',
      ]);
      expect(nav).toMatch(new RegExp(`aria-current="page"[^>]*>${current}<`));
      expect(nav).not.toContain('/staff/dashboard');
    }
  });

  test('the old Callbacks URL redirects to All Calls instead of 404ing', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());

    const response = await agent.get(DASHBOARD);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(CALLS);
  });

  test('no page links to the retired Callbacks page', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ status: 'needs_callback' }));
    const { agent } = await loggedIn(reader);

    for (const url of [CALLS, NEEDS_CALLBACK, RESERVATIONS]) {
      const { text } = await agent.get(url);
      expect(text, url).not.toMatch(/href="\/staff\/dashboard/);
      expect(text, url).not.toContain('>Callbacks<');
    }
  });
});

describe('staff can reach summary and status ONLY — never a transcript or audio (work order §5)', () => {
  const hostile = (): SeededCall =>
    ({
      ...sampleCall({ summary: 'Safe summary.', status: 'reservation_made' }),
      transcript: 'SECRET-TRANSCRIPT-TEXT',
      fullTranscript: 'SECRET-TRANSCRIPT-TEXT',
      recordingUrl: 'https://recordings.example/SECRET-AUDIO',
      audioUrl: 'https://recordings.example/SECRET-AUDIO',
      driveUrl: 'https://drive.google.com/file/d/SECRET-AUDIO/view',
    }) as SeededCall;

  test.each([CALLS, RESERVATIONS])(
    '%s renders only allow-listed fields even if the reader returned extra ones',
    async (url) => {
      const reader = new MemoryCallLogReader();
      reader.seed(hostile());
      reader.seedReservation({
        ...sampleReservation(),
        transcript: 'SECRET-TRANSCRIPT-TEXT',
        recordingUrl: 'https://recordings.example/SECRET-AUDIO',
      } as ReturnType<typeof sampleReservation>);
      const { agent } = await loggedIn(reader);

      const { text } = await agent.get(url);

      expect(text).not.toContain('SECRET');
      expect(text).not.toMatch(/transcript|recording|audio|drive\.google/i);
    },
  );

  test('there is no staff route that serves a transcript or audio', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());
    for (const url of [
      '/staff/transcript',
      '/staff/transcripts/call-1',
      '/staff/calls/call-1/transcript',
      '/staff/calls/call-1/audio',
      '/staff/calls/call-1/recording',
      '/staff/recordings/call-1',
    ]) {
      expect((await agent.get(url)).status).toBe(404);
    }
  });

  test('the staff-facing source cannot even reference the developer archive', () => {
    const root = path.resolve(import.meta.dirname, '../../src');
    const files = [
      ...readdirSync(path.join(root, 'routes'))
        .filter((name) => name.startsWith('staff'))
        .map((name) => path.join(root, 'routes', name)),
      path.join(root, 'middleware', 'staffSession.ts'),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);

    const forbidden =
      /call_archive_jobs|archiveJob|ArchiveService|ArchiveJobRepository|transcript|recording|presigned|audio|google\//i;
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
      expect(code, path.basename(file)).not.toMatch(forbidden);
    }
  });
});
