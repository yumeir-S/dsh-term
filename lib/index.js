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
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Stable Cordis plugin name. */
export const name = "term-runner";
/** Core services required before the interactive driver can start. */
export const inject = ["agentDefaultModel", "agents", "sessions"];

/** Validated plugin configuration. */
export const Config = z.object({
  /** Optional first task to run before dropping into the REPL. */
  task: z.string().default(""),
  /** Persisted session id to resume; empty string creates a fresh session. */
  resumeSessionId: z.string().default(""),
});

const supportsColor =
  stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const paint = {
  dim: (text) => (supportsColor ? `\x1b[2m${text}\x1b[0m` : text),
  red: (text) => (supportsColor ? `\x1b[31m${text}\x1b[0m` : text),
  cyan: (text) => (supportsColor ? `\x1b[36m${text}\x1b[0m` : text),
  green: (text) => (supportsColor ? `\x1b[32m${text}\x1b[0m` : text),
  yellow: (text) => (supportsColor ? `\x1b[33m${text}\x1b[0m` : text),
};

/** Collapse and truncate a raw JSON string for a one-line preview. */
function compactJson(raw, max = 140) {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Extract a compact one-line preview from a tool result message. */
function resultPreview(message, max = 120) {
  const text = (message.content ?? [])
    .filter((block) => block.type === "text")
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

  /** @param {import("@deepseek-ai/dsh-session").SessionEvent} event */
  const renderEvent = (event) => {
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
  let pending = null;

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

  const ask = (prompt, signal) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
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
function userLine(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

/** Parse one answer line against a question's options. */
function parseAnswer(question, text) {
  const options = question.options ?? [];
  let selected = [];
  let custom;
  if (options.length > 0) {
    const nums = [];
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

/**
 * Run the interactive driver: create/resume an Agent, wire the terminal in as
 * the approval and user-questions answerer, stream events, and loop over
 * readline input until the user exits.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{ task: string, resumeSessionId: string }} config
 */
async function run(ctx, config) {
  await ctx.get("loader")?.await();

  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;

  const renderer = createRenderer();
  const input = createInput();

  let running = false;
  let exiting = false;
  let shutdownStarted = false;

  // Mutable current-agent state, replaced by `/new`.
  let currentAgent = null;
  let currentHandle = null;
  let selectionRef = null;

  const createAgent = async (resumeId, preferred) => {
    const selection = preferred ?? defaultModel.currentSelection();
    const ref = { current: selection, assembled: undefined };
    const handle =
      resumeId !== ""
        ? await agents.resume({
            resumeSessionId: SessionId(resumeId),
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => installModelSelection(agentCtx, ref),
          })
        : await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: process.cwd() },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => installModelSelection(agentCtx, ref),
          });
    await handle.agent.whenIdle();
    return { agent: handle.agent, handle, ref };
  };

  const first = await createAgent(config.resumeSessionId.trim(), undefined);
  currentAgent = first.agent;
  currentHandle = first.handle;
  selectionRef = first.ref;

  const shutdown = async (code) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      offApproval();
      offQuestions?.();
      process.off("SIGINT", onProcessSigint);
      if (currentAgent !== null) await sessions.flush(currentAgent.session);
      if (currentHandle !== null) await currentHandle.dispose();
    } catch {
      /* teardown is best-effort */
    }
    input.close();
    ctx.get("appExit")?.(code);
  };

  const onProcessSigint = () => {
    if (exiting) return;
    if (running) {
      currentAgent?.cancel({ kind: "user" });
      return;
    }
    exiting = true;
    void shutdown(0);
  };

  process.on("SIGINT", onProcessSigint);

  // Approval answerer: one y/N prompt per permission-gated action.
  const offApproval = ctx.on("approval/request", async (req, next) => {
    if (req.agent !== currentAgent) return next();
    renderer.close();
    stdout.write(paint.yellow(`[approve] ${req.toolName}\n`));
    if (req.reason !== undefined) stdout.write(paint.dim(`  ${req.reason}\n`));
    const res = await input.ask(paint.dim("  allow? [y/N] "), req.signal);
    if (res.kind !== "line") return "cancelled";
    const answer = res.line.trim().toLowerCase();
    return answer === "y" || answer === "yes" ? "allowed-once" : "rejected";
  });

  // User-questions answerer: renders each question and reads an answer.
  const userQuestions = ctx.get("userQuestions");
  const offQuestions = userQuestions?.registerProvider({
    async ask(request) {
      renderer.close();
      const answers = [];
      for (const question of request.questions) {
        if (question.header !== undefined) {
          stdout.write(paint.cyan(`\n${question.header}\n`));
        }
        stdout.write(`${question.question}\n`);
        if (question.detail !== undefined) {
          stdout.write(paint.dim(`${question.detail}\n`));
        }
        const options = question.options ?? [];
        if (options.length > 0) {
          for (let i = 0; i < options.length; i += 1) {
            const option = options[i];
            const description =
              option.description !== undefined
                ? paint.dim(` — ${option.description}`)
                : "";
            stdout.write(`  ${i + 1}) ${option.label}${description}\n`);
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

  const drive = async (message) => {
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
    await new Promise((resolve) => {
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

  const banner = (sessionId) =>
    paint.cyan("dsh-term") +
    paint.dim(" · DeepSeek Harness terminal\n") +
    paint.dim(`model: ${selectionRef.current.model} (${selectionRef.current.provider})\n`) +
    paint.dim(`session ${String(sessionId)}\n`) +
    paint.dim("Type /help for commands, /exit or Ctrl-D to quit.\n\n");

  stdout.write(
    banner(currentAgent.id) +
      (config.resumeSessionId.trim() !== "" ? paint.dim("(resumed)\n") : ""),
  );

  // Optional first task.
  const firstTask = config.task.trim();
  if (firstTask !== "") {
    await drive(userLine(firstTask));
  }

  // REPL.
  while (!exiting) {
    const res = await input.ask(paint.cyan("› "));
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
      const next = await createAgent("", selectionRef.current);
      currentAgent = next.agent;
      currentHandle = next.handle;
      selectionRef = next.ref;
      stdout.write(paint.dim(`new session ${String(currentAgent.id)}\n\n`));
      continue;
    }
    if (trimmed === "/model") {
      stdout.write(
        paint.dim(
          `current model: ${selectionRef.current.model} (${selectionRef.current.provider})\n`,
        ),
      );
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
      const llm = ctx.get("llm");
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
            selectionRef.current.provider === provider.id &&
            selectionRef.current.model === model.id;
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
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param {{ task: string, resumeSessionId: string }} config - validated config.
 */
export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === undefined) {
    throw new Error(
      "term-runner: the launcher must provide ctx.appExit before the tree mounts",
    );
  }
  run(ctx, config).catch((error) => {
    process.stderr.write(
      `dsh: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    exit(1);
  });
}
