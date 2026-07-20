import { fileTools } from "./file-tools";
import { generalTools } from "./general-tools";
import { shellTools } from "./shell-tools";
import type { ToolDefinition } from "./tool-registry";
import { webTools } from "./web-tools";

export * from "./file-tools";
export * from "./general-tools";
export * from "./mcp-client";
export * from "./shell-tools";
export * from "./tool-registry";
export * from "./web-tools";

export const allTools: ToolDefinition[] = [
  ...generalTools,
  ...fileTools,
  ...shellTools,
  ...webTools,
];
