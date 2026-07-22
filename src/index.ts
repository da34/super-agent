import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import {
  allTools,
  type ToolDefinition,
  ToolRegistry,
} from "./tools";
import { agentLoop } from "./agent/loop";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder";
import {
  applyDefense,
  estimateMessageTokens,
} from "./context/defense";
import { textToolResultOutput } from "./context/tool-result-output";
import { UsageTracker } from "./usage/tracker";
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "./context/view";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

const toolSearchTool: ToolDefinition = {
  name: "tool_search",
  description:
    "获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = toolRegistry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

toolRegistry.register(toolSearchTool);

const glm = createOpenAI({
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = glm.chat("glm-4.7");

function printRegisteredTools() {
  console.log(`已注册 ${toolRegistry.getAll().length} 个工具：`);
  for (const tool of toolRegistry.getAll()) {
    const flags = [
      tool.isConcurrencySafe ? "可并发" : "串行",
      tool.isReadOnly ? "只读" : "读写",
    ].join(", ");
    console.log(`  - ${tool.name}（${flags}）`);
  }
}

function injectSimulatedHistory(
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

function runDefense(
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

async function main() {
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();

  // session 持久化
  const sessionId = "default";
  const isContinue = process.argv.includes("--continue");
  const store = new SessionStore(sessionId);
  const usageTracker = new UsageTracker(".usage/today.jsonl");
  if (isContinue && store.exists()) {
    messages = store.load();
    messages.forEach((_, index) => timestamps.set(index, Date.now()));
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    injectSimulatedHistory(messages, timestamps);
    console.log(
      `[Session] 新会话（已注入 ${messages.length} 条模拟历史，时间跨度 12 分钟）`,
    );
  }
  messages = runDefense(messages, timestamps);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("sessionContext", sessionContext());

  const deferredSummary = toolRegistry.getDeferredToolSummary();
  const toolCount = toolRegistry.getActiveTools().length;

  const promptCtx: PromptContext = {
    toolCount: toolCount,
    deferredToolSummary: deferredSummary,
    sessionMessageCount: messages.length,
    sessionId,
  };

  const SYSTEM = builder.build(promptCtx);
  builder.debug(promptCtx); // 显示各模块状态

  const estimate = toolRegistry.countTokenEstimate();
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
  );
  printRegisteredTools();
  console.log("快捷命令：");
  console.log("  /context — 查看上下文占用矩阵");
  console.log("  /usage   — 查看 Token、缓存命中率与成本");
  console.log("  status   — 查看当前消息数与 Token 估算");
  console.log("  sim      — 注入模拟工具历史");
  console.log("  defend   — 手动执行上下文防御");

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        await toolRegistry.closeAllMCP();
        console.log("Bye!");
        rl.close();
        return;
      }

      if (trimmed === "status") {
        console.log(
          `[Status] ${messages.length} 条消息, ~${estimateMessageTokens(messages)} tokens`,
        );
        ask();
        return;
      }

      if (trimmed === "/context" || trimmed === "context") {
        const snapshot = buildContextSnapshot({
          modelName: "GLM 4.7",
          modelId: "glm-4.7",
          windowTokens: 200_000,
          systemPromptChars: SYSTEM.length,
          toolDescriptionChars: toolRegistry
            .getActiveTools()
            .reduce(
              (total, tool) =>
                total +
                tool.name.length +
                tool.description.length +
                JSON.stringify(tool.parameters).length,
              0,
            ),
          memoryChars: 0,
          skillsChars: 0,
          messages,
        });
        console.log(renderContextView(snapshot));
        ask();
        return;
      }

      if (trimmed === "/usage" || trimmed === "usage") {
        console.log(renderUsageView(usageTracker));
        ask();
        return;
      }

      if (trimmed === "sim") {
        injectSimulatedHistory(messages, timestamps, 20, 2_000);
        console.log(
          `[Sim] 已注入 20 组模拟工具历史，当前 ~${estimateMessageTokens(messages)} tokens`,
        );
        ask();
        return;
      }

      if (trimmed === "defend") {
        messages = runDefense(messages, timestamps);
        ask();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      store.append(userMsg);
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());

      // 每次请求模型前先执行零 LLM 成本的即时防御。
      messages = runDefense(messages, timestamps);

      const beforeLen = messages.length;
      await agentLoop(model, toolRegistry, messages, SYSTEM, usageTracker);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);
      for (let index = beforeLen; index < messages.length; index++) {
        timestamps.set(index, Date.now());
      }

      ask();
    });
  }

  ask();
}

await main();
