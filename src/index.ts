import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import {
  allTools,
  MCPClient,
  MockMCPClient,
  type ToolDefinition,
  ToolRegistry,
} from "./tools";
import { agentLoop, type BudgetState } from "./agent/loop";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder";
import { estimateTokens, microcompact, summarize } from "./context/compressor";

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

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log("\n连接 GitHub MCP Server...");
    const isWindows = process.platform === "win32";
    try {
      const client = new MCPClient(
        "npx",
        ["-y", "@modelcontextprotocol/server-github"],
        {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
        },
      );
      const tools = await toolRegistry.registerMCPServer("github", client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (error) {
      console.log(
        `  MCP 连接失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP");
  } else if (!canSpawn) {
    console.log("\n当前环境不支持启动子进程，使用 Mock MCP");
  }

  const mockClient = new MockMCPClient();
  const tools = await toolRegistry.registerMCPServer("github", mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

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
  await connectMCP();

  let messages: ModelMessage[] = [];

  // session 持久化
  const sessionId = "default";
  const isContinue = process.argv.includes("--continue");
  const store = new SessionStore(sessionId);
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

  let summary = "";

  // 压缩
  const beforeTokens = estimateTokens(messages);
  console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

  // 层级1
  const mc = microcompact(messages);
  messages = mc.messages;
  const afterMCTokens = estimateTokens(messages);
  console.log(
    `[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果, ~${afterMCTokens} tokens`,
  );

  // 层级2
  const compResult = await summarize(model, messages, summary);
  messages = compResult.messages;
  summary = compResult.summary;
  const afterSumTokens = estimateTokens(messages);
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens`,
    );
    console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
  } else {
    console.log(`[Layer 2: Summarization] 未触发（消息量不够）`);
  }

  console.log(
    `[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${beforeTokens - afterSumTokens} tokens)\n`,
  );

  // Clear injected history for chat — compression demo is done
  messages = [];

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

  const budget: BudgetState = { used: 0, limit: 500000 };
  const estimate = toolRegistry.countTokenEstimate();
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
  );
  printRegisteredTools();

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        await toolRegistry.closeAllMCP();
        console.log("Bye!");
        rl.close();
        return;
      }
      const userMsg: ModelMessage = { role: "user", content: trimmed };
      store.append(userMsg);
      messages.push(userMsg);

      await agentLoop(model, toolRegistry, messages, SYSTEM, budget);

      const beforeLen = messages.length;

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

      // 检查是否需要压缩
      const currentTokens = estimateTokens(messages);
      console.log(currentTokens, 'currentTokens')
      if (currentTokens > 4000) {
        console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);
        const mc2 = microcompact(messages);
        messages = mc2.messages;
        if (mc2.cleared > 0)
          console.log(`  [Microcompact] 清理了 ${mc2.cleared} 个工具结果`);

        const comp2 = await summarize(model, messages, summary);
        if (comp2.compressedCount > 0) {
          messages = comp2.messages;
          summary = comp2.summary;
          console.log(
            `  [Summarization] 压缩了 ${comp2.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`,
          );
        }
      }

      ask();
    });
  }

  ask();
}

await main();
