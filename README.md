# Super Agent

一个基于 TypeScript、AI SDK 和 GLM 构建的命令行 Agent 示例项目。项目重点演示 Agent 循环、工具调用、上下文治理、会话持久化、工具延迟发现以及 Token 用量统计等基础能力。

> 当前项目处于课程实践阶段。长期记忆（Memory）尚未实现；MCP 客户端与注册能力已经具备，但默认入口暂未连接外部 MCP Server。

## 功能概览

- 流式输出与多步 Agent 循环，单轮最多执行 10 个步骤
- 文件、Shell、网页抓取和通用工具调用
- 工具读写锁：只读工具可共享执行，写工具独占执行
- 延迟工具发现：通过 `tool_search` 按需加载工具定义
- 三层上下文防线：长结果截断、预算压缩和 TTL 清理
- 重复工具调用检测与可重试错误退避
- JSONL 会话持久化，可恢复默认会话
- Token、缓存命中率与估算成本统计
- 可扩展的命令调度器和 Prompt Pipeline

## 技术栈

- Node.js 20+
- TypeScript 6
- pnpm 10
- AI SDK 6
- GLM 4.7（OpenAI 兼容接口）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

在项目根目录创建 `.env`：

```dotenv
DASHSCOPE_API_KEY=你的智谱 API_Key
```

项目当前沿用 `DASHSCOPE_API_KEY` 这个变量名，但实际请求地址是智谱开放平台的 OpenAI 兼容接口。

### 3. 启动新会话

```bash
pnpm start
```

首次启动会创建默认会话文件 `.super_sessions/default.jsonl`。为演示上下文防线，新会话还会注入少量模拟工具历史。

### 4. 恢复会话

```bash
pnpm continue
```

该命令从 `.super_sessions/default.jsonl` 恢复历史消息，然后继续默认会话。

输入 `exit` 或空行即可退出。

## 快捷命令

| 命令 | 作用 |
| --- | --- |
| `/context` 或 `context` | 查看当前上下文组成与占用情况 |
| `/usage` 或 `usage` | 查看 Token、缓存命中率和估算成本 |
| `status` | 查看消息数与 Token 估算 |
| `sim` | 注入模拟工具历史，用于观察上下文治理效果 |
| `defend` | 手动执行上下文防线 |
| `exit` | 关闭 MCP 连接并退出程序 |

命令调度器按注册顺序依次调用 Handler；第一个返回已处理状态的 Handler 会终止后续匹配，未命中的输入才会发送给模型。

## 内置工具

| 分类 | 工具 |
| --- | --- |
| 文件 | `read_file`、`write_file`、`edit_file`、`list_directory`、`glob`、`grep` |
| Shell | `bash` |
| Web | `fetch_url`、`start_preview` |
| 通用 | `calculator`、`get_weather` |
| 工具发现 | `tool_search` |

工具执行结果默认会限制长度，避免大段输出持续挤占上下文。被标记为延迟加载的工具不会直接进入模型工具列表，模型需要先调用 `tool_search` 获取其完整定义。

## 工作流程

```text
终端输入
   |
   v
命令调度器 ---- 命中快捷命令 ----> 本地处理并返回
   |
   | 未命中
   v
会话持久化 -> 上下文防线 -> Agent Loop -> 模型响应
                                  |
                                  v
                           工具注册表与执行锁
                                  |
                                  v
                         工具结果写回消息历史
```

每个 Agent 步骤都会重新生成当前可用的工具定义。若模型发起工具调用，工具结果会加入消息历史并进入下一步；如果没有工具调用、达到步骤上限、耗尽 Token 预算或触发严重循环检测，本轮执行结束。

## 项目结构

```text
src/
├── agent/                 # Agent 循环、重试与循环检测
├── commands/              # 快捷命令及责任链调度器
├── context/               # Prompt Pipeline、上下文防线与状态视图
├── session/               # JSONL 会话持久化
├── tools/                 # 内置工具、工具注册表、Tool Search 与 MCP 客户端
├── usage/                 # Token 用量与成本统计
└── index.ts               # 应用装配和 CLI 入口
```

运行时数据默认写入以下目录：

- `.super_sessions/`：会话消息
- `.usage/`：逐步 Token 与成本记录

## 常用脚本

```bash
# 启动新会话
pnpm start

# 恢复默认会话
pnpm continue

# 运行工具注册表测试
pnpm test
```

## 扩展方式

### 添加工具

1. 在 `src/tools/` 中定义符合 `ToolDefinition` 的工具。
2. 在 `src/tools/index.ts` 导出并加入 `allTools`。
3. 如果工具定义较大或不常用，设置 `shouldDefer` 与 `searchHint`，让 `tool_search` 按需激活。

### 添加快捷命令

1. 在 `src/commands/` 中新增 `CommandHandler`。
2. 将 Handler 加入对应命令数组，或创建新的命令组。
3. 在 `src/index.ts` 的 `createDispatcher` 调用中注册命令组。

### 接入 MCP Server

使用 `MCPClient` 创建客户端，再通过 `ToolRegistry.registerMCPServer()` 注册。注册后的工具会使用 `mcp__<server>__<tool>` 命名，并默认作为延迟工具提供。

## 当前限制

- 模型和接口地址目前直接配置在 `src/index.ts` 中。
- 默认会话 ID 固定为 `default`。
- 用量统计读取当前进程内的数据；日志会持久化，但启动时不会回载历史统计。
- 成本表是课程使用的价格快照，只适合演示，不应直接用于正式结算。
- MCP 基础能力尚未在默认 CLI 入口启用。
- 长期 Memory 能力尚未实现。

## License

[ISC](https://opensource.org/license/isc-license-txt)
