import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import { MCPClient, MockMCPClient } from "./mcp-client";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools/utility-tools";
import { agentLoop, type BudgetState } from "./agent/loop";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

const glm = createOpenAI({
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = glm.chat("glm-4.7");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const budget: BudgetState = { used: 0, limit: 500000 };

const messages: ModelMessage[] = [];

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

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      await toolRegistry.closeAllMCP();
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, toolRegistry, messages, SYSTEM, budget);

    ask();
  });
}

async function main() {
  await connectMCP();
  printRegisteredTools();
  ask();
}

await main();
