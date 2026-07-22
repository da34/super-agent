import type { ModelMessage } from "ai";
import { applyDefense, estimateMessageTokens } from "../context/defense";
import { textToolResultOutput } from "../context/tool-result-output";
import type { CommandHandler } from "./index";

export function injectSimulatedHistory(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  groups = 4,
  resultChars = 2_000,
): void {
  const now = Date.now();
  const ages = [12, 7, 4, 1];

  for (let index = 0; index < groups; index++) {
    const toolCallId = `simulated-read-${now}-${index}`;
    const ageMinutes = ages[index % ages.length];
    const createdAt = now - ageMinutes * 60_000;
    const startIndex = messages.length;

    messages.push(
      { role: "user", content: `读取模拟文件 ${index + 1}` },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "read_file",
            input: { path: `simulated-${index + 1}.txt` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "read_file",
            output: textToolResultOutput(
              `模拟文件 ${index + 1} 开始\n${"context data\n".repeat(
                Math.ceil(resultChars / 13),
              )}模拟文件 ${index + 1} 结束`,
            ),
          },
        ],
      },
    );

    for (let offset = 0; offset < 3; offset++) {
      timestamps.set(startIndex + offset, createdAt);
    }
  }
}

export function runDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): ModelMessage[] {
  const beforeTokens = estimateMessageTokens(messages);
  const defense = applyDefense(messages, timestamps);

  console.log("\n=== 三层即时防线 ===");
  console.log(`[防线前] ${messages.length} 条消息, ~${beforeTokens} tokens`);
  console.log(
    `[Layer 2: 截断] ${defense.truncated} 个超长结果被截断, ${defense.compacted} 个结果因预算被清理`,
  );
  console.log(
    `[Layer 3: TTL] ${defense.softPruned} 个软修剪, ${defense.hardPruned} 个硬清除`,
  );
  console.log(
    `[防线后] ${defense.messages.length} 条消息, ~${defense.tokenEstimate} tokens (节省 ${beforeTokens - defense.tokenEstimate})`,
  );
  console.log("====================");

  return defense.messages;
}

export const debugCommands: CommandHandler[] = [
  (command, context) => {
    if (command !== "status" && command !== "查看状态") return false;

    console.log(
      `[Status] ${context.messages.length} 条消息, ~${estimateMessageTokens(context.messages)} tokens`,
    );
    return true;
  },
  (command, context) => {
    if (command !== "sim" && command !== "模拟长对话") return false;

    injectSimulatedHistory(context.messages, context.timestamps, 20, 2_000);
    console.log(
      `[Sim] 已注入 20 组模拟工具历史，当前 ~${estimateMessageTokens(context.messages)} tokens`,
    );
    return true;
  },
  (command, context) => {
    if (command !== "defend" && command !== "执行防线") return false;

    const defendedMessages = runDefense(
      context.messages,
      context.timestamps,
    );
    // CommandContext 是临时对象，替换其属性不会更新 index.ts 的外层变量。
    context.messages.splice(0, context.messages.length, ...defendedMessages);
    return true;
  },
];
