import { exec } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "../tool-registry";

const execAsync = promisify(exec);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const normalizePath = (path: string) => path.replaceAll("\\", "/");

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: '城市名称，如"北京"、"上海"' },
    },
    required: ["city"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    // 先用假数据，后面课程会接真实 API
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 生产环境不要用 eval，这里纯粹为了演示
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500,
  execute: async ({ path }: { path: string }) => readFile(resolve(path), "utf8"),
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入指定路径的文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "文件内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    await writeFile(resolve(path), content, "utf8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    const names = await readdir(resolved);
    const lines = await Promise.all(
      names.map(async (name) => {
        const entry = await stat(join(resolved, name));
        return `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${name}`;
      }),
    );
    return lines.join("\n");
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: { type: "string", description: "要被替换的原始文本" },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    if (!old_string) return "old_string 不能为空";

    const resolved = resolve(path);
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return `文件不存在: ${path}`;
      }
      throw error;
    }

    const count = content.split(old_string).length - 1;
    if (count === 0) {
      return "未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致";
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    await writeFile(resolved, content.replace(old_string, new_string), "utf8");
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: '搜索模式，如 "**/*.ts"' },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const base = resolve(path);
    const matcher = globToRegExp(pattern);
    const files = await collectFiles(base);
    const matches = files
      .map((file) => normalizePath(relative(base, file)))
      .filter((file) => matcher.test(file))
      .slice(0, 100);

    return matches.join("\n") || "未找到匹配文件";
  },
};

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: { type: "string", description: "搜索路径（文件或目录），默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return `正则表达式无效: ${(error as Error).message}`;
    }

    const target = resolve(path);
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) return `路径不存在: ${path}`;

    const base = targetStat.isDirectory() ? target : dirname(target);
    const files = targetStat.isDirectory()
      ? await collectFiles(target)
      : [target];
    const matches: string[] = [];

    for (const file of files) {
      const content = await readTextFile(file);
      if (content === null) continue;

      const lines = content.split(/\r?\n/);
      const displayPath = normalizePath(relative(base, file));
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index])) continue;

        matches.push(`${displayPath}:${index + 1}: ${lines[index]}`);
        if (matches.length >= 50) return matches.join("\n");
      }
    }

    return matches.join("\n") || "未找到匹配内容";
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description: "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    try {
      await execAsync("echo test", { timeout: 1000, windowsHide: true });
    } catch {
      return "[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。";
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return stdout + stderr || "(命令执行成功，无输出)";
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return `命令执行失败 (exit ${err.code || 1}):\n${err.stderr || err.message}`;
    }
  },
};

function globToRegExp(pattern: string): RegExp {
  const chars = normalizePath(pattern);
  let source = "^";

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const next = chars[index + 1];

    if (char === "*" && next === "*") {
      if (chars[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  return new RegExp(`${source}$`);
}

async function collectFiles(root: string, limit = Number.POSITIVE_INFINITY) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) return [];
  if (rootStat.isFile()) return [root];

  const files: string[] = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(
        ...(await collectFiles(join(root, entry.name), limit - files.length)),
      );
    } else if (entry.isFile()) {
      files.push(join(root, entry.name));
    }
  }

  return files;
}

async function readTextFile(path: string): Promise<string | null> {
  const buffer = await readFile(path).catch(() => null);
  if (!buffer || buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
];
