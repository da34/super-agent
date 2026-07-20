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
  const isContinue = process.argv.includes("--continue");
  const store = new SessionStore("default");
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const deferredSummary = toolRegistry.getDeferredToolSummary();

  const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
  需要查询信息时，主动使用工具，不要编造数据。
  回答要简洁直接。${deferredSummary}`;

  const budget: BudgetState = { used: 0, limit: 50000 };

  const allCount = toolRegistry.getAll().length;
  const activeTools = toolRegistry.getActiveTools();
  const estimate = toolRegistry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
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

      ask();
    });
  }

  ask();
}

await main();
