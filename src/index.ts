import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools/utility-tools";
import { agentLoop, type BudgetState } from "./agent/loop";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

console.log(`已注册 ${toolRegistry.getAll().length} 个工具：`);
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

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

const budget: BudgetState = { used: 0, limit: 50000 };

const messages: ModelMessage[] = [];

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, toolRegistry, messages, SYSTEM, budget);

    ask();
  });
}

// main();
ask();
