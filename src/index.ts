/**
 * dsh-term — the interactive terminal (CLI/TUI) driver for DeepSeek Harness.
 *
 * The bundle patch rides over `dsh-base` without Host, HTTP, or browser
 * plugins. This runner creates (or resumes) one Agent through the core
 * registry, then runs a readline REPL: each line becomes a follow-up turn,
 * and the agent's session events stream to stdout as they happen.
 *
 * @module dsh-term
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle, AgentRegistry, ModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolResultMessage, UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

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
  /help          show this help
  /exit, /quit   save and exit (Ctrl-D also works)
  Ctrl-C         cancel the current turn while it is running
`;

/** Create the terminal event renderer with streaming state. */
function createRenderer() {
  let textOpen = false;
  let reasoningOpen = false;

  const close = () => {
    if (textOpen || reasoningOpen) {
      stdout.write("\n");
      textOpen = false;
      reasoningOpen = false;
    }
  };

  const renderEvent = (event: SessionEvent) => {
    switch (event.type) {
      case "assistant/chunk": {
        const chunk = event.data.chunk;
        if (chunk.type === "text-delta") {
          if (reasoningOpen) close();
          stdout.write(chunk.text);
          textOpen = true;
        } else if (chunk.type === "reasoning-delta") {
          if (textOpen) close();
          if (!reasoningOpen) stdout.write(paint.dim("  · "));
          stdout.write(paint.dim(chunk.text));
          reasoningOpen = true;
        }
        break;
      }
      case "assistant/message": {
        close();
        break;
      }
      case "tool/call": {
        close();
        const args = compactJson(event.data.arguments);
        stdout.write(
          paint.dim(`  ⚙ ${event.data.name}${args === "" ? "" : ` ${args}`}\n`),
        );
        break;
      }
      case "tool/result": {
        close();
        stdout.write(paint.dim(`  ↳ ${resultPreview(event.data.message)}\n`));
        break;
      }
      case "turn/end": {
        close();
        const reason = event.data.reason;
        if (reason.kind === "error") {
          stdout.write(
            paint.red(
              `  ✖ ${reason.error.code ?? "ERROR"}: ${reason.error.message ?? ""}\n`,
            ),
          );
        } else if (reason.kind === "aborted") {
          stdout.write(paint.dim("  ⏹ cancelled\n"));
        }
        break;
      }
      default:
        break;
    }
  };

  return { renderEvent, close };
}

/** Build a plain user message from a line of terminal input. */
function userLine(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

/**
 * Run the interactive driver: create/resume an Agent, stream its events, and
 * loop over readline input until the user exits.
 */
async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get("loader")?.await();

  const agents = ctx.get("agents") as AgentRegistry | undefined;
  const defaultModel = ctx.get("agentDefaultModel") as AgentDefaultModel | undefined;
  const sessions = ctx.get("sessions") as SessionStoreLike | undefined;
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;

  const selection = defaultModel.currentSelection();
  const resumeId = config.resumeSessionId.trim();

  const handle: AgentHandle =
    resumeId !== ""
      ? await agents.resume({
          resumeSessionId: SessionId(resumeId),
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, {
              current: selection,
              assembled: undefined,
            });
          },
        })
      : await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd() },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, {
              current: selection,
              assembled: undefined,
            });
          },
        });

  const agent: Agent = handle.agent;
  await agent.whenIdle();

  const renderer = createRenderer();
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  let running = false;
  let exiting = false;
  let shutdownStarted = false;

  const shutdown = async (code: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await sessions.flush(agent.session);
      await handle.dispose();
    } catch {
      /* teardown is best-effort */
    }
    rl.close();
    (ctx.get("appExit") as AppExit | undefined)?.(code);
  };

  const onSigint = () => {
    if (exiting) return;
    if (running) {
      agent.cancel({ kind: "user" });
      return;
    }
    exiting = true;
    void shutdown(0);
  };

  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

  const drive = async (message: UserMessage) => {
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

  // Banner.
  const sessionLine =
    resumeId !== "" ? `resumed ${resumeId}` : `session ${String(agent.id)}`;
  stdout.write(
    paint.cyan("dsh-term") +
      paint.dim(" · DeepSeek Harness terminal\n") +
      paint.dim(`model: ${selection.model} (${selection.provider})\n`) +
      paint.dim(`${sessionLine}\n`) +
      paint.dim("Type /help for commands, /exit or Ctrl-D to quit.\n\n"),
  );

  // Optional first task.
  const firstTask = config.task.trim();
  if (firstTask !== "") {
    await drive(userLine(firstTask));
  }

  // REPL.
  while (!exiting) {
    let line: string;
    try {
      line = await rl.question(paint.cyan("› "));
    } catch {
      // Interface closed (EOF or SIGINT) — treat as exit.
      exiting = true;
      break;
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "/exit" || trimmed === "/quit") {
      exiting = true;
      break;
    }
    if (trimmed === "/help") {
      stdout.write(HELP_TEXT + "\n");
      continue;
    }
    await drive(userLine(line));
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
