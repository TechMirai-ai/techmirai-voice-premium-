/** A single validation problem, always tied to an exact path in client.yaml. */
export interface ConfigIssue {
  /** e.g. `faq[3].answer.en` or `languages.default`. */
  path: string;
  message: string;
}

/** Thrown when a client.yaml is invalid. Lists every problem, not just the first. */
export class ClientConfigError extends Error {
  readonly clientId: string;
  readonly issues: ConfigIssue[];

  constructor(clientId: string, issues: ConfigIssue[]) {
    super(formatMessage(clientId, issues));
    this.name = 'ClientConfigError';
    this.clientId = clientId;
    this.issues = issues;
  }
}

export function formatMessage(clientId: string, issues: ConfigIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [`Invalid client config for "${clientId}":`, ...lines].join('\n');
}
