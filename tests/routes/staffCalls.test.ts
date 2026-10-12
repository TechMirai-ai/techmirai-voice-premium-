import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { hashPassword } from '../../src/lib/auth.js';
import {
  buildStaffApp,
  MemoryCallbackAdmin,
  MemoryCallLogReader,
  MemoryStaffUsers,
  OTHER_CLIENT_ID,
  sampleCall,
  sampleCallback,
  STAFF_CLIENT_ID,
  type SeededCall,
} from '../helpers/staffFixtures.js';

const CALLS = '/staff/calls';
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

describe('access control', () => {
  test.each([CALLS, RESERVATIONS])(
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
  test('lists the client’s calls with a readable status badge and the AI summary', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ id: 'r1', status: 'needs_callback', summary: 'Wants a callback.' }));
    const { agent } = await loggedIn(reader);

    const response = await agent.get(CALLS);

    expect(response.status).toBe(200);
    expect(response.text).toContain('Needs Callback');
    expect(response.text).toContain('Wants a callback.');
    expect(response.text).toContain('class="status-badge status-needs_callback"');
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

    const filtered = await agent.get(`${CALLS}?status=needs_callback`);
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

describe('GET /staff/reservations', () => {
  test('lists reservation_made calls with the booking details', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(
      sampleCall({
        id: 'r1',
        status: 'reservation_made',
        reservationNumber: 'R000042',
        appointmentDate: '2026-10-20',
        appointmentTime: '10:30',
        serviceName: 'General Consultation',
      }),
    );
    reader.seed(sampleCall({ id: 'r2', status: 'needs_callback', summary: 'NOT-A-RESERVATION' }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(RESERVATIONS);

    expect(text).toContain('R000042');
    expect(text).toContain('2026-10-20');
    expect(text).toContain('10:30');
    expect(text).toContain('General Consultation');
    expect(text).not.toContain('NOT-A-RESERVATION');
  });

  test('a reservation call whose booking row is missing still shows, without made-up details', async () => {
    const reader = new MemoryCallLogReader();
    reader.seed(sampleCall({ status: 'reservation_made', summary: 'Booked a visit.' }));
    const { agent } = await loggedIn(reader);

    const { text } = await agent.get(RESERVATIONS);

    expect(text).toContain('Booked a visit.');
    expect(text).toContain('Booking details unavailable');
  });

  test('says so when there are no reservations yet', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());
    expect((await agent.get(RESERVATIONS)).text).toContain('No reservations yet.');
  });
});

describe('navigation', () => {
  test('every staff page links to the three views and marks the current one', async () => {
    const { agent } = await loggedIn(new MemoryCallLogReader());

    for (const [url, current] of [
      [CALLS, 'All Calls'],
      [DASHBOARD, 'Callbacks'],
      [RESERVATIONS, 'Reservations'],
    ] as const) {
      const { text } = await agent.get(url);
      for (const label of ['All Calls', 'Callbacks', 'Reservations']) expect(text).toContain(label);
      expect(text).toMatch(new RegExp(`aria-current="page"[^>]*>${current}<`));
    }
  });

  test('the existing callbacks page is unchanged in behaviour (rows and mark-handled still there)', async () => {
    const callbacks = new MemoryCallbackAdmin();
    callbacks.seed(sampleCallback({ id: 'cb-1', callerName: 'Hanako Yamada' }));
    const { agent } = await loggedIn(new MemoryCallLogReader(), callbacks);

    const { text } = await agent.get(DASHBOARD);

    expect(text).toContain('id="callback-cb-1"');
    expect(text).toContain('Mark as handled');
  });
});

describe('staff can reach summary and status ONLY — never a transcript or audio (work order §5)', () => {
  const hostile = (): SeededCall =>
    ({
      ...sampleCall({ summary: 'Safe summary.' }),
      transcript: 'SECRET-TRANSCRIPT-TEXT',
      fullTranscript: 'SECRET-TRANSCRIPT-TEXT',
      recordingUrl: 'https://recordings.example/SECRET-AUDIO',
      audioUrl: 'https://recordings.example/SECRET-AUDIO',
      driveUrl: 'https://drive.google.com/file/d/SECRET-AUDIO/view',
    }) as SeededCall;

  test.each([CALLS, RESERVATIONS, DASHBOARD])(
    '%s renders only allow-listed fields even if the reader returned extra ones',
    async (url) => {
      const reader = new MemoryCallLogReader();
      reader.seed({ ...hostile(), status: 'reservation_made' });
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
