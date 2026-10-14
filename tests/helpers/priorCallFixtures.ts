import type { PriorCall, PriorCallReader } from '../../src/repositories/callLogRepository.js';

/** In-memory returning-caller lookup: seed `byPhone` with `"<clientId>|<normalised number>"` keys. */
export class MemoryPriorCalls implements PriorCallReader {
  readonly byPhone = new Map<string, PriorCall>();
  readonly lookups: { clientId: string; callerPhone: string }[] = [];
  failWith: Error | undefined;

  seed(clientId: string, callerPhone: string, prior: PriorCall): void {
    this.byPhone.set(`${clientId}|${callerPhone}`, prior);
  }

  findLatestByPhone(clientId: string, callerPhone: string): Promise<PriorCall | undefined> {
    this.lookups.push({ clientId, callerPhone });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.byPhone.get(`${clientId}|${callerPhone}`));
  }
}
