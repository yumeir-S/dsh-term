# dsh-term

[English](README.md) | 中文

`dsh-term` 是一个 DeepSeek Harness 的**交互式终端（CLI/TUI）bundle**：让你在终端里直接和编码 agent 多轮对话，无需打开浏览器。

它复用了 harness 的核心能力（Agent / Session / 工具 / 技能 / 沙箱），只是在 `dsh-base` 之上叠加了一个 readline REPL 驱动：每输入一行就是一个 follow-up 轮次，agent 的回复、思考过程、工具调用都会实时流式打印到 stdout。

## 特性

- 纯终端交互，`dsh --profile term` 即进 REPL
- 流式输出：助手文本实时逐字打印，思考内容（reasoning）以暗色显示
- 工具调用可视化：`⚙ 工具名 参数` 与 `↳ 结果摘要`
- **权限审批接入终端**：工具执行前弹 `[approve] … [y/N]` 确认，默认 `workspace-write` 权限也能交互放行
- **提问接入终端**：`ask_user_question` 在终端里渲染问题与选项，直接输入编号或文本作答
- 会话持久化：`--resume <sessionId>` 恢复历史会话
- 开箱即用：`lib/` 已提交编译产物，安装后无需构建

## 安装

前置要求：

- Node.js ≥ 22，[pnpm](https://pnpm.io/)（`dsh plugin` 会转发给 pnpm）
- `dsh` CLI（`@deepseek-ai/dsh`），例如 `npm i -g @deepseek-ai/dsh`
- 模型凭据：`DEEPSEEK_API_KEY`（或写入 `~/.dsh/.credentials.yaml`）

从 npm 安装并初始化 profile：

```sh
dsh plugin --profile term add dsh-term
```

从 Git 安装（先 push 到 GitHub 后）：

```sh
dsh plugin --profile term add github:<you>/dsh-term
```

`dsh plugin` 会自动识别 `dsh-term` 声明了 `dsh.bundle.patch`，并把它追加到该 profile 的 `dsh.profile.bundles` 里。

## 使用

```sh
dsh --profile term                          # 进入交互式聊天
dsh --profile term "解释一下这个仓库"        # 先执行一个任务，然后继续交互
dsh --profile term --resume <sessionId>     # 恢复之前的会话
```

REPL 内命令：

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/exit` / `/quit` | 保存并退出（Ctrl-D 亦可） |
| Ctrl-C（运行中） | 取消当前轮次 |

## 从源码构建

`lib/` 已提交为可直接运行的 ESM，无需构建。若要修改 `src/*.ts` 并重新生成：

```sh
pnpm install
pnpm build        # tsc -p tsconfig.json，输出到 lib/
```

## 目录结构

```
dsh-term/
├── cordis.patch.yml   # bundle patch：叠加在 dsh-base 之上
├── package.json       # 声明 dsh.bundle.patch；exports 指向 lib/
├── lib/               # 运行时入口（已提交，零构建）
│   ├── index.js       #   term-runner：交互式驱动器
│   └── startup.js     #   term-startup：解析命令行并提供 termStartup 服务
├── src/               # TypeScript 源码（带类型，与 lib/ 等价）
│   ├── index.ts
│   └── startup.ts
└── tsconfig.json
```

## 工作原理

`term-startup`（`src/startup.ts`）注入 `cmdlineArgs`，用 commander 解析可选的首个任务与 `--resume`，然后通过 `ctx.provide('termStartup', …)` 发布调用参数。

`term-runner`（`src/index.ts`）注入 `agentDefaultModel` / `agents` / `sessions`：

1. 读取默认模型路由，通过 `ctx.agents.create()`（或 `--resume` 时 `ctx.agents.resume()`）创建/恢复 Agent，并用 `installModelSelection` 安装路由。
2. 轮询 `agent.session.events`（`{ seq, time, type, data }` 的只追加事件流），按 `assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 渲染到 stdout。
3. 每行输入调用 `agent.followup(createUserMessage(…))`，等待 `agent.whenIdle()` 结算后再回到提示符。
4. 把终端注册为 harness 的「人类应答方」：
   - 监听 `approval/request`（waterfall 事件），渲染 `[approve] 工具名` + 原因，读取 y/N，返回 `allowed-once` / `rejected` / `cancelled`。
   - 通过 `ctx.userQuestions.registerProvider(...)` 注册提问提供方，渲染每个问题及其选项，解析编号/自由文本，返回结构化答案。
5. 退出时 `sessions.flush()` + `handle.dispose()` + `ctx.appExit(0)`。

输入统一走一个「可重建的 readline 管理器」：`ask(prompt, signal)` 读一行并返回 `line` / `interrupted`（Ctrl-C）/ `aborted`（signal 中止）/ `closed`（EOF）；中断时会重建 readline 接口，避免被丢弃的 question 阻塞后续输入。

## 已知限制

- **中途引导（steering）未做**：运行中不能主动插入新指令，只能 Ctrl-C 取消当前轮次；`agent.steer()` 留作后续。
- **无彩色时自动降级**：非 TTY / `NO_COLOR` / `TERM=dumb` 下关闭 ANSI 颜色。

## License

MIT
