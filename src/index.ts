/**
 * dsh-term — the interactive terminal (CLI/TUI) driver for DeepSeek Harness.
 *
 * The bundle patch rides over `dsh-base` without Host, HTTP, or browser
 * plugins. This runner creates (or resumes) one Agent through the core
 * registry, then runs a readline REPL: each line becomes a follow-up turn,
 * and the agent's session events stream to stdout as they happen.
 *
 * It also wires the terminal up as the harness's human "answerer":
 *   - `approval/request` — asks y/N before a permission-gated tool runs;
 *   - `userQuestions`   — renders `ask_user_question` prompts and reads answers.
 *
 * @module dsh-term
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle, AgentRegistry, ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { LlmModelInfo, LlmProviderInfo, ToolResultMessage, UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionItem, UserQuestionProvider } from "@deepseek-ai/dsh-user-questions";

/** Stable Cordis plugin name. */
export const name = "term-runner";
/** Core services required before the interactive driver can start. */
export const inject = ["agentDefaultModel", "agents", "sessions"] as const;

/** Validated plugin configuration. */
export const Config = z.object({
  /** Optional first task to run before dropping into the REPL. */
  task: z.string().default(""),
  /** Persisted session id to resume; empty string creates a fresh session. */
  resumeSessionId: z.string().default(""),
});
export interface Config {
  task: string;
  resumeSessionId: string;
}

/** The launcher-provided exit request. */
type AppExit = (code?: number) => void;

/** The subset of `dsh-agent-default-model` the runner reads. */
interface AgentDefaultModel {
  currentSelection(): ModelSelection;
}

/** The subset of `dsh-session` the runner reads. */
interface SessionStoreLike {
  flush(session: Session): Promise<void>;
}

/** The subset of `dsh-llm` the runner reads for `/models`. */
interface LlmCatalogLike {
  listProviders(): LlmProviderInfo[];
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
}

/** Result of one terminal input read. */
type AskResult =
  | { kind: "line"; line: string }
  | { kind: "interrupted" }
  | { kind: "aborted" }
  | { kind: "closed" };

const supportsColor =
  stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const paint = {
  dim: (text: string) => (supportsColor ? `\x1b[2m${text}\x1b[0m` : text),
  red: (text: string) => (supportsColor ? `\x1b[31m${text}\x1b[0m` : text),
  cyan: (text: string) => (supportsColor ? `\x1b[36m${text}\x1b[0m` : text),
  green: (text: string) => (supportsColor ? `\x1b[32m${text}\x1b[0m` : text),
  yellow: (text: string) => (supportsColor ? `\x1b[33m${text}\x1b[0m` : text),
  bold: (text: string) => (supportsColor ? `\x1b[1m${text}\x1b[0m` : text),
  blue: (text: string) => (supportsColor ? `\x1b[34m${text}\x1b[0m` : text),
  magenta: (text: string) => (supportsColor ? `\x1b[35m${text}\x1b[0m` : text),
  gray: (text: string) => (supportsColor ? `\x1b[90m${text}\x1b[0m` : text),
};

/** Collapse and truncate a raw JSON string for a one-line preview. */
function compactJson(raw: string, max = 140): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Extract a compact one-line preview from a tool result message. */
function resultPreview(message: ToolResultMessage, max = 120): string {
  const text = (message.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "done";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const HELP_TEXT = `Commands:
  /help                    show this help
  /exit, /quit             save and exit (Ctrl-D also works)
  /new                     start a fresh session (keeps the current model)
  /model                   show the current model
  /model <provider> <model>  switch the model from the next step
  /models                  list registered providers and models
  Ctrl-C                   cancel the current turn (or the current prompt) while running
`;

/** A lightweight line-level Markdown highlighter with code-block state. */
function createMarkdown() {
  let inCodeBlock = false;

  const inline = (text: string) =>
    text
      .replace(/\*\*([^*]+)\*\*/g, (_m, s) => paint.bold(s))
      .replace(/`([^`]+)`/g, (_m, s) => paint.cyan(s));

  const renderLine = (line: string) => {
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      return paint.gray("```");
    }
    if (inCodeBlock) return paint.dim(`  ${line}`);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return paint.bold(paint.blue(heading[2]));
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return paint.gray(`│ ${inline(quote[1])}`);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) return `${bullet[1]}${paint.cyan("·")} ${inline(bullet[2])}`;
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) return `${numbered[1]}${paint.cyan(`${numbered[2]}.`)} ${inline(numbered[3])}`;
    return inline(line);
  };

  return { renderLine };
}

/** Create the terminal event renderer with streaming + markdown + tool cards. */
function createRenderer() {
  const md = createMarkdown();
  let mode: "none" | "text" | "reasoning" = "none";
  let buffer = "";

  const newline = () => stdout.write("\n");

  const flushBuffer = () => {
    if (buffer !== "") {
      stdout.write(md.renderLine(buffer));
      buffer = "";
      newline();
    }
  };

  const finish = () => {
    if (mode === "reasoning") newline();
    else if (mode === "text") flushBuffer();
    mode = "none";
  };

  const renderEvent = (event: SessionEvent) => {
    switch (event.type) {
      case "assistant/chunk": {
        const chunk = event.data.chunk;
        if (chunk.type === "text-delta") {
          if (mode === "reasoning") newline();
          mode = "text";
          buffer += chunk.text;
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            stdout.write(md.renderLine(line) + "\n");
          }
        } else if (chunk.type === "reasoning-delta") {
          if (mode === "text") flushBuffer();
          if (mode !== "reasoning") stdout.write(paint.dim("✳ Thinking… "));
          mode = "reasoning";
        }
        break;
      }
      case "assistant/message": {
        finish();
        break;
      }
      case "tool/call": {
        finish();
        const args = compactJson(event.data.arguments);
        stdout.write(
          `  ${paint.yellow("⚙")} ${paint.bold(event.data.name)}${args === "" ? "" : paint.gray(` ${args}`)}\n`,
        );
        break;
      }
      case "tool/result": {
        finish();
        stdout.write(`  ${paint.green("✓")} ${paint.dim(resultPreview(event.data.message))}\n`);
        break;
      }
      case "turn/end": {
        finish();
        const reason = event.data.reason;
        if (reason.kind === "error") {
          stdout.write(
            `  ${paint.red("✖")} ${paint.red(`${reason.error.code ?? "ERROR"}: ${reason.error.message ?? ""}`)}\n`,
          );
        } else if (reason.kind === "aborted") {
          stdout.write(paint.gray("  ⏹ cancelled\n"));
        }
        break;
      }
      default:
        break;
    }
  };

  return { renderEvent, close: finish };
}

/**
 * A rebuildable readline input manager.
 *
 * `ask(prompt, signal)` reads one line and settles with `{ kind: 'line' }`,
 * `{ kind: 'interrupted' }` (Ctrl-C while this prompt was pending),
 * `{ kind: 'aborted' }` (the supplied signal fired), or `{ kind: 'closed' }`
 * (EOF). Interrupting a pending prompt rebuilds the interface so the dropped
 * question never queues behind later input.
 */
function createInput() {
  let rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let pending: { settle: (value: AskResult) => void } | null = null;

  const rebuild = () => {
    const old = rl;
    rl = createInterface({ input: stdin, output: stdout, terminal: true });
    wire();
    old.close();
  };

  const wire = () => {
    rl.on("SIGINT", () => {
      if (pending === null) return;
      const settle = pending.settle;
      pending = null;
      rebuild();
      settle({ kind: "interrupted" });
    });
  };
  wire();

  const ask = (prompt: string, signal?: AbortSignal): Promise<AskResult> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (value: AskResult) => {
        if (settled) return;
        settled = true;
        pending = null;
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        if (settled) return;
        pending = null;
        rebuild();
        settle({ kind: "aborted" });
      };
      if (signal?.aborted) return settle({ kind: "aborted" });
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      pending = { settle };
      rl.question(prompt).then(
        (line) => settle({ kind: "line", line }),
        () => settle({ kind: "closed" }),
      );
    });

  const close = () => rl.close();

  return { ask, close };
}

/** Build a plain user message from a line of terminal input. */
function userLine(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

/** Parse one answer line against a question's options. */
function parseAnswer(question: AskUserQuestionItem, text: string) {
  const options = question.options ?? [];
  let selected: string[] = [];
  let custom: string | undefined;
  if (options.length > 0) {
    const nums: number[] = [];
    for (const part of text.split(/[\s,，、]+/)) {
      const n = Number.parseInt(part, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) nums.push(n);
    }
    if (nums.length > 0) {
      const taken = question.multiSelect ? nums : nums.slice(0, 1);
      selected = taken.map((n) => options[n - 1].label);
    } else if (text !== "") {
      custom = text;
    }
  } else if (text !== "") {
    custom = text;
  }
  return { id: question.id, selected, ...(custom !== undefined ? { custom } : {}) };
}

/** The current-model line shown by the banner and `/model`. */
function modelLine(selection: ModelSelectionRef): string {
  const current = selection.current;
  return current === undefined ? "unknown" : `${current.model} (${current.provider})`;
}

/**
 * Run the interactive driver: create/resume an Agent, wire the terminal in as
 * the approval and user-questions answerer, stream events, and loop over
 * readline input until the user exits.
 */
async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get("loader")?.await();

  const agents = ctx.get("agents") as AgentRegistry | undefined;
  const defaultModel = ctx.get("agentDefaultModel") as AgentDefaultModel | undefined;
  const sessions = ctx.get("sessions") as SessionStoreLike | undefined;
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;

  const renderer = createRenderer();
  const input = createInput();

  let running = false;
  let exiting = false;
  let shutdownStarted = false;

  // Mutable current-agent state, replaced by `/new`.
  let currentAgent!: Agent;
  let currentHandle!: AgentHandle;
  let selectionRef!: ModelSelectionRef;

  const createAgent = async (resumeId: string, preferred?: ModelSelection) => {
    const selection = preferred ?? defaultModel.currentSelection();
    const ref: ModelSelectionRef = { current: selection, assembled: undefined };
    const handle: AgentHandle =
      resumeId !== ""
        ? await agents.resume({
            resumeSessionId: SessionId(resumeId),
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => {
              installModelSelection(agentCtx, ref);
            },
          })
        : await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: process.cwd() },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => {
              installModelSelection(agentCtx, ref);
            },
          });
    await handle.agent.whenIdle();
    return { agent: handle.agent, handle, ref };
  };

  const first = await createAgent(config.resumeSessionId.trim(), undefined);
  currentAgent = first.agent;
  currentHandle = first.handle;
  selectionRef = first.ref;

  const shutdown = async (code: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      offApproval();
      offQuestions?.();
      process.off("SIGINT", onProcessSigint);
      await sessions.flush(currentAgent.session);
      await currentHandle.dispose();
    } catch {
      /* teardown is best-effort */
    }
    input.close();
    (ctx.get("appExit") as AppExit | undefined)?.(code);
  };

  const onProcessSigint = () => {
    if (exiting) return;
    if (running) {
      currentAgent.cancel({ kind: "user" });
      return;
    }
    exiting = true;
    void shutdown(0);
  };

  process.on("SIGINT", onProcessSigint);

  // Approval answerer: one y/N prompt per permission-gated action.
  const offApproval = ctx.on("approval/request", async (req: ApprovalRequest, next) => {
    if (req.agent !== currentAgent) return next();
    renderer.close();
    stdout.write(`\n  ${paint.yellow("⚠")} ${paint.bold(req.toolName)}\n`);
    if (req.reason !== undefined) stdout.write(paint.gray(`    ${req.reason}\n`));
    const res = await input.ask(`  ${paint.yellow("Allow?")} ${paint.gray("[y/N] ")}`, req.signal);
    if (res.kind !== "line") return "cancelled" satisfies ApprovalOutcome;
    const answer = res.line.trim().toLowerCase();
    return (answer === "y" || answer === "yes" ? "allowed-once" : "rejected") satisfies ApprovalOutcome;
  });

  // User-questions answerer: renders each question and reads an answer.
  const userQuestions = ctx.get("userQuestions") as
    | { registerProvider(provider: UserQuestionProvider): () => void }
    | undefined;
  const offQuestions = userQuestions?.registerProvider({
    async ask(request) {
      renderer.close();
      const answers = [];
      for (const question of request.questions) {
        if (question.header !== undefined) {
          stdout.write(paint.bold(paint.cyan(`\n${question.header}\n`)));
        }
        stdout.write(paint.bold(`${question.question}\n`));
        if (question.detail !== undefined) {
          stdout.write(paint.gray(`${question.detail}\n`));
        }
        const options = question.options ?? [];
        if (options.length > 0) {
          for (let i = 0; i < options.length; i += 1) {
            const option = options[i];
            const description =
              option.description !== undefined
                ? paint.gray(` — ${option.description}`)
                : "";
            stdout.write(`  ${paint.cyan(`${i + 1}`)}) ${option.label}${description}\n`);
          }
        }
        const res = await input.ask(paint.cyan("  > "), request.signal);
        if (res.kind !== "line") {
          throw new Error("ask_user_question was aborted before the user answered");
        }
        answers.push(parseAnswer(question, res.line.trim()));
      }
      return { answers };
    },
  });

  const drive = async (message: UserMessage) => {
    const agent = currentAgent;
    running = true;
    let cursor = agent.session.firstLiveSeq;
    const flushEvents = () => {
      const events = agent.session.events;
      while (cursor < events.length) {
        renderer.renderEvent(events[cursor]);
        cursor += 1;
      }
    };
    agent.followup(message);
    await new Promise<void>((resolve) => {
      const idle = agent.whenIdle();
      const interval = setInterval(flushEvents, 40);
      idle.then(() => {
        clearInterval(interval);
        flushEvents();
        resolve();
      });
    });
    running = false;
  };

  stdout.write(
    paint.bold(paint.cyan("dsh-term")) +
      paint.gray(" · DeepSeek Harness terminal\n") +
      paint.gray(`model: ${modelLine(selectionRef)}\n`) +
      paint.gray(`session ${String(currentAgent.id)}\n`) +
      paint.gray("Type /help for commands, /exit or Ctrl-D to quit.\n\n"),
  );

  // Optional first task.
  const firstTask = config.task.trim();
  if (firstTask !== "") {
    await drive(userLine(firstTask));
  }

  // REPL.
  while (!exiting) {
    const res = await input.ask(paint.cyan("❯ "));
    if (res.kind !== "line") {
      exiting = true;
      break;
    }
    const trimmed = res.line.trim();

    if (trimmed === "") continue;
    if (trimmed === "/exit" || trimmed === "/quit") {
      exiting = true;
      break;
    }
    if (trimmed === "/help") {
      stdout.write(HELP_TEXT + "\n");
      continue;
    }
    if (trimmed === "/new") {
      try {
        await sessions.flush(currentAgent.session);
        await currentHandle.dispose();
      } catch {
        /* keep going */
      }
      const next = await createAgent("", selectionRef.current ?? undefined);
      currentAgent = next.agent;
      currentHandle = next.handle;
      selectionRef = next.ref;
      stdout.write(paint.dim(`new session ${String(currentAgent.id)}\n\n`));
      continue;
    }
    if (trimmed === "/model") {
      stdout.write(paint.dim(`current model: ${modelLine(selectionRef)}\n`));
      continue;
    }
    if (trimmed.startsWith("/model ")) {
      const parts = trimmed.slice("/model ".length).trim().split(/\s+/);
      if (parts.length !== 2) {
        stdout.write(paint.dim("usage: /model <provider> <model>   (try /models to list)\n"));
        continue;
      }
      selectionRef.current = { provider: parts[0], model: parts[1] };
      stdout.write(paint.dim(`model → ${parts[1]} (${parts[0]}) from the next step\n`));
      continue;
    }
    if (trimmed === "/models") {
      const llm = ctx.get("llm") as LlmCatalogLike | undefined;
      if (llm === undefined) {
        stdout.write(paint.dim("llm service unavailable\n"));
        continue;
      }
      const providers = llm.listProviders();
      if (providers.length === 0) {
        stdout.write(paint.dim("no providers registered\n"));
        continue;
      }
      for (const provider of providers) {
        stdout.write(paint.cyan(`${provider.name} (${provider.id})\n`));
        const models = await llm.listModels(provider.id).catch(() => []);
        for (const model of models) {
          const current =
            selectionRef.current?.provider === provider.id &&
            selectionRef.current?.model === model.id;
          stdout.write(paint.dim(`  - ${model.id}${current ? "  ← current" : ""}\n`));
        }
      }
      continue;
    }

    await drive(userLine(res.line));
  }

  await shutdown(0);
}

/**
 * Mount the interactive driver.
 *
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated config.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get("appExit") as AppExit | undefined;
  if (exit === undefined) {
    throw new Error(
      "term-runner: the launcher must provide ctx.appExit before the tree mounts",
    );
  }
  run(ctx, config).catch((error: unknown) => {
    process.stderr.write(
      `dsh: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    exit(1);
  });
}
