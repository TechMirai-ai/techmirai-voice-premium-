import { describe, expect, test } from 'vitest';

import { parseEndOfCallReport } from '../../src/vapi/endOfCallReport.js';

const OUTPUT_ID = 'so-1';

function report(overrides: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}) {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'assistant-ended-call',
      startedAt: '2026-10-12T01:00:00.000Z',
      endedAt: '2026-10-12T01:02:00.000Z',
      call: { id: 'call-9', assistantId: 'assistant-ja' },
      assistant: { id: 'assistant-ja', name: 'sakura-seikotsuin--ja' },
      analysis: { summary: 'Caller asked about parking.' },
      artifact: {
        transcript: 'AI: Hello\nUser: Hi',
        messages: [],
        structuredOutputs: {
          [OUTPUT_ID]: { name: 'outcome', result: { topic: 'parking', resolved: true } },
        },
        presignedMonoUrl: 'https://signed.example/mono.wav',
        presignedUrlsExpiresAt: '2026-10-12T02:00:00.000Z',
        ...artifact,
      },
      ...overrides,
    },
  };
}

describe('parseEndOfCallReport', () => {
  test('returns undefined for anything that is not an end-of-call-report', () => {
    expect(
      parseEndOfCallReport({ message: { type: 'tool-calls', call: { id: 'x' } } }),
    ).toBeUndefined();
    expect(parseEndOfCallReport('nope')).toBeUndefined();
    expect(parseEndOfCallReport({ message: { type: 'end-of-call-report' } })).toBeUndefined();
  });

  test('extracts call identity, timing, summary, transcript and recording link', () => {
    const parsed = parseEndOfCallReport(report())!;
    expect(parsed.callId).toBe('call-9');
    expect(parsed.assistant).toEqual({ id: 'assistant-ja', name: 'sakura-seikotsuin--ja' });
    expect(parsed.endedReason).toBe('assistant-ended-call');
    expect(parsed.startedAt).toBe('2026-10-12T01:00:00.000Z');
    expect(parsed.summary).toBe('Caller asked about parking.');
    expect(parsed.recordingUrl).toBe('https://signed.example/mono.wav');
  });

  test('carries the full transcript through for the developer archive', () => {
    const parsed = parseEndOfCallReport(report())!;
    expect(parsed.transcript).toBe('AI: Hello\nUser: Hi');
  });

  test('a report with no transcript yields an empty one', () => {
    const parsed = parseEndOfCallReport(report({}, { transcript: undefined }))!;
    expect(parsed.transcript).toBe('');
  });

  test('reads topic and resolved from the first structured output with a result', () => {
    const parsed = parseEndOfCallReport(report())!;
    expect(parsed.topic).toBe('parking');
    expect(parsed.resolved).toBe(true);
  });

  test('takes the summary from the structured output, ahead of Vapi’s analysis.summary', () => {
    const parsed = parseEndOfCallReport(
      report(
        { analysis: { summary: 'From the deprecated analysisPlan.' } },
        {
          structuredOutputs: {
            [OUTPUT_ID]: {
              name: 'outcome',
              result: { topic: 'parking', resolved: true, summary: 'Asked where to park.' },
            },
          },
        },
      ),
    )!;
    expect(parsed.summary).toBe('Asked where to park.');
  });

  test('with Vapi’s analysis off (the live default), the summary still comes from the structured output', () => {
    const parsed = parseEndOfCallReport(
      report(
        { analysis: {} },
        {
          structuredOutputs: {
            [OUTPUT_ID]: {
              name: 'outcome',
              result: { topic: 'hours', summary: 'Asked the hours.' },
            },
          },
        },
      ),
    )!;
    expect(parsed.summary).toBe('Asked the hours.');
  });

  test('a blank structured summary falls back to analysis.summary, and to nothing if both are blank', () => {
    const blank = {
      structuredOutputs: {
        [OUTPUT_ID]: { name: 'outcome', result: { topic: 'x', summary: '  ' } },
      },
    };
    expect(parseEndOfCallReport(report({}, blank))!.summary).toBe('Caller asked about parking.');
    expect(parseEndOfCallReport(report({ analysis: {} }, blank))!.summary).toBeUndefined();
  });

  test('a null summary does not throw away topic and resolved', () => {
    const parsed = parseEndOfCallReport(
      report(
        { analysis: {} },
        {
          structuredOutputs: {
            [OUTPUT_ID]: {
              name: 'outcome',
              result: { topic: 'parking', resolved: true, summary: null },
            },
          },
        },
      ),
    )!;
    expect(parsed.topic).toBe('parking');
    expect(parsed.resolved).toBe(true);
    expect(parsed.summary).toBeUndefined();
  });

  test('caps an oversized summary so model output can never be stored unbounded', () => {
    const parsed = parseEndOfCallReport(
      report(
        {},
        {
          structuredOutputs: {
            [OUTPUT_ID]: { name: 'outcome', result: { topic: 'x', summary: 'a'.repeat(50_000) } },
          },
        },
      ),
    )!;
    expect(parsed.summary).toHaveLength(2000);
  });

  test('a null structured-output result leaves topic and resolved undefined', () => {
    const parsed = parseEndOfCallReport(
      report({}, { structuredOutputs: { [OUTPUT_ID]: { name: 'outcome', result: null } } }),
    )!;
    expect(parsed.topic).toBeUndefined();
    expect(parsed.resolved).toBeUndefined();
  });

  test('collects tool results by name and takes the caller name from request_callback args', () => {
    const parsed = parseEndOfCallReport(
      report(
        {},
        {
          messages: [
            {
              role: 'tool_calls',
              toolCalls: [
                {
                  id: 't1',
                  function: { name: 'request_callback', arguments: '{"callerName":"Hanako"}' },
                },
              ],
            },
            {
              role: 'tool_call_result',
              toolCallId: 't1',
              name: 'request_callback',
              result: 'saved',
            },
            {
              role: 'tool_call_result',
              toolCallId: 't2',
              name: 'lookup_patient',
              result: 'Found: ヤマダ タロウ.',
            },
            { role: 'bot', message: 'hi' },
          ],
        },
      ),
    )!;
    expect(parsed.toolResults.map((r) => r.name)).toEqual(['request_callback', 'lookup_patient']);
    expect(parsed.callerName).toBe('Hanako');
    expect(parsed.matchedPatientName).toBe('ヤマダ タロウ');
  });

  test('no patient match leaves matchedPatientName undefined', () => {
    const parsed = parseEndOfCallReport(
      report(
        {},
        {
          messages: [
            {
              role: 'tool_call_result',
              toolCallId: 't2',
              name: 'lookup_patient',
              result: 'No patient record was found for that name.',
            },
          ],
        },
      ),
    )!;
    expect(parsed.matchedPatientName).toBeUndefined();
  });
});
