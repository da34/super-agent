import type { ModelMessage } from "ai";
import type { UsageTracker } from "../usage/tracker";
import { estimateMessageTokens } from "./defense";

export interface ContextSlice {
  name: string;
  tokens: number;
  color: number;
  icon: string;
}

export interface ContextSnapshot {
  modelName: string;
  modelId: string;
  windowTokens: number;
  usedTokens: number;
  slices: ContextSlice[];
  autocompactBufferTokens: number;
}

export interface BuildSnapshotInput {
  modelName: string;
  modelId: string;
  windowTokens: number;
  systemPromptChars: number;
  toolDescriptionChars: number;
  memoryChars: number;
  skillsChars: number;
  messages: ModelMessage[];
  autocompactBufferTokens?: number;
}

const COLORS = {
  system: 63,
  tools: 99,
  memory: 220,
  skills: 36,
  messages: 111,
  free: 240,
  buffer: 244,
  text: 255,
  dim: 244,
};

const MATRIX_SIZE = 16;
const TOTAL_CELLS = MATRIX_SIZE * MATRIX_SIZE;
const CHARS_PER_TOKEN = 3.5;

function foreground(code: number, text: string): string {
  return `\x1b[38;5;${code}m${text}\x1b[0m`;
}

function percentage(value: number, total: number): string {
  return total === 0 ? "0.0%" : `${((value / total) * 100).toFixed(1)}%`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function estimateChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function buildContextSnapshot(
  input: BuildSnapshotInput,
): ContextSnapshot {
  const slices: ContextSlice[] = [
    {
      name: "System prompt",
      tokens: estimateChars(input.systemPromptChars),
      color: COLORS.system,
      icon: "◆",
    },
    {
      name: "System tools",
      tokens: estimateChars(input.toolDescriptionChars),
      color: COLORS.tools,
      icon: "◇",
    },
    {
      name: "Memory",
      tokens: estimateChars(input.memoryChars),
      color: COLORS.memory,
      icon: "◈",
    },
    {
      name: "Skills",
      tokens: estimateChars(input.skillsChars),
      color: COLORS.skills,
      icon: "◉",
    },
    {
      name: "Messages",
      tokens: estimateMessageTokens(input.messages),
      color: COLORS.messages,
      icon: "◎",
    },
  ];
  const usedTokens = slices.reduce((sum, slice) => sum + slice.tokens, 0);

  return {
    modelName: input.modelName,
    modelId: input.modelId,
    windowTokens: input.windowTokens,
    usedTokens,
    slices,
    autocompactBufferTokens:
      input.autocompactBufferTokens ?? Math.round(input.windowTokens * 0.05),
  };
}

/** 将上下文窗口画成 16×16 矩阵，每格约表示窗口容量的 1/256。 */
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const tokensPerCell = snapshot.windowTokens / TOTAL_CELLS;
  const cells: number[] = [];

  for (const slice of snapshot.slices) {
    if (slice.tokens <= 0) continue;
    const count = Math.max(1, Math.round(slice.tokens / tokensPerCell));
    for (let index = 0; index < count && cells.length < TOTAL_CELLS; index++) {
      cells.push(slice.color);
    }
  }

  const bufferCells = Math.max(
    0,
    Math.round(snapshot.autocompactBufferTokens / tokensPerCell),
  );
  const freeCells = Math.max(0, TOTAL_CELLS - cells.length - bufferCells);
  cells.push(...Array<number>(freeCells).fill(-1));
  while (cells.length < TOTAL_CELLS) cells.push(-2);

  const lines: string[] = [];
  for (let row = 0; row < MATRIX_SIZE; row++) {
    const rowCells = cells
      .slice(row * MATRIX_SIZE, (row + 1) * MATRIX_SIZE)
      .map((color) => {
        if (color === -1) return foreground(COLORS.free, "○");
        if (color === -2) return foreground(COLORS.buffer, "▢");
        return foreground(color, "●");
      });
    lines.push(rowCells.join(" "));
  }
  return lines.join("\n");
}

export function renderContextLegend(snapshot: ContextSnapshot): string {
  const lines = [
    foreground(COLORS.text, `\x1b[1m${snapshot.modelName}\x1b[0m`),
    foreground(COLORS.dim, snapshot.modelId),
    `${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.windowTokens)} tokens (${percentage(snapshot.usedTokens, snapshot.windowTokens)})`,
    "",
    foreground(COLORS.dim, "\x1b[3mEstimated usage by category\x1b[0m"),
  ];

  for (const slice of snapshot.slices) {
    if (slice.tokens <= 0) continue;
    lines.push(
      `${foreground(slice.color, "●")} ${slice.icon} ${slice.name}: ${formatTokens(slice.tokens)} tokens (${percentage(slice.tokens, snapshot.windowTokens)})`,
    );
  }

  const freeTokens = Math.max(
    0,
    snapshot.windowTokens -
      snapshot.usedTokens -
      snapshot.autocompactBufferTokens,
  );
  lines.push(
    `${foreground(COLORS.free, "○")}  Free space: ${formatTokens(freeTokens)} (${percentage(freeTokens, snapshot.windowTokens)})`,
    `${foreground(COLORS.buffer, "▢")}  Autocompact buffer: ${formatTokens(snapshot.autocompactBufferTokens)} (${percentage(snapshot.autocompactBufferTokens, snapshot.windowTokens)})`,
  );
  return lines.join("\n");
}

export function renderContextView(snapshot: ContextSnapshot): string {
  const matrix = renderContextMatrix(snapshot).split("\n");
  const legend = renderContextLegend(snapshot).split("\n");
  const lines: string[] = [];

  for (let index = 0; index < Math.max(matrix.length, legend.length); index++) {
    lines.push(`  ${(matrix[index] ?? "").padEnd(80, " ")}  ${legend[index] ?? ""}`);
  }
  return `\n${lines.join("\n")}\n`;
}

export function renderUsageView(tracker: UsageTracker): string {
  const totals = tracker.totals();
  const color = (code: number, text: string) => foreground(code, text);
  const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
  const lines = [
    bold(color(COLORS.text, "  Usage Summary")),
    color(
      COLORS.dim,
      `  ${totals.steps} 步累计 · ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    ),
    "",
    `  ${color(COLORS.messages, "◎")} Input          ${formatTokens(totals.inputTokens).padStart(8)} tokens`,
    `  ${color(COLORS.memory, "◈")} Cache write    ${formatTokens(totals.cacheWriteTokens).padStart(8)} tokens`,
    `  ${color(COLORS.skills, "◉")} Cache read     ${formatTokens(totals.cacheReadTokens).padStart(8)} tokens   (${(totals.hitRate * 100).toFixed(1)}% hit)`,
    `  ${color(COLORS.tools, "◇")} Output         ${formatTokens(totals.outputTokens).padStart(8)} tokens`,
    "",
  ];

  const barWidth = 30;
  const filled = Math.round(totals.hitRate * barWidth);
  const bar =
    color(COLORS.skills, "█".repeat(filled)) +
    color(COLORS.free, "░".repeat(barWidth - filled));
  lines.push(
    `  Cache hit rate  ${bar}  ${(totals.hitRate * 100).toFixed(1)}%`,
    "",
    `  ${bold("Cost")}            ${color(COLORS.memory, `$${totals.cost.toFixed(4)}`)}`,
    `  ${color(COLORS.dim, "Without cache")}   ${color(COLORS.dim, `$${totals.baselineCost.toFixed(4)}`)}`,
  );

  if (totals.savedCost > 0) {
    const savedPercentage =
      totals.baselineCost > 0
        ? (totals.savedCost / totals.baselineCost) * 100
        : 0;
    lines.push(
      `  ${bold(color(COLORS.skills, "Saved"))}           ${color(COLORS.skills, `$${totals.savedCost.toFixed(4)}`)} (${savedPercentage.toFixed(1)}% off)`,
    );
  }

  if (
    totals.inputTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens ===
    0
  ) {
    lines.push(`  ${color(COLORS.dim, "尚无输入用量，多聊几轮再看 :)")}`);
  }

  return `\n${lines.join("\n")}\n`;
}
