/**
 * Maps the assistant a webhook came from to `{ clientId, language }`, so the
 * server derives both itself and never trusts a model-supplied parameter
 * (VP-2 §4.3, VAPI-FACTS.md VP-4 R2).
 *
 * Source of truth is the committed `.vapi-state.<clientId>.json` (assistant
 * name → id) plus each client's supported languages. Read on every lookup:
 * the files are tiny and a fresh `vapi:sync` must take effect without a restart.
 */
import { existsSync, readdirSync } from 'node:fs';

import { defaultClientsDir, loadClient, type LoadClientOptions } from '../config/loadClient.js';
import type { StateStoreOptions } from './stateStore.js';
import { readState } from './stateStore.js';
import { assistantResourceName, contentLanguageOf, squadMemberIds } from './squad.js';

export interface ResolvedAssistant {
  clientId: string;
  language: string;
}

export interface AssistantRef {
  id?: string;
  name?: string;
}

export interface AssistantResolver {
  resolve(ref: AssistantRef): ResolvedAssistant | undefined;
}

export interface StateFileResolverOptions {
  clientsDir?: LoadClientOptions['clientsDir'];
  repoRoot?: StateStoreOptions['repoRoot'];
}

export class StateFileAssistantResolver implements AssistantResolver {
  constructor(private readonly options: StateFileResolverOptions = {}) {}

  resolve(ref: AssistantRef): ResolvedAssistant | undefined {
    const clientsDir = this.options.clientsDir ?? defaultClientsDir();
    if (!existsSync(clientsDir)) return undefined;

    const clientIds = readdirSync(clientsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const clientId of clientIds) {
      // One clinic's unreadable state file must not break the others.
      try {
        const name = ref.name ?? this.nameForId(clientId, ref.id);
        const language = name === undefined ? undefined : this.languageOf(clientId, name);
        if (language !== undefined && this.idMatches(clientId, name, ref.id)) {
          return { clientId, language };
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private stateOptions(): StateStoreOptions {
    return this.options.repoRoot ? { repoRoot: this.options.repoRoot } : {};
  }

  /** Reverse lookup: which assistant name does this id belong to, if any. */
  private nameForId(clientId: string, id: string | undefined): string | undefined {
    if (!id) return undefined;
    const { assistants } = readState(clientId, this.stateOptions());
    return Object.entries(assistants).find(([, value]) => value === id)?.[0];
  }

  /** When both are sent, they must agree with the state file — a name alone never overrides a known id. */
  private idMatches(clientId: string, name: string | undefined, id: string | undefined): boolean {
    if (!id || !name) return true;
    const known = readState(clientId, this.stateOptions()).assistants[name];
    return known === undefined || known === id;
  }

  /**
   * The content language a synced assistant *name* speaks — resolved via
   * every squad member id (language codes plus the default language's
   * "-return" variant, VP-7 R1), not just `languages.supported` directly, so
   * a `request_callback`/`log_call_topic` webhook call arriving from the
   * "-return" leg still resolves to its real content language.
   */
  private languageOf(clientId: string, name: string): string | undefined {
    try {
      const loadOptions = this.options.clientsDir ? { clientsDir: this.options.clientsDir } : {};
      const config = loadClient(clientId, loadOptions);
      const memberId = squadMemberIds(config).find(
        (id) => assistantResourceName(clientId, id) === name,
      );
      return memberId === undefined ? undefined : contentLanguageOf(config, memberId);
    } catch {
      return undefined;
    }
  }
}
