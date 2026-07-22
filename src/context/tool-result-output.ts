import type { ToolResultPart } from "ai";

type ToolResultOutput = ToolResultPart["output"];

export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: "text", value };
}

// 兼容上一节代码中的拼写，避免旧的 compressor 导入立即失效。
export const textToolResultOutpur = textToolResultOutput;

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return `[execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          if ("mediaType" in part) return `[${part.type} ${part.mediaType}]`;
          if (part.type === "file-url") return `[file-url ${part.url}]`;
          if (part.type === "file-id") {
            return `[file-id ${JSON.stringify(part.fileId)}]`;
          }
          if (part.type === "image-url") return `[image-url ${part.url}]`;
          return `[${part.type}]`;
        })
        .join("\n");
  }
}
