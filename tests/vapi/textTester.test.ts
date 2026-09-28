import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { renderAssistant } from '../../src/vapi/render.js';
import {
  buildToolDefs,
  formatAgentLine,
  formatToolCallLine,
  handleToolCall,
  initialMessages,
  parseTextTesterArgs,
  resolveNowPlaceholders,
  runTurn,
  type CallModelFn,
  type ChatMessage,
  type ChatToolCall,
  type ToolCallHandlerDeps,
} from '../../src/vapi/textTester.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { MemoryCallbacks } from '../helpers/voiceFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const OPTIONS = { baseUrl: 'https://text-tester.invalid', credentialId: 'text-tester' };
const knowledge = new FileKnowledgeSource();

async function renderedFor(memberId: string) {
  const config = loadClient(SAKURA_ID);
  const faq = await knowledge.listFaq(SAKURA_ID);
  return renderAssistant(config, memberId, faq, OPTIONS);
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('buildToolDefs', () => {
  test('includes request_callback, log_call_topic and endCall for every member', async () => {
    const rendered = await renderedFor('ja');

    const tools = buildToolDefs(rendered).map((tool) => tool.function.name);

    expect(tools).toContain('request_callback');
    expect(tools).toContain('log_call_topic');
    expect(tools).toContain('endCall');
  });

  test("ja's handoff tool becomes handoff_to_en, with the destination's description carried over", async () => {
    const rendered = await renderedFor('ja');

    const handoff = buildToolDefs(rendered).find((tool) => tool.function.name === 'handoff_to_en');

    expect(handoff).toBeDefined();
    expect(handoff?.function.parameters.properties.destination?.enum).toEqual(['en']);
    expect(handoff?.function.description).toContain('"en"');
  });

  test("en's handoff tool is handoff_to_ja — same as what the model sees, even though it actually resolves to ja-return", async () => {
    const rendered = await renderedFor('en');

    const names = buildToolDefs(rendered).map((tool) => tool.function.name);

    expect(names).toContain('handoff_to_ja');
    expect(names).not.toContain('handoff_to_ja-return');
  });

  test('a single-language client gets no handoff tools, just the three fixed ones', () => {
    const config = buildMinimalConfig({ language: 'fr' });
    const rendered = renderAssistant(config, 'fr', config.faq, OPTIONS);

    expect(buildToolDefs(rendered).map((tool) => tool.function.name)).toEqual([
      'request_callback',
      'log_call_topic',
      'endCall',
    ]);
  });
});

describe('initialMessages', () => {
  test('seeds the system prompt (with "now" resolved) and the firstMessage as the opening assistant turn', async () => {
    const rendered = await renderedFor('ja');

    const messages = initialMessages(rendered);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'system',
      content: resolveNowPlaceholders(rendered.assistant.model.messages[0]?.content ?? ''),
    });
    // The raw, unresolved Liquid syntax must never reach OpenAI — it has no template engine of
    // its own and would otherwise be sent the literal placeholder text (VP-8 real bug: the model
    // guessed a date ~3 years off when this leaked through).
    expect(messages[0]?.content).not.toContain('{{"now"');
    expect(messages[1]).toEqual({ role: 'assistant', content: rendered.assistant.firstMessage });
  });
});

describe('resolveNowPlaceholders', () => {
  test('replaces the Liquid "now" placeholder with the real date/time in the given timezone', () => {
    const prompt = 'Today:\n{{"now" | date: "%A, %B %d, %Y, %H:%M", "Asia/Tokyo"}}\nEnd.';
    const now = new Date('2026-11-15T01:30:00Z'); // 10:30 JST on 2026-11-15 (a Sunday)

    expect(resolveNowPlaceholders(prompt, now)).toBe(
      'Today:\nSunday, November 15, 2026, 10:30\nEnd.',
    );
  });

  test('resolves a different timezone independently', () => {
    const prompt = '{{"now" | date: "%A, %B %d, %Y, %H:%M", "America/New_York"}}';
    const now = new Date('2026-11-15T01:30:00Z'); // 20:30 EST on 2026-11-14

    expect(resolveNowPlaceholders(prompt, now)).toBe('Saturday, November 14, 2026, 20:30');
  });

  test('leaves a prompt with no placeholder unchanged', () => {
    expect(resolveNowPlaceholders('No date here.')).toBe('No date here.');
  });

  test('defaults to the real current date when none is given', () => {
    const prompt = '{{"now" | date: "%A, %B %d, %Y, %H:%M", "UTC"}}';
    const currentYear = new Date().getUTCFullYear().toString();

    expect(resolveNowPlaceholders(prompt)).toContain(currentYear);
  });
});

describe('transcript formatting', () => {
  test('formatAgentLine prefixes with "Agent: "', () => {
    expect(formatAgentLine('Hello there.')).toBe('Agent: Hello there.');
  });

  test('formatToolCallLine prints the name and parsed arguments', () => {
    const call = toolCall('c1', 'request_callback', {
      callerName: 'ヤマダ タロウ',
      callerPhone: '09012345678',
    });

    expect(formatToolCallLine(call)).toBe(
      'Tool call: request_callback({"callerName":"ヤマダ タロウ","callerPhone":"09012345678"})',
    );
  });

  test('formatToolCallLine falls back to the raw string for unparseable arguments', () => {
    const call: ChatToolCall = {
      id: 'c1',
      type: 'function',
      function: { name: 'x', arguments: 'not json' },
    };

    expect(formatToolCallLine(call)).toBe('Tool call: x("not json")');
  });
});

describe('parseTextTesterArgs', () => {
  test('parses clientId, --member, --persist and --script together', () => {
    expect(
      parseTextTesterArgs([
        'sakura-seikotsuin',
        '--member',
        'ja-return',
        '--persist',
        '--script',
        'cases.txt',
      ]),
    ).toEqual({
      clientId: 'sakura-seikotsuin',
      member: 'ja-return',
      persist: true,
      scriptPath: 'cases.txt',
    });
  });

  test('persist defaults to false and scriptPath is omitted when not given', () => {
    expect(parseTextTesterArgs(['sakura-seikotsuin', '--member', 'en'])).toEqual({
      clientId: 'sakura-seikotsuin',
      member: 'en',
      persist: false,
    });
  });

  test('returns undefined when --member is missing', () => {
    expect(parseTextTesterArgs(['sakura-seikotsuin'])).toBeUndefined();
  });

  test('returns undefined when the clientId is missing', () => {
    expect(parseTextTesterArgs(['--member', 'ja'])).toBeUndefined();
  });
});

function makeDeps(overrides: Partial<ToolCallHandlerDeps> = {}): {
  deps: ToolCallHandlerDeps;
  lines: string[];
} {
  const lines: string[] = [];
  const deps: ToolCallHandlerDeps = {
    persist: false,
    clientId: SAKURA_ID,
    language: 'ja',
    callId: 'text-tester-1',
    printLine: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, lines };
}

describe('handleToolCall', () => {
  test('endCall ends the session and returns a result message', async () => {
    const { deps } = makeDeps();
    const call = toolCall('c1', 'endCall', {});

    const outcome = await handleToolCall(call, deps);

    expect(outcome.ended).toBe(true);
    expect(outcome.resultMessage).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'endCall',
      content: 'Call ended.',
    });
  });

  test('a handoff tool call ends the session and prints the limitation banner naming the target', async () => {
    const { deps, lines } = makeDeps();
    const call = toolCall('c1', 'handoff_to_en', { destination: 'en' });

    const outcome = await handleToolCall(call, deps);

    expect(outcome.ended).toBe(true);
    expect(lines.some((line) => line.includes('LIMITATION') && line.includes('--member en'))).toBe(
      true,
    );
  });

  test('log_call_topic does not end the session', async () => {
    const { deps } = makeDeps();
    const call = toolCall('c1', 'log_call_topic', { topic: 'hours', outcome: 'resolved' });

    const outcome = await handleToolCall(call, deps);

    expect(outcome.ended).toBe(false);
    expect(outcome.resultMessage.content).toBe('Success.');
  });

  test('request_callback does not write to the DB when persist is false', async () => {
    const callbacks = new MemoryCallbacks();
    const { deps, lines } = makeDeps({ persist: false, callbacks });
    const call = toolCall('c1', 'request_callback', {
      callerName: 'ヤマダ タロウ',
      callerPhone: '09012345678',
      reason: '電話での予約希望',
    });

    const outcome = await handleToolCall(call, deps);

    expect(callbacks.saved).toHaveLength(0);
    expect(outcome.ended).toBe(false);
    expect(lines.some((line) => line.startsWith('Persisted'))).toBe(false);
  });

  test('request_callback writes to the repository when persist is true, using the tool-call arguments', async () => {
    const callbacks = new MemoryCallbacks();
    const { deps, lines } = makeDeps({
      persist: true,
      callbacks,
      language: 'ja',
      callId: 'text-tester-42',
    });
    const call = toolCall('c1', 'request_callback', {
      callerName: 'ヤマダ タロウ',
      callerPhone: '09012345678',
      reason: '電話での予約希望',
    });

    await handleToolCall(call, deps);

    expect(callbacks.saved).toEqual([
      {
        clientId: SAKURA_ID,
        callId: 'text-tester-42',
        language: 'ja',
        callerName: 'ヤマダ タロウ',
        callerPhone: '09012345678',
        reason: '電話での予約希望',
      },
    ]);
    expect(lines.some((line) => line.startsWith('Persisted callback_requests row: cb-1'))).toBe(
      true,
    );
  });
});

describe('runTurn', () => {
  const NO_TOOLS: never[] = [];

  test('a plain-content reply with no tool calls ends the turn without ending the session', async () => {
    const { deps } = makeDeps();
    const callModel: CallModelFn = () =>
      Promise.resolve({ role: 'assistant', content: 'Sure, here you go.' });

    const result = await runTurn([], NO_TOOLS, callModel, deps);

    expect(result.ended).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Sure, here you go.' });
  });

  test('a tool call is fed back and the loop continues until a plain-content reply', async () => {
    const { deps, lines } = makeDeps();
    let call = 0;
    const callModel: CallModelFn = () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall('c1', 'log_call_topic', { topic: 'hours', outcome: 'resolved' })],
        });
      }
      return Promise.resolve({
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c2', 'endCall', {})],
      });
    };

    const result = await runTurn([], NO_TOOLS, callModel, deps);

    expect(result.ended).toBe(true);
    expect(call).toBe(2);
    expect(lines).toContain('Tool call: log_call_topic({"topic":"hours","outcome":"resolved"})');
    expect(lines).toContain('Tool call: endCall({})');
    // The tool result for the first call must be fed back before the model is called again.
    const toolResultIndex = result.messages.findIndex((m: ChatMessage) => m.role === 'tool');
    expect(toolResultIndex).toBeGreaterThan(-1);
  });

  test('stops after the round limit rather than looping forever on a misbehaving model', async () => {
    const { deps, lines } = makeDeps();
    const callModel: CallModelFn = () =>
      Promise.resolve({
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c', 'log_call_topic', { topic: 'hours', outcome: 'resolved' })],
      });

    const result = await runTurn([], NO_TOOLS, callModel, deps);

    expect(result.ended).toBe(false);
    expect(lines.some((line) => line.includes('round limit'))).toBe(true);
  });
});
