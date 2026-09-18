/**
 * The only way the rest of the system may read FAQ content.
 *
 * Today the FAQ lives in client.yaml. Later, staff will edit it in the admin
 * screen and it will live in the database (FUTURE-FEATURES F-1) — that change
 * must be a new implementation of this interface, nothing more.
 */
import type { LoadClientOptions } from '../config/loadClient.js';
import { loadClient } from '../config/loadClient.js';

export interface FaqEntry {
  id: string;
  tags: string[];
  question: Record<string, string>; // language code -> text
  answer: Record<string, string>;
}

export interface KnowledgeSource {
  listFaq(clientId: string): Promise<FaqEntry[]>;
}

/** Reads the FAQ from `clients/<clientId>/client.yaml`. */
export class FileKnowledgeSource implements KnowledgeSource {
  private readonly options: LoadClientOptions;

  constructor(options: LoadClientOptions = {}) {
    this.options = options;
  }

  listFaq(clientId: string): Promise<FaqEntry[]> {
    // Reading is synchronous today and asynchronous once the FAQ moves into the
    // database (F-1), so an invalid client id must come back as a rejected
    // promise, never as a synchronous throw.
    try {
      const config = loadClient(clientId, this.options);
      const entries: FaqEntry[] = config.faq.map((entry) => ({
        id: entry.id,
        tags: [...entry.tags],
        question: { ...entry.question },
        answer: { ...entry.answer },
      }));
      return Promise.resolve(entries);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
