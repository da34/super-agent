import type { ModelMessage } from "ai";
import type { ToolRegistry } from "../tools";
import type { UsageTracker } from "../usage/tracker";

export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  tracker: UsageTracker;
  systemPrompt: string;
  modelName: string;
  modelId: string;
  windowTokens: number;
}

export type CommandResult = boolean | "async";
export type CommandHandler = (
  command: string,
  context: CommandContext,
) => CommandResult;

/**
 * 按注册顺序分发命令，第一个声明已处理的 Handler 会终止后续匹配。
 * `async` 预留给需要自行恢复 readline 循环的异步命令。
 */
export function createDispatcher(
  handlers: CommandHandler[],
): CommandHandler {
  return (command, context) => {
    for (const handler of handlers) {
      const result = handler(command, context);
      if (result) return result;
    }
    return false;
  };
}
