import type { ModelMessage } from "ai";
import {
  textToolResultOutput,
  toolResultOutputToText,
} from "./tool-result-output";

const CONTEXT_WINDOW = 200_000;
const ERROR_PATTERN = /error|失败|不存在|denied|timeout/i;

export class TokenTracker {
  private lastPreciseCount = 0;
  private pendingChars = 0;

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  addMessage(content: string): void {
    this.pendingChars += content.length;
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }
}

function messageChars(message: ModelMessage): number {
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;

  return message.content.reduce((chars, part) => {
    if ("text" in part && typeof part.text === "string") {
      return chars + part.text.length;
    }
    if ("output" in part) {
      return chars + toolResultOutputToText(part.output).length;
    }
    return chars;
  }, 0);
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce(
    (total, message) => total + messageChars(message),
    0,
  );
  return Math.ceil((chars / 4) * 1.2);
}

export interface TruncateConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

export interface TruncateResult {
  messages: ModelMessage[];
  truncated: number;
  compacted: number;
}

export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncateConfig = {
    maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,
    contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4,
  },
): TruncateResult {
  let truncated = 0;
  let compacted = 0;

  // 先约束单条结果，避免一个工具调用独占大部分上下文。
  const result = messages.map((message) => {
    if (message.role !== "tool") return message;

    const content = message.content.map((part) => {
      if (!("output" in part)) return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const headSize = Math.floor(config.maxSingleResult * 0.6);
      const tailSize = config.maxSingleResult - headSize;
      const head = outputText.slice(0, headSize);
      const tail = outputText.slice(-tailSize);
      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[truncated: ${outputText.length} → ${config.maxSingleResult} chars]\n\n${tail}`,
        ),
      };
    });

    return { ...message, content };
  });

  // 若总量仍超预算，从最老的工具结果开始释放空间。
  let totalChars = result.reduce(
    (total, message) => total + messageChars(message),
    0,
  );
  for (
    let index = 0;
    index < result.length && totalChars > config.contextBudgetChars;
    index++
  ) {
    const message = result[index];
    if (message.role !== "tool") continue;

    const oldSize = messageChars(message);
    const firstPart = message.content[0];
    const toolName =
      firstPart && "toolName" in firstPart ? firstPart.toolName : "unknown";
    const content = message.content.map((part) =>
      "output" in part
        ? {
            ...part,
            output: textToolResultOutput(
              `[compacted: ${toolName} output removed to free context]`,
            ),
          }
        : part,
    );
    const compactedMessage: ModelMessage = { ...message, content };
    const newSize = messageChars(compactedMessage);
    if (newSize >= oldSize) continue;

    result[index] = compactedMessage;
    totalChars += newSize - oldSize;
    compacted++;
  }

  return { messages: result, truncated, compacted };
}

export interface PruneConfig {
  softTTLMs: number;
  hardTTLMs: number;
  keepHeadTail: number;
}

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}

function softPruneMessage(
  message: Extract<ModelMessage, { role: "tool" }>,
  keepHeadTail: number,
): { message: ModelMessage; changed: boolean } {
  let changed = false;
  const content = message.content.map((part) => {
    if (!("output" in part)) return part;
    const outputText = toolResultOutputToText(part.output);
    if (outputText.length <= keepHeadTail * 2) return part;

    changed = true;
    return {
      ...part,
      output: textToolResultOutput(
        `${outputText.slice(0, keepHeadTail)}\n\n[soft pruned]\n\n${outputText.slice(-keepHeadTail)}`,
      ),
    };
  });

  return { message: { ...message, content }, changed };
}

export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  config: PruneConfig = {
    softTTLMs: 5 * 60_000,
    hardTTLMs: 10 * 60_000,
    keepHeadTail: 1_500,
  },
): PruneResult {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map((message, index) => {
    if (message.role !== "tool") return message;

    const outputText = message.content
      .map((part) =>
        "output" in part ? toolResultOutputToText(part.output) : "",
      )
      .join("");

    // 失败结果是避免 Agent 重走旧路的经验，不能按时间淘汰。
    if (ERROR_PATTERN.test(outputText)) return message;

    const age = now - (timestamps.get(index) ?? now);
    if (age >= config.hardTTLMs) {
      hardPruned++;
      return {
        ...message,
        content: message.content.map((part) =>
          "output" in part
            ? {
                ...part,
                output: textToolResultOutput("[tool result expired]"),
              }
            : part,
        ),
      };
    }

    if (age >= config.softTTLMs) {
      const pruned = softPruneMessage(message, config.keepHeadTail);
      if (pruned.changed) softPruned++;
      return pruned.message;
    }

    return message;
  });

  return { messages: result, softPruned, hardPruned };
}

export interface DefenseResult extends TruncateResult, PruneResult {
  tokenEstimate: number;
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  const truncated = truncateToolResults(messages);
  const pruned = ttlPrune(truncated.messages, timestamps);

  return {
    messages: pruned.messages,
    truncated: truncated.truncated,
    compacted: truncated.compacted,
    softPruned: pruned.softPruned,
    hardPruned: pruned.hardPruned,
    tokenEstimate: estimateMessageTokens(pruned.messages),
  };
}
