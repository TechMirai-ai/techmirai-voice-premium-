import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import type { ArchiveReportInput, InlineOutcome } from '../../src/google/archiveService.js';
import { AUTH, buildVoiceApp, CALL_ID } from '../helpers/voiceFixtures.js';

const PATH = '/api/voice/end-of-call-report';

function reportBody(artifact: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'assistant-ended-call',
      startedAt: '2026-10-12T01:00:00.000Z',
      endedAt: '2026-10-12T01:02:00.000Z',
      call: { id: CALL_ID },
      assistant: { id: 'assistant-ja', name: 'sakura-seikotsuin--ja' },
      analysis: { summary: 'Caller asked about parking.' },
      artifact: {
        transcript: 'AI: Hello\nUser: Hi',
        messages: [],
        structuredOutputs: {
          so1: { name: 'outcome', result: { topic: 'parking', resolved: true } },
        },
        ...artifact,
      },
      ...message,
    },
  };
}

describe('POST /api/voice/end-of-call-report', () => {
  test('rejects a request without the webhook secret', async () => {
    const { app, callLogs } = buildVoiceApp();
    await request(app).post(PATH).send(reportBody()).expect(401);
    expect(callLogs.recorded).toEqual([]);
  });

  test('rejects a body that is not an end-of-call-report', async () => {
    const { app } = buildVoiceApp();
    await request(app)
      .post(PATH)
      .set(AUTH)
      .send({ message: { type: 'tool-calls', call: { id: 'x' } } })
      .expect(400);
  });

  test('records a resolved FAQ call with the client and language derived server-side', async () => {
    const { app, callLogs } = buildVoiceApp();
    await request(app).post(PATH).set(AUTH).send(reportBody()).expect(200);
    expect(callLogs.recorded).toEqual([
      {
        clientId: 'sakura-seikotsuin',
        callId: CALL_ID,
        language: 'ja',
        status: 'resolved_by_ai',
        topic: 'parking',
        summary: 'Caller asked about parking.',
        endedReason: 'assistant-ended-call',
        startedAt: '2026-10-12T01:00:00.000Z',
        endedAt: '2026-10-12T01:02:00.000Z',
      },
    ]);
  });

  test('a successful booking is recorded as reservation_made with the matched patient', async () => {
    const { app, callLogs } = buildVoiceApp();
    const messages = [
      {
        role: 'tool_call_result',
        toolCallId: 't1',
        name: 'lookup_patient',
        result: 'Found: ヤマダ タロウ.',
      },
      {
        role: 'tool_call_result',
        toolCallId: 't2',
        name: 'book_appointment',
        result: 'Booked. Reservation number: R000001.',
      },
    ];
    await request(app).post(PATH).set(AUTH).send(reportBody({ messages })).expect(200);
    expect(callLogs.recorded[0]).toMatchObject({
      status: 'reservation_made',
      matchedPatientName: 'ヤマダ タロウ',
    });
  });

  test('a callback request is recorded as needs_callback with the caller name', async () => {
    const { app, callLogs } = buildVoiceApp();
    const messages = [
      {
        role: 'tool_calls',
        toolCalls: [
          {
            id: 't1',
            function: { name: 'request_callback', arguments: '{"callerName":"Hanako"}' },
          },
        ],
      },
      { role: 'tool_call_result', toolCallId: 't1', name: 'request_callback', result: 'saved' },
    ];
    await request(app).post(PATH).set(AUTH).send(reportBody({ messages })).expect(200);
    expect(callLogs.recorded[0]).toMatchObject({ status: 'needs_callback', callerName: 'Hanako' });
  });

  test('a call whose structured output failed is recorded as unresolved', async () => {
    const { app, callLogs } = buildVoiceApp();
    const structuredOutputs = { so1: { name: 'outcome', result: null } };
    await request(app).post(PATH).set(AUTH).send(reportBody({ structuredOutputs })).expect(200);
    expect(callLogs.recorded[0]).toMatchObject({ status: 'unresolved' });
  });

  test('never stores the transcript or recording link on the staff row', async () => {
    const { app, callLogs } = buildVoiceApp();
    await request(app)
      .post(PATH)
      .set(AUTH)
      .send(reportBody({ presignedMonoUrl: 'https://signed.example/a.wav' }))
      .expect(200);
    const row = JSON.stringify(callLogs.recorded[0]);
    expect(row).not.toContain('Hello');
    expect(row).not.toContain('signed.example');
  });

  test('answers 200 and records nothing when the assistant is unknown', async () => {
    const { app, callLogs } = buildVoiceApp();
    const body = reportBody({}, { assistant: { id: 'someone-else', name: 'unknown--ja' } });
    await request(app).post(PATH).set(AUTH).send(body).expect(200);
    expect(callLogs.recorded).toEqual([]);
  });

  describe('developer archive hand-off', () => {
    const archiver = () => {
      const archiveReport = vi.fn((_input: ArchiveReportInput) =>
        Promise.resolve<InlineOutcome>('done'),
      );
      return { archiveReport };
    };

    test('hands the full transcript to the archiver AFTER the staff row is saved', async () => {
      const archive = archiver();
      const { app, callLogs } = buildVoiceApp({ archive });
      archive.archiveReport.mockImplementation(() => {
        // by the time the archiver runs, the staff row must already exist
        expect(callLogs.recorded).toHaveLength(1);
        return Promise.resolve('done');
      });

      await request(app)
        .post(PATH)
        .set(AUTH)
        .send(reportBody({ presignedMonoUrl: 'https://signed.example/a.wav' }))
        .expect(200);

      expect(archive.archiveReport).toHaveBeenCalledWith({
        clientId: 'sakura-seikotsuin',
        callId: CALL_ID,
        transcript: 'AI: Hello\nUser: Hi',
        startedAt: '2026-10-12T01:00:00.000Z',
        endedReason: 'assistant-ended-call',
        presignedMonoUrl: 'https://signed.example/a.wav',
      });
    });

    test('an archiver failure never changes the response or loses the staff row', async () => {
      const archive = archiver();
      archive.archiveReport.mockRejectedValue(new Error('Google exploded'));
      const { app, callLogs } = buildVoiceApp({ archive });

      await request(app).post(PATH).set(AUTH).send(reportBody()).expect(200);

      expect(callLogs.recorded).toHaveLength(1);
    });

    test('no archive is attempted when the staff row could not be saved', async () => {
      const archive = archiver();
      const { app, callLogs } = buildVoiceApp({ archive });
      callLogs.failWith = new Error('db down');

      await request(app).post(PATH).set(AUTH).send(reportBody()).expect(500);

      expect(archive.archiveReport).not.toHaveBeenCalled();
    });

    test('the staff row never contains the transcript even when archiving is on', async () => {
      const { app, callLogs } = buildVoiceApp({ archive: archiver() });

      await request(app).post(PATH).set(AUTH).send(reportBody()).expect(200);

      expect(JSON.stringify(callLogs.recorded[0])).not.toContain('Hello');
    });

    test('works with no archive configured (the default before Google is set up)', async () => {
      const { app, callLogs } = buildVoiceApp();
      await request(app).post(PATH).set(AUTH).send(reportBody()).expect(200);
      expect(callLogs.recorded).toHaveLength(1);
    });
  });

  test('answers 500 when the database write fails, so the failure is visible', async () => {
    const { app, callLogs } = buildVoiceApp();
    callLogs.failWith = new Error('db down');
    await request(app).post(PATH).set(AUTH).send(reportBody()).expect(500);
  });
});
