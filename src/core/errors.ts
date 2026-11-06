/** Base error for the studio. `retryable` tells the queue whether a retry makes sense. */
export class StudioError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StudioError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class ConfigError extends StudioError {
  constructor(message: string) {
    super('CONFIG', message, false);
    this.name = 'ConfigError';
  }
}

export class ProviderError extends StudioError {
  constructor(provider: string, message: string, retryable = true, options?: { cause?: unknown }) {
    super(`PROVIDER_${provider.toUpperCase()}`, message, retryable, options);
    this.name = 'ProviderError';
  }
}

export class ValidationError extends StudioError {
  constructor(message: string) {
    super('VALIDATION', message, false);
    this.name = 'ValidationError';
  }
}

export class BudgetExceededError extends StudioError {
  constructor(message: string) {
    super('BUDGET', message, false);
    this.name = 'BudgetExceededError';
  }
}

export class AgentPausedError extends StudioError {
  constructor(agent: string) {
    super('AGENT_PAUSED', `Agent "${agent}" is paused`, false);
    this.name = 'AgentPausedError';
  }
}

export class PublishBlockedError extends StudioError {
  constructor(message: string) {
    super('PUBLISH_BLOCKED', message, false);
    this.name = 'PublishBlockedError';
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof StudioError ? err.retryable : true;
}
