import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import {
  allTools,
  createToolSearchTool,
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
import { UsageTracker } from "./usage/tracker";
import {
  createDispatcher,
  type CommandContext,
} from "./commands";
import {
  debugCommands,
  injectSimulatedHistory,
  runDefense,
} from "./commands/debug";
import { contextCommands } from "./commands/context";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);
toolRegistry.register(createToolSearchTool(toolRegistry));

const glm = createOpenAI({
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = glm.chat("glm-4.7");
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
]);

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

      const commandContext: CommandContext = {
        messages,
        timestamps,
        registry: toolRegistry,
        tracker: usageTracker,
        systemPrompt: SYSTEM,
        modelName: "GLM 4.7",
        modelId: "glm-4.7",
        windowTokens: 200_000,
      };
      const handled = dispatch(trimmed, commandContext);
      if (handled === "async") return;
      if (handled) {
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
