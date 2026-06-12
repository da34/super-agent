import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";
import { weatherTool, calculatorTool } from "./tools/utility-tools";
import { agentLoop, type BudgetState } from "./agent/loop";

const tools = { get_weather: weatherTool, calculator: calculatorTool };

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

const budget: BudgetState = { used: 0, limit: 500 };

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

    await agentLoop(model, tools, messages, SYSTEM, budget);

    ask();
  });
}

// main();
ask();
