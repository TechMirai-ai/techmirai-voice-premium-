import type { Queryable } from '../db/pool.js';
import type { CallOutcome } from '../lib/callTopics.js';

/** Deliberately has no personal-data field — see db/migrations/0003_call_topics.sql. */
export interface NewCallTopic {
  clientId: string;
  callId: string;
  topic: string;
  outcome: CallOutcome;
  language: string;
}

export interface CallTopicRepository {
  /** Idempotent per (client, call): a repeated tool call is ignored. */
  record(topic: NewCallTopic): Promise<void>;
}

export class PgCallTopicRepository implements CallTopicRepository {
  constructor(private readonly db: Queryable) {}

  async record(topic: NewCallTopic): Promise<void> {
    await this.db.query(
      `INSERT INTO call_topics (client_id, call_id, topic, outcome, language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id, call_id) DO NOTHING`,
      [topic.clientId, topic.callId, topic.topic, topic.outcome, topic.language],
    );
  }
}
