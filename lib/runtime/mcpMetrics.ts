type RequestMetrics = {
  totalRequests: number;
  jsonRpcRequests: number;
  legacyRequests: number;
  validationFailures: number;
  errors: number;
};

type SessionMetrics = {
  sessionsCreated: number;
  sessionsReused: number;
  transportsCreated: number;
  sseFailures: number;
  conflict409s: number;
  deleteRequests: number;
};

type McpMetricsState = {
  startedAt: number;
  request: RequestMetrics;
  session: SessionMetrics;
};

const globalMetricsState = globalThis as typeof globalThis & {
  __mcpMetricsState?: McpMetricsState;
};

export const MCP_METRICS: McpMetricsState = globalMetricsState.__mcpMetricsState ?? {
  startedAt: Date.now(),
  request: {
    totalRequests: 0,
    jsonRpcRequests: 0,
    legacyRequests: 0,
    validationFailures: 0,
    errors: 0
  },
  session: {
    sessionsCreated: 0,
    sessionsReused: 0,
    transportsCreated: 0,
    sseFailures: 0,
    conflict409s: 0,
    deleteRequests: 0
  }
};

globalMetricsState.__mcpMetricsState = MCP_METRICS;

export function getMcpMetricsSnapshot(): McpMetricsState & { uptimeMs: number } {
  return {
    startedAt: MCP_METRICS.startedAt,
    uptimeMs: Date.now() - MCP_METRICS.startedAt,
    request: { ...MCP_METRICS.request },
    session: { ...MCP_METRICS.session }
  };
}