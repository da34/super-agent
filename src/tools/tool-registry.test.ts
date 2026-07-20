import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockMCPClient } from "./mcp-client";
import { ToolDefinition, ToolRegistry } from "./tool-registry";
import {
  allTools,
  bashTool,
  editFileTool,
  fetchUrlTool,
  globTool,
  grepTool,
} from "./utility-tools";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function tool(
  name: string,
  isConcurrencySafe: boolean,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", additionalProperties: false },
    isConcurrencySafe,
    execute,
  };
}

function defaultConcurrencyTool(
  name: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", additionalProperties: false },
    execute,
  };
}

test("只读工具可以同时执行", async () => {
  const events: string[] = [];
  let releaseReadA!: () => void;
  let readAStarted!: () => void;
  let readBStarted!: () => void;
  const readAStartedPromise = new Promise<void>((resolve) => {
    readAStarted = resolve;
  });
  const readBStartedPromise = new Promise<void>((resolve) => {
    readBStarted = resolve;
  });
  const registry = new ToolRegistry();

  registry.register(
    tool("read_a", true, async () => {
      events.push("read_a:start");
      readAStarted();
      await new Promise<void>((resolve) => {
        releaseReadA = resolve;
      });
      events.push("read_a:end");
      return "a";
    }),
    tool("read_b", true, async () => {
      events.push("read_b:start");
      readBStarted();
      return "b";
    }),
  );

  const tools = registry.toAISDKFormat();
  const readA = tools.read_a.execute({});
  await readAStartedPromise;
  const readB = tools.read_b.execute({});
  await readBStartedPromise;

  assert.deepEqual(events, ["read_a:start", "read_b:start"]);

  releaseReadA();
  await Promise.all([readA, readB]);
});

test("读写工具等待只读工具释放共享锁", async () => {
  const events: string[] = [];
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readStartedPromise = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const registry = new ToolRegistry();

  registry.register(
    tool("read", true, async () => {
      events.push("read:start");
      readStarted();
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      events.push("read:end");
      return "read";
    }),
    tool("write", false, async () => {
      events.push("write:start");
      return "write";
    }),
  );

  const tools = registry.toAISDKFormat();
  const read = tools.read.execute({});
  await readStartedPromise;
  const write = tools.write.execute({});
  await tick();

  assert.deepEqual(events, ["read:start"]);

  releaseRead();
  await Promise.all([read, write]);
  assert.deepEqual(events, ["read:start", "read:end", "write:start"]);
});

test("只读工具等待读写工具释放独占锁", async () => {
  const events: string[] = [];
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const writeStartedPromise = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const registry = new ToolRegistry();

  registry.register(
    tool("write", false, async () => {
      events.push("write:start");
      writeStarted();
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      events.push("write:end");
      return "write";
    }),
    tool("read", true, async () => {
      events.push("read:start");
      return "read";
    }),
  );

  const tools = registry.toAISDKFormat();
  const write = tools.write.execute({});
  await writeStartedPromise;
  const read = tools.read.execute({});
  await tick();

  assert.deepEqual(events, ["write:start"]);

  releaseWrite();
  await Promise.all([write, read]);
  assert.deepEqual(events, ["write:start", "write:end", "read:start"]);
});

test("写工具等待时后来的读工具不能插队", async () => {
  const events: string[] = [];
  let releaseReadA!: () => void;
  let readAStarted!: () => void;
  const readAStartedPromise = new Promise<void>((resolve) => {
    readAStarted = resolve;
  });
  const registry = new ToolRegistry();

  registry.register(
    tool("read_a", true, async () => {
      events.push("read_a:start");
      readAStarted();
      await new Promise<void>((resolve) => {
        releaseReadA = resolve;
      });
      events.push("read_a:end");
      return "a";
    }),
    tool("write", false, async () => {
      events.push("write:start");
      return "write";
    }),
    tool("read_b", true, async () => {
      events.push("read_b:start");
      return "b";
    }),
  );

  const tools = registry.toAISDKFormat();
  const readA = tools.read_a.execute({});
  await readAStartedPromise;
  const write = tools.write.execute({});
  const readB = tools.read_b.execute({});
  await tick();

  assert.deepEqual(events, ["read_a:start"]);

  releaseReadA();
  await Promise.all([readA, write, readB]);
  assert.deepEqual(events, [
    "read_a:start",
    "read_a:end",
    "write:start",
    "read_b:start",
  ]);
});

test("未声明 isConcurrencySafe 的工具按串行执行", async () => {
  const events: string[] = [];
  let releaseA!: () => void;
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });
  const registry = new ToolRegistry();

  registry.register(
    defaultConcurrencyTool("a", async () => {
      events.push("a:start");
      aStarted();
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      events.push("a:end");
      return "a";
    }),
    defaultConcurrencyTool("b", async () => {
      events.push("b:start");
      return "b";
    }),
  );

  const tools = registry.toAISDKFormat();
  const a = tools.a.execute({});
  await aStartedPromise;
  const b = tools.b.execute({});
  await tick();

  assert.deepEqual(events, ["a:start"]);

  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);
});

test("新增内置工具可以编辑和搜索文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "super-agent-tools-"));
  try {
    const file = join(dir, "demo.ts");
    await writeFile(file, "export const value = 1;\n", "utf8");

    assert.deepEqual(
      ["edit_file", "glob", "grep", "bash", "start_preview", "fetch_url"].every((name) =>
        allTools.some((tool) => tool.name === name),
      ),
      true,
    );

    await editFileTool.execute({
      path: file,
      old_string: "value = 1",
      new_string: "value = 2",
    });

    assert.equal(await readFile(file, "utf8"), "export const value = 2;\n");
    assert.equal(
      await globTool.execute({ pattern: "**/*.ts", path: dir }),
      "demo.ts",
    );
    assert.equal(
      await grepTool.execute({ pattern: "value = 2", path: dir }),
      "demo.ts:1: export const value = 2;",
    );
    assert.match(
      String(await bashTool.execute({ command: "echo built-in-tools" })),
      /built-in-tools/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetch_url 返回剥掉脚本样式和标签后的纯文本", async () => {
  const server = createServer((_, response) => {
    response.end(`
      <style>.hidden { display: none; }</style>
      <h1>Hello</h1>
      <script>window.bad = true;</script>
      <p>world</p>
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    assert.equal(
      await fetchUrlTool.execute({ url: `http://127.0.0.1:${port}/` }),
      "Hello world",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("MCP Server 可以注册到 ToolRegistry", async () => {
  const registry = new ToolRegistry();
  const registered = await registry.registerMCPServer(
    "github",
    new MockMCPClient(),
  );

  assert.deepEqual(registered, [
    "mcp__github__list_issues",
    "mcp__github__search_repositories",
    "mcp__github__get_file_contents",
  ]);

  const tool = registry.get("mcp__github__search_repositories");
  assert.ok(tool);
  assert.equal(tool.isReadOnly, true);
  assert.equal(tool.isConcurrencySafe, true);
  assert.match(
    String(await tool.execute({ query: "agent" })),
    /vercel\/ai/,
  );

  await registry.closeAllMCP();
});
