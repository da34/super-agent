import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./tool-registry";

const execAsync = promisify(exec);

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

export const shellTools: ToolDefinition[] = [bashTool];
