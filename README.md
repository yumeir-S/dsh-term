# dsh-term

中文 | [English](README.md)

`dsh-term` is an **interactive terminal (CLI/TUI) bundle** for DeepSeek Harness: chat with the coding agent directly in your terminal, no browser required.

It reuses the harness core (Agent / Session / tools / skills / sandbox) and layers a readline REPL driver on top of `dsh-base`: each input line is a follow-up turn, and the agent's replies, reasoning, and tool activity stream to stdout in real time.

## Features

- Pure-terminal REPL via `dsh --profile term`
- Streaming output: assistant text prints token-by-token; reasoning is dimmed
- Tool activity: `⚙ name args` and `↳ result preview`
- **Approval in the terminal**: `[approve] … [y/N]` prompts before permission-gated tools, so the default `workspace-write` policy works interactively
- **Questions in the terminal**: `ask_user_question` renders questions and options; answer by number or free text
- Session persistence: `--resume <sessionId>` resumes a prior session
- Zero-build: `lib/` is checked in and ready to run

## Install

Prerequisites:

- Node.js ≥ 22 and [pnpm](https://pnpm.io/) (`dsh plugin` forwards to pnpm)
- the `dsh` CLI (`@deepseek-ai/dsh`), e.g. `npm i -g @deepseek-ai/dsh`
- model credentials: `DEEPSEEK_API_KEY` (or `~/.dsh/.credentials.yaml`)

From npm:

```sh
dsh plugin --profile term add dsh-term
```

From Git (after you push to GitHub):

```sh
dsh plugin --profile term add github:<you>/dsh-term
```

`dsh plugin` detects the `dsh.bundle.patch` declaration and appends `dsh-term` to the profile's `dsh.profile.bundles` automatically.

## Usage

```sh
dsh --profile term                          # start an interactive chat
dsh --profile term "explain this repo"      # run one task first, then stay interactive
dsh --profile term --resume <sessionId>     # resume a previous session
```

In-REPL commands:

| Command | Action |
|---|---|
| `/help` | show help |
| `/exit` / `/quit` | save and exit (Ctrl-D works too) |
| Ctrl-C (while running) | cancel the current turn |

## Build from source

`lib/` is checked in as runnable ESM, so no build is required. To edit `src/*.ts` and regenerate:

```sh
pnpm install
pnpm build        # tsc -p tsconfig.json, outputs to lib/
```

## Layout

```
dsh-term/
├── cordis.patch.yml   # bundle patch layered over dsh-base
├── package.json       # declares dsh.bundle.patch; exports point at lib/
├── lib/               # runtime entrypoints (checked in, zero build)
│   ├── index.js       #   term-runner: the interactive driver
│   └── startup.js     #   term-startup: parses the CLI and provides termStartup
├── src/               # TypeScript source (typed, equivalent to lib/)
│   ├── index.ts
│   └── startup.ts
└── tsconfig.json
```

## How it works

`term-startup` (`src/startup.ts`) injects `cmdlineArgs`, parses the optional first task and `--resume` with commander, then publishes `termStartup` via `ctx.provide(...)`.

`term-runner` (`src/index.ts`) injects `agentDefaultModel` / `agents` / `sessions`:

1. Reads the default model route, creates (or resumes) an Agent through `ctx.agents.create()` / `ctx.agents.resume()`, and installs the route with `installModelSelection`.
2. Polls `agent.session.events` (the append-only `{ seq, time, type, data }` log) and renders `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, and `turn/end` to stdout.
3. Each input line becomes `agent.followup(createUserMessage(...))`; the driver waits for `agent.whenIdle()` before returning to the prompt.
4. Wires the terminal in as the harness's human answerer:
   - Listens to `approval/request` (a waterfall event), renders `[approve] tool` + reason, reads y/N, and returns `allowed-once` / `rejected` / `cancelled`.
   - Registers a `ctx.userQuestions.registerProvider(...)` provider that renders each question and its options, parses numbers/free text, and returns the structured answer.
5. On exit: `sessions.flush()` + `handle.dispose()` + `ctx.appExit(0)`.

All input goes through a rebuildable readline manager: `ask(prompt, signal)` reads one line and returns `line` / `interrupted` (Ctrl-C) / `aborted` (signal fired) / `closed` (EOF); interrupting rebuilds the readline interface so a dropped question never blocks later input.

## Known limitations

- **No mid-turn steering**: you cannot inject a new instruction while a turn runs — Ctrl-C cancels the current turn instead; `agent.steer()` is future work.
- **Color auto-degrades** on non-TTY / `NO_COLOR` / `TERM=dumb`.

## License

MIT
