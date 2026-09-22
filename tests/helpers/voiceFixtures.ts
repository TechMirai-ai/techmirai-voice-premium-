/** Shared fixtures for the voice webhook tests: an app with in-memory doubles and Vapi envelopes. */
import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import type { CallbackNotifier, CallbackNotification } from '../../src/lib/callbackNotifier.js';
import type {
  CallbackRequestRepository,
  NewCallbackRequest,
} from '../../src/repositories/callbackRequestRepository.js';
import type {
  CallTopicRepository,
  NewCallTopic,
} from '../../src/repositories/callTopicRepository.js';
import type { AssistantResolver } from '../../src/vapi/assistantResolver.js';
import type { VoiceRouterOptions } from '../../src/routes/voiceRouter.js';
import type { RateLimitOptions } from '../../src/middleware/rateLimit.js';
import { buildStaffOptions } from './staffFixtures.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const CLIENT_ID = 'sakura-seikotsuin';
export const CALL_ID = 'call-123';
export const TOOL_CALL_ID = 'toolcall-abc';
export const AUTH = { Authorization: `Bearer ${WEBHOOK_SECRET}` };

export const CALLER_NAME = 'Hanako Yamada';
export const CALLER_PHONE = '090-1234-5678';

export const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [] }) };

export class MemoryCallbacks implements CallbackRequestRepository {
  readonly saved: NewCallbackRequest[] = [];
  failWith: Error | undefined;

  create(request: NewCallbackRequest): Promise<CallbackNotification> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push(request);
    return Promise.resolve({ ...request, id: 'cb-1', createdAt: new Date(0) });
  }
}

export class MemoryTopics implements CallTopicRepository {
  readonly recorded: NewCallTopic[] = [];
  failWith: Error | undefined;

  record(topic: NewCallTopic): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.recorded.push(topic);
    return Promise.resolve();
  }
}

export class MemoryNotifier implements CallbackNotifier {
  readonly notified: CallbackNotification[] = [];
  failWith: Error | undefined;

  notify(callback: CallbackNotification): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.notified.push(callback);
    return Promise.resolve();
  }
}

/** Knows one assistant: `sakura-seikotsuin--ja`, id `assistant-ja`. */
export const resolver: AssistantResolver = {
  resolve: (ref) =>
    ref.id === 'assistant-ja' || ref.name === 'sakura-seikotsuin--ja'
      ? { clientId: CLIENT_ID, language: 'ja' }
      : undefined,
};

export function buildVoiceApp(options: { rateLimit?: RateLimitOptions } = {}) {
  const callbacks = new MemoryCallbacks();
  const topics = new MemoryTopics();
  const notifier = new MemoryNotifier();
  const voiceOptions: VoiceRouterOptions = {
    webhookSecret: WEBHOOK_SECRET,
    resolver,
    knowledge: new FileKnowledgeSource(),
    callbacks,
    topics,
    notifier,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
  };
  const app = createApp({
    db: healthyDb,
    isProduction: false,
    voice: voiceOptions,
    staff: buildStaffOptions(),
  });
  return { app, callbacks, topics, notifier, voiceOptions };
}

type ToolCallShape = 'sdk' | 'docs';

/** A tool-calls envelope in either of the two shapes Vapi's SDK types and docs describe. */
export function toolCallsBody(
  toolName: string,
  args: Record<string, unknown>,
  shape: ToolCallShape = 'sdk',
  overrides: { assistant?: Record<string, unknown> | null; callId?: string } = {},
) {
  const toolCall =
    shape === 'sdk'
      ? {
          id: TOOL_CALL_ID,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }
      : { id: TOOL_CALL_ID, name: toolName, parameters: args };

  return {
    message: {
      type: 'tool-calls',
      call: { id: overrides.callId ?? CALL_ID, squadId: 'squad-1' },
      ...(overrides.assistant === null
        ? {}
        : {
            assistant: overrides.assistant ?? { id: 'assistant-ja', name: 'sakura-seikotsuin--ja' },
          }),
      toolCallList: [toolCall],
      toolWithToolCallList: [{ type: 'function', toolCall }],
    },
  };
}
