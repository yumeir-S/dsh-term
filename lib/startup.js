/**
 * dsh-term/startup — the interactive-terminal app's command-line provider.
 *
 * It parses the optional first task, `--resume <sessionId>`, and this app's
 * `--help`, then publishes the `termStartup` service. The runner is an
 * ordinary consumer whose config waits for that service.
 *
 * @module dsh-term/startup
 */
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Stable Cordis plugin name. */
export const name = "term-startup";
/** Services required before the invocation can be resolved. */
export const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the interactive runner. */
export const TERM_STARTUP_SERVICE = "termStartup";

/** Build this app's command: the first-task positional, `--resume`, and help. */
export function termCommand() {
  return new Command()
    .name("dsh --profile term")
    .description("Interactive terminal chat with the DeepSeek Harness coding agent.")
    .helpOption("-h, --help", "show this help")
    .option("--resume <sessionId>", "resume an existing persisted session")
    .argument("[task...]", "optional first task; multiple words are joined by spaces")
    .addHelpText(
      "after",
      `
Examples:
  dsh --profile term                          start an interactive chat
  dsh --profile term "explain this repo"      start with one task, then stay interactive
  dsh --profile term --resume <sessionId>     resume a previous session
`,
    );
}

/**
 * Parse and provide the invocation as an ordinary Cordis service. The
 * command's action publishes the facts; help and rejected arguments are
 * terminal for the process (handled by `parseCmdline`).
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
  const program = termCommand();
  program.action(() => {
    const task = program.args.join(" ");
    const options = program.opts();
    ctx.provide(TERM_STARTUP_SERVICE, {
      task,
      resumeSessionId: options.resume ?? "",
    });
  });
  parseCmdline(ctx, program);
}
