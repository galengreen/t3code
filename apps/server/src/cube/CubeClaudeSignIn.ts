/**
 * Signs cubes in with Claude without a pasted token. The host runs
 * `claude setup-token` in a terminal the client drives, then saves the
 * long-lived token it prints as the sensitive CLAUDE_CODE_OAUTH_TOKEN that
 * every new cube starts with.
 *
 * Copying the host's own Claude login would not work: each refresh replaces
 * the refresh token, so a laptop and its cubes would keep logging each other
 * out. A setup token is made for headless use and is shared safely.
 *
 * The client sees the terminal only up to the success line. The token is
 * printed after it, so it stays on the server.
 */
import {
  CubeUnavailableError,
  type CubeClaudeSignInInput,
  type CubeClaudeSignInState,
  type CubeError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";

const TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";
const OUTPUT_LIMIT = 16_384;
/** Printed just before the token. Output from here on is not shown. */
const SUCCESS_MARKER = "Long-lived authentication token created successfully";
const TOKEN_PREFIX = "sk-ant-oat";
const TOKEN_PATTERN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * The part of the terminal output a client may see: everything before the
 * success line, or before anything shaped like a token if the CLI changes its
 * wording. Searching the whole output means a marker split across chunks is
 * still found before any of the token follows it.
 */
export const visibleOutput = (output: string): string => {
  const cut = [output.indexOf(SUCCESS_MARKER), output.indexOf(TOKEN_PREFIX)].filter(
    (index) => index >= 0,
  );
  return cut.length === 0 ? output : output.slice(0, Math.min(...cut));
};

/**
 * The token from `claude setup-token` output. Its terminal UI wraps long
 * lines, so the token can arrive split across lines between escape codes.
 */
export const extractSetupToken = (output: string): string | null => {
  const text = output.replace(ANSI_PATTERN, "");
  const start = text.lastIndexOf(TOKEN_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf("Store this token", start);
  const candidate = (end < 0 ? text.slice(start) : text.slice(start, end)).replace(/\s+/g, "");
  const token = /^sk-ant-oat\d+-[A-Za-z0-9_-]+/.exec(candidate)?.[0] ?? null;
  return token !== null && TOKEN_PATTERN.test(token) ? token : null;
};

export class CubeClaudeSignIn extends Context.Service<
  CubeClaudeSignIn,
  {
    /** Runs one sign-in while subscribed; a new run replaces an unfinished one. */
    readonly run: Stream.Stream<CubeClaudeSignInState, CubeError>;
    /** Forwards keystrokes and resizes to the running sign-in. */
    readonly input: (input: CubeClaudeSignInInput) => Effect.Effect<void, CubeError>;
  }
>()("t3/cube/CubeClaudeSignIn") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const active = yield* Ref.make<Option.Option<PtyAdapter.PtyProcess>>(Option.none());

  const saveToken = (token: string) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings;
      yield* settings.updateSettings({
        cubeEnvironment: [
          ...current.cubeEnvironment.filter((variable) => variable.name !== TOKEN_VARIABLE),
          { name: TOKEN_VARIABLE, value: token, sensitive: true },
        ],
      });
    });

  const signIn = (queue: Queue.Queue<CubeClaudeSignInState, CubeError | Cause.Done>) =>
    Effect.gen(function* () {
      if (Option.isNone(pty)) {
        return yield* new CubeUnavailableError({
          reason: "This server cannot open a terminal, so it cannot sign in to Claude.",
        });
      }
      // Without its own login variables, so the CLI makes a new token.
      const {
        CLAUDE_CODE_OAUTH_TOKEN: _token,
        ANTHROPIC_API_KEY: _key,
        ...environment
      } = process.env;
      const terminal = yield* pty.value
        .spawn({
          shell: "claude",
          args: ["setup-token"],
          cwd: NodeOS.homedir(),
          cols: 80,
          rows: 24,
          env: { ...environment, TERM: "xterm-256color" },
        })
        .pipe(
          Effect.mapError(
            () =>
              new CubeUnavailableError({
                reason: "Could not run `claude setup-token`. Install Claude Code on this server.",
              }),
          ),
        );
      const replaced = yield* Ref.getAndSet(active, Option.some(terminal));
      if (Option.isSome(replaced)) replaced.value.kill();

      let output = "";
      let shown = "";
      const emit = (phase: CubeClaudeSignInState["phase"], message: string | null) =>
        Queue.offerUnsafe(queue, {
          phase,
          output: shown.slice(-OUTPUT_LIMIT),
          outputOffset: shown.length,
          message,
        });
      const exited = yield* Deferred.make<void>();
      const detachData = terminal.onData((data) => {
        output += data;
        const next = visibleOutput(output);
        if (next.length === shown.length) return;
        shown = next;
        emit("running", null);
      });
      const detachExit = terminal.onExit(() => Deferred.doneUnsafe(exited, Effect.void));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          detachData();
          detachExit();
          try {
            terminal.kill();
          } catch {
            // It may have exited already.
          }
        }).pipe(
          Effect.andThen(
            Ref.update(active, (current) =>
              Option.isSome(current) && current.value === terminal ? Option.none() : current,
            ),
          ),
        ),
      );
      emit("running", null);
      yield* Deferred.await(exited);

      const token = extractSetupToken(output);
      if (token === null) {
        emit("failed", "Claude did not give a token. Start again to retry.");
      } else {
        yield* saveToken(token).pipe(
          Effect.match({
            onFailure: () => emit("failed", "The token was made but could not be saved."),
            onSuccess: () => emit("saved", null),
          }),
        );
      }
      yield* Queue.end(queue);
    }).pipe(Effect.catch((error) => Queue.fail(queue, error)));

  const run: CubeClaudeSignIn["Service"]["run"] = Stream.callback(signIn);

  const input: CubeClaudeSignIn["Service"]["input"] = (request) =>
    Ref.get(active).pipe(
      Effect.flatMap((terminal) =>
        Option.isNone(terminal)
          ? Effect.fail(new CubeUnavailableError({ reason: "No Claude sign-in is running." }))
          : Effect.sync(() => {
              if (request.size) terminal.value.resize(request.size.cols, request.size.rows);
              if (request.data) terminal.value.write(request.data);
            }),
      ),
    );

  return CubeClaudeSignIn.of({ run, input });
});

export const layer = Layer.effect(CubeClaudeSignIn, make);
