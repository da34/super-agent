import { jsonSchema } from "ai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

type LockRequest = {
  readOnly: boolean;
  resolve: (release: () => void) => void;
};

class ToolExecutionLock {
  private activeReaders = 0;
  private activeWriter = false;
  private queue: LockRequest[] = [];

  acquire(readOnly: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ readOnly, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeWriter || this.queue.length === 0) return;

    const next = this.queue[0];
    if (!next.readOnly) {
      if (this.activeReaders > 0) return;

      this.queue.shift();
      this.activeWriter = true;
      next.resolve(() => {
        this.activeWriter = false;
        this.drain();
      });
      return;
    }

    while (this.queue[0]?.readOnly) {
      const reader = this.queue.shift()!;
      this.activeReaders++;
      reader.resolve(() => {
        this.activeReaders--;
        this.drain();
      });
    }
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private lock = new ToolExecutionLock();

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const lock = this.lock;
      const isSafe = tool.isConcurrencySafe === true;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          const release = await lock.acquire(isSafe);
          console.log(
            isSafe
              ? `  [并发] ${name} 获取共享锁`
              : `  [串行] ${name} 获取独占锁，等待其他工具完成`,
          );
          try {
            const raw = await executeFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            release();
          }
        },
      };
    }

    return result;
  }
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);

  const dropped = text.length - headSize - tailSize;
  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
