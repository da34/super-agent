import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 模型价格，单位均为美元 / 百万 Token。 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * 课程提供的 2026-05 价格快照。
 * 价格会变化，接入新模型或用于正式结算前应更新对应条目。
 */
export const PRICE_TABLE: Record<string, ModelPricing> = {
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "claude-sonnet-4-7": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
  "gpt-5-5": { input: 5, output: 20, cacheWrite: 5, cacheRead: 0.5 },
  "gpt-5": { input: 5, output: 15, cacheWrite: 5, cacheRead: 1.25 },
  "gemini-3-pro": {
    input: 2.5,
    output: 12,
    cacheWrite: 2.5,
    cacheRead: 0.625,
  },
  "gemini-3-flash": {
    input: 0.3,
    output: 1.2,
    cacheWrite: 0.3,
    cacheRead: 0.075,
  },
  "deepseek-v3-2": {
    input: 0.27,
    output: 1.1,
    cacheWrite: 0.27,
    cacheRead: 0.027,
  },
  "qwen3-6-plus": {
    input: 0.4,
    output: 1.2,
    cacheWrite: 0.4,
    cacheRead: 0.04,
  },
  "kimi-k2-6": {
    input: 0.6,
    output: 2.5,
    cacheWrite: 0.6,
    cacheRead: 0.15,
  },
  "doubao-2-0-pro": {
    input: 0.3,
    output: 0.9,
    cacheWrite: 0.3,
    cacheRead: 0.12,
  },
  "mock-model": {
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
};

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
}

export interface UsageTotals extends StepUsage {
  cost: number;
  hitRate: number;
  baselineCost: number;
  savedCost: number;
  steps: number;
}

export class UsageTracker {
  private readonly records: StepRecord[] = [];

  constructor(private readonly logPath?: string) {
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  record(model: string, usage: StepUsage): StepRecord {
    const record: StepRecord = {
      ts: Date.now(),
      model,
      cost: computeCost(model, usage),
      ...usage,
    };
    this.records.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    }
    return record;
  }

  totals(): UsageTotals {
    const totals = this.records.reduce(
      (sum, step) => ({
        inputTokens: sum.inputTokens + step.inputTokens,
        outputTokens: sum.outputTokens + step.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + step.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + step.cacheWriteTokens,
        cost: sum.cost + step.cost,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
    );

    const inputLikeTokens =
      totals.inputTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens;
    const hitRate =
      inputLikeTokens > 0 ? totals.cacheReadTokens / inputLikeTokens : 0;

    // 基线把所有输入类 Token 都按未命中价格计算，用来展示缓存节省额。
    const baselineCost = this.records.reduce((sum, step) => {
      const pricing = getPricing(step.model);
      const stepInputLike =
        step.inputTokens + step.cacheReadTokens + step.cacheWriteTokens;
      return (
        sum +
        (stepInputLike * pricing.input +
          step.outputTokens * pricing.output) /
          1_000_000
      );
    }, 0);

    return {
      ...totals,
      hitRate,
      baselineCost,
      savedCost: baselineCost - totals.cost,
      steps: this.records.length,
    };
  }

  recent(count: number): StepRecord[] {
    return this.records.slice(-count);
  }
}

function getPricing(model: string): ModelPricing {
  return PRICE_TABLE[model] ?? PRICE_TABLE["mock-model"];
}

export function computeCost(model: string, usage: StepUsage): number {
  const pricing = getPricing(model);
  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite) /
    1_000_000
  );
}

/**
 * 将 AI SDK v6 usage 规范成四类 Token，同时兼容课程所用的 v5 字段。
 * 优先使用 v6 的明细，避免重复计算已包含在 inputTokens 中的缓存 Token。
 */
export function normalizeUsage(usage: any): StepUsage {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  const cacheReadTokens =
    usage.inputTokenDetails?.cacheReadTokens ??
    usage.cachedInputTokens ??
    usage.providerMetadata?.openai?.cachedTokens ??
    0;
  const cacheWriteTokens =
    usage.inputTokenDetails?.cacheWriteTokens ??
    usage.cacheCreationInputTokens ??
    usage.providerMetadata?.anthropic?.cacheCreationInputTokens ??
    0;

  const inputTokens =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens);

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}
