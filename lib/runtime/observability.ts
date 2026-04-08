type LogLevel = 'info' | 'warn' | 'error';

type LogContext = Record<string, unknown>;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ event: 'log_serialization_failed' });
  }
}

export function logMcpEvent(event: string, context: LogContext = {}, level: LogLevel = 'info'): void {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...context
  };

  const serialized = safeStringify(payload);

  if (level === 'error') {
    console.error('[mcp]', serialized);
    return;
  }

  if (level === 'warn') {
    console.warn('[mcp]', serialized);
    return;
  }

  console.info('[mcp]', serialized);
}

export function logMcpError(event: string, error: unknown, context: LogContext = {}): void {
  logMcpEvent(event, {
    ...context,
    error: serializeError(error)
  }, 'error');
}