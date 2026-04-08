declare module '*.mjs' {
  export class McpServer {
    constructor(...args: any[]);
    connect(...args: any[]): Promise<void>;
    registerTool(name: string, options: any, handler: (args: any) => any): void;
  }

  export class StdioServerTransport {
    constructor(...args: any[]);
    start(...args: any[]): Promise<void>;
    close(...args: any[]): Promise<void>;
    send(...args: any[]): Promise<void>;
  }
}