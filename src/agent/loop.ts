import { streamText, type ModelMessage } from "ai";
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection";
import { calculateDelay, isRetryable, sleep } from "./retry";
import type { ToolRegistry } from "../tools";
import {
  normalizeUsage,
  type UsageTracker,
} from "../usage/tracker";

const MAX_STEPS = 10;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 500_000;

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
) {
  let step = 0;
  let totalTokens = 0;
  resetHistory();

  while (step < MAX_STEPS) {
    step++;

    console.log(`\n--step: ${step}--`);

    let hasToolCall = false;
    let fullText = "";
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: Awaited<ReturnType<typeof streamText>["response"]>;
    let stepUsage: Awaited<ReturnType<typeof streamText>["usage"]>;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          tools: registry.toAISDKFormat(),
          messages,
          system,
          maxRetries: 0,
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case "tool-call":
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              const detection = detect(part.toolName, part.input);

              if (detection.stuck) {
                console.log(detection.message);

                if (detection.level === "critical") {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: "user",
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;

            case "tool-result":
              console.log(`  [结果: ${previewToolResult(part.output)}]`);

              if (lastToolCall) {
                recordResult(
                  lastToolCall.name,
                  lastToolCall.input,
                  part.output,
                );
              }
              break;
          }

          if (shouldBreak) {
            console.log("\n[循环检测触发，Agent 已停止]");
            break;
          }
        }
        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
        );
        await sleep(delay);
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    messages.push(...stepResponse.messages);
    // 输入、缓存读写和输出必须分开计价，不能只累计 totalTokens。
    const normalizedUsage = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(
      model?.modelId ?? "mock-model",
      normalizedUsage,
    );
    totalTokens +=
      normalizedUsage.inputTokens +
      normalizedUsage.outputTokens +
      normalizedUsage.cacheReadTokens +
      normalizedUsage.cacheWriteTokens;

    if (
      stepRecord &&
      (normalizedUsage.cacheReadTokens > 0 ||
        normalizedUsage.cacheWriteTokens > 0)
    ) {
      const cacheHit = normalizedUsage.cacheReadTokens > 0;
      const tag = cacheHit
        ? "\x1b[38;5;36m✓ cache hit\x1b[0m"
        : "\x1b[38;5;220m✎ cache write\x1b[0m";
      const detail = cacheHit
        ? `read ${normalizedUsage.cacheReadTokens}`
        : `write ${normalizedUsage.cacheWriteTokens}`;
      console.log(
        `  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`,
      );
    }

    const usedPercentage = Math.round((totalTokens / TOKEN_BUDGET) * 100);
    console.log(
      `\n[Token] ${totalTokens}/${TOKEN_BUDGET} (${usedPercentage}%)`,
    );
    if (totalTokens > TOKEN_BUDGET) {
      console.log("\n[Token 预算耗尽，强制停止]");
      break;
    }

    // 没有工具调用了，可以退出了
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 模型还在工作，继续下一步...");
  }

  if (step >= MAX_STEPS) {
    console.log("\n[达到最大步数限制，强制停止]");
  }
}

function previewToolResult(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}
