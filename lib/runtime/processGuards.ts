import { logMcpError } from '@/lib/runtime/observability';

const globalProcessState = globalThis as typeof globalThis & {
  __mcpProcessGuardsInstalled?: boolean;
};

function logFatalEvent(label: string, error: unknown): void {
  logMcpError(`process.${label}`, error);
}

export function installProcessGuards(): void {
  if (globalProcessState.__mcpProcessGuardsInstalled) {
    return;
  }

  globalProcessState.__mcpProcessGuardsInstalled = true;

  if (typeof process === 'undefined' || typeof process.on !== 'function') {
    return;
  }

  process.on('unhandledRejection', (reason) => {
    logFatalEvent('unhandledRejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logFatalEvent('uncaughtException', error);
  });
}