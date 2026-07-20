import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class MCPClient implements MCPToolClient {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.env,
      },
    });

    this.process.on("error", (error) => {
      console.error(`  [MCP] 进程启动失败: ${error.message}`);
    });

    this.process.stderr?.on("data", () => {});

    this.rl = createInterface({
      input: this.process.stdout!,
    });

    this.rl.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id === undefined || !this.pending.has(message.id)) return;

        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(
            new Error(`MCP error ${message.error.code}: ${message.error.message}`),
          );
          return;
        }

        pending.resolve(message.result);
      } catch {
        // 忽略非 JSON 行
      }
    });

    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "super-agent",
        version: "1.0.0",
      },
    });

    this.process.stdin!.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send("tools/list", {});
    return ((result as { tools?: MCPTool[] }).tools || []) as MCPTool[];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.send("tools/call", {
      name,
      arguments: args,
    })) as MCPCallResult;

    const texts = (result.content || [])
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text!);

    return texts.join("\n") || "(无返回内容)";
  }

  async close(): Promise<void> {
    this.rl?.close();
    this.process?.kill();
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 15000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      this.process!.stdin!.write(`${message}\n`);
    });
  }
}

export class MockMCPClient implements MCPToolClient {
  async connect(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: "list_issues",
        description: "列出 GitHub 仓库的 Issues",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "search_repositories",
        description: "搜索 GitHub 仓库",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_file_contents",
        description: "获取仓库中文件的内容",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "仓库所有者" },
            repo: { type: "string", description: "仓库名称" },
            path: { type: "string", description: "文件路径" },
          },
          required: ["owner", "repo", "path"],
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "list_issues":
        return JSON.stringify(
          [
            { number: 42, title: "支持 MCP 协议接入", state: "open" },
            { number: 41, title: "循环检测阈值可配置化", state: "open" },
            { number: 39, title: "Token 预算用完后的优雅降级", state: "closed" },
          ],
          null,
          2,
        );
      case "search_repositories":
        return JSON.stringify(
          [
            { full_name: "anthropics/anthropic-sdk-python", stars: 2800 },
            { full_name: "vercel/ai", stars: 12000 },
            { full_name: "modelcontextprotocol/servers", stars: 5600 },
          ],
          null,
          2,
        );
      case "get_file_contents":
        return `# README\n\nMock file: ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  async close(): Promise<void> {}
}
