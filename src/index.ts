import "dotenv/config";
import { streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline";

const glm = createOpenAI({
  baseURL: "https://open.bigmodel.cn/api/paas/v4/",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = glm.chat("glm-4.7");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

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

    const result = streamText({
      system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
     你说话简洁直接，喜欢用代码示例来解释问题。
     如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      model,
      messages,
    });

    process.stdout.write("Assistant: ");
    let fullResponse = "";
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    console.log(); // 换行

    messages.push({ role: "assistant", content: fullResponse });

    ask();
  });
}

async function main() {
  const result = await streamText({
    model,
    prompt: "用一句话介绍你自己",
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  console.log();
}

// main();
ask();
