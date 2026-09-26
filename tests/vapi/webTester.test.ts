import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createWebTesterApp, DEFAULT_CLIENT_ID } from '../../src/vapi/webTester.js';
import type { CallModelFn } from '../../src/vapi/textTester.js';
import type { CallbackRequestRepository } from '../../src/repositories/callbackRequestRepository.js';

describe('webTester app', () => {
  test('serves the single-page HTML test interface on GET /', async () => {
    const app = createWebTesterApp();
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('AI Prompt Text Tester');
    expect(response.text).toContain('id="member-select"');
    expect(response.text).toContain('id="persist-toggle"');
    expect(response.text).toContain('id="timeline"');
    expect(response.text).toContain('id="user-input"');
    expect(response.text).toContain('id="send-button"');
  });

  test('returns configuration with squad members on GET /api/config', async () => {
    const app = createWebTesterApp();
    const response = await request(app).get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.defaultClientId).toBe(DEFAULT_CLIENT_ID);
    expect(response.body.members).toEqual(['ja', 'en', 'ja-return']);
    expect(response.body.model).toBeDefined();
  });

  test('initializes a new session on POST /api/session for default ja', async () => {
    const app = createWebTesterApp();
    const response = await request(app)
      .post('/api/session')
      .send({ member: 'ja', persist: false });

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBeDefined();
    expect(response.body.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(response.body.member).toBe('ja');
    expect(response.body.language).toBe('ja');
    expect(response.body.persist).toBe(false);
    expect(response.body.greeting).toContain('さくら整骨院');
  });

  test('initializes a new session for en member with English greeting', async () => {
    const app = createWebTesterApp();
    const response = await request(app)
      .post('/api/session')
      .send({ member: 'en', persist: false });

    expect(response.status).toBe(200);
    expect(response.body.member).toBe('en');
    expect(response.body.language).toBe('en');
    expect(response.body.greeting).toContain('Sakura Say-koh-tsoo-in');
  });

  test('runs a conversational turn on POST /api/turn and returns agent reply', async () => {
    const mockCaller: CallModelFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: 'はい、営業時間は朝9時から夜19時までとなっております。',
    });

    const app = createWebTesterApp({ callModel: mockCaller });

    const sessionRes = await request(app)
      .post('/api/session')
      .send({ member: 'ja', persist: false });
    const sessionId = sessionRes.body.sessionId;

    const turnRes = await request(app)
      .post('/api/turn')
      .send({ sessionId, message: '営業時間を教えてください' });

    expect(turnRes.status).toBe(200);
    expect(turnRes.body.agentReply).toBe('はい、営業時間は朝9時から夜19時までとなっております。');
    expect(turnRes.body.ended).toBe(false);
    expect(turnRes.body.toolCalls).toEqual([]);
  });

  test('captures and formats tool calls (e.g. request_callback) during a turn', async () => {
    let callCount = 0;
    const mockCaller: CallModelFn = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'request_callback',
                arguments: JSON.stringify({
                  callerName: '山田 太郎',
                  callerPhone: '090-1234-5678',
                  reason: '腰痛の相談',
                }),
              },
            },
          ],
        });
      }
      return Promise.resolve({
        role: 'assistant',
        content: '承知いたしました。担当者より折り返しご連絡いたします。',
      });
    });

    const app = createWebTesterApp({ callModel: mockCaller });

    const sessionRes = await request(app)
      .post('/api/session')
      .send({ member: 'ja', persist: false });
    const sessionId = sessionRes.body.sessionId as string;

    const turnRes = await request(app)
      .post('/api/turn')
      .send({ sessionId, message: '折り返しの電話をお願いできますか？' });

    expect(turnRes.status).toBe(200);
    expect(turnRes.body.toolCalls).toHaveLength(1);
    expect(turnRes.body.toolCalls[0].name).toBe('request_callback');
    expect(turnRes.body.toolCalls[0].arguments).toEqual({
      callerName: '山田 太郎',
      callerPhone: '090-1234-5678',
      reason: '腰痛の相談',
    });
    expect(turnRes.body.toolCalls[0].result).toBe('Success.');
    expect(turnRes.body.agentReply).toBe('承知いたしました。担当者より折り返しご連絡いたします。');
  });

  test('only writes to database repository when persist is enabled', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      id: 'cb-test-1',
      clientId: DEFAULT_CLIENT_ID,
      callId: 'call-1',
      language: 'ja',
      callerName: '山田 太郎',
      callerPhone: '090-1234-5678',
      reason: null,
      status: 'pending',
      createdAt: new Date(),
      handledAt: null,
      handledBy: null,
    });

    const mockCallbacks: CallbackRequestRepository = {
      create: mockCreate,
    };

    let callCount = 0;
    const mockCaller: CallModelFn = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount % 2 === 1) {
        return Promise.resolve({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${callCount}`,
              type: 'function',
              function: {
                name: 'request_callback',
                arguments: JSON.stringify({ callerName: '山田 太郎', callerPhone: '090-1234-5678' }),
              },
            },
          ],
        });
      }
      return Promise.resolve({ role: 'assistant', content: '受付いたしました。' });
    });

    const app = createWebTesterApp({ callModel: mockCaller, callbacks: mockCallbacks });

    // 1. Session with persist = false: mockCreate should NOT be called
    const session1 = (
      await request(app).post('/api/session').send({ member: 'ja', persist: false })
    ).body.sessionId as string;

    await request(app).post('/api/turn').send({ sessionId: session1, message: '折り返し' });
    expect(mockCreate).not.toHaveBeenCalled();

    // 2. Session with persist = true: mockCreate SHOULD be called
    const session2 = (
      await request(app).post('/api/session').send({ member: 'ja', persist: true })
    ).body.sessionId as string;

    await request(app).post('/api/turn').send({ sessionId: session2, message: '折り返し' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        callerName: '山田 太郎',
        callerPhone: '090-1234-5678',
      }),
    );
  });

  test('marks turn as ended when endCall tool is invoked', async () => {
    const mockCaller: CallModelFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: '失礼いたします。',
      tool_calls: [
        {
          id: 'call_end',
          type: 'function',
          function: { name: 'endCall', arguments: '{}' },
        },
      ],
    });

    const app = createWebTesterApp({ callModel: mockCaller });

    const sessionRes = await request(app).post('/api/session').send({ member: 'ja' });
    const turnRes = await request(app)
      .post('/api/turn')
      .send({ sessionId: sessionRes.body.sessionId as string, message: 'さようなら' });

    expect(turnRes.status).toBe(200);
    expect(turnRes.body.ended).toBe(true);
    expect(
      (turnRes.body.toolCalls as { name: string }[]).some((t) => t.name === 'endCall'),
    ).toBe(true);
  });
});
