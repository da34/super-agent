import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { ToolDefinition } from "./tool-registry";

let previewServer: Server | null = null;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description: "启动 Node 内置 HTTP server，把 app/ 目录暴露到 8080 端口",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async () => {
    if (previewServer?.listening) return "预览服务已运行: http://localhost:8080";

    const appRoot = resolve("app");
    const appStat = await stat(appRoot).catch(() => null);
    if (!appStat?.isDirectory()) return `app/ 目录不存在: ${appRoot}`;

    const server = createServer(async (request, response) => {
      let target: string;
      try {
        const url = new URL(request.url || "/", "http://localhost");
        target = resolve(appRoot, `.${decodeURIComponent(url.pathname)}`);
      } catch {
        response.writeHead(400).end("Bad Request");
        return;
      }

      const insideApp = target === appRoot || target.startsWith(appRoot + sep);
      if (!insideApp) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      const targetStat = await stat(target).catch(() => null);
      const file = targetStat?.isDirectory()
        ? join(target, "index.html")
        : target;
      const content = await readFile(file).catch(() => null);
      if (!content) {
        response.writeHead(404).end("Not Found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(file)] || "application/octet-stream",
      });
      response.end(content);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(8080, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        return "端口 8080 已被占用";
      }
      throw error;
    }

    previewServer = server;
    return "预览服务已启动: http://localhost:8080";
  },
};

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "抓取 URL 内容，剥掉 script/style/HTML 标签后返回纯文本",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的 http/https URL" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ url }: { url: string }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `URL 无效: ${url}`;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "只支持 http/https URL";
    }

    const response = await fetch(parsed);
    const text = stripHtml(await response.text());
    return response.ok
      ? text
      : `请求失败 (${response.status} ${response.statusText}):\n${text}`;
  },
};

// ponytail: 正则够剥常见页面正文；复杂 HTML 清洗再换 DOM parser。
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webTools: ToolDefinition[] = [startPreviewTool, fetchUrlTool];
