import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type SandboxCreateInput,
  type SandboxIdInput,
  type SandboxPairing,
  type SandboxSummary,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class NoLiveServerError extends Error {
  override readonly message =
    "No T3 server is running for this home. Start it (`t3 serve`): sandbox commands go through it, so it stays the only one managing sandboxes.";
}

/**
 * Runs sandbox commands through the server running for this home, over its
 * HTTP API, so the CLI never manages sandboxes beside it: one server holds the
 * spare, its claim, and its locks.
 */
const runWithSandboxes = <A, E>(
  flags: CliAuthLocationFlags,
  run: (sandboxes: {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>, Error>;
    readonly create: (input: SandboxCreateInput) => Effect.Effect<SandboxSummary, Error>;
    readonly start: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, Error>;
    readonly stop: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, Error>;
    readonly remove: (input: SandboxIdInput) => Effect.Effect<void, Error>;
    readonly pair: (input: SandboxIdInput) => Effect.Effect<SandboxPairing, Error>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const cliLogLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, cliLogLevel);
    const logLevel = Option.isSome(cliLogLevel) ? config.logLevel : "Warn";
    return yield* Effect.gen(function* () {
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) return yield* Effect.fail(new NoLiveServerError());
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 sandbox cli" }),
        (issued) =>
          Effect.gen(function* () {
            const client = (yield* HttpApiClient.make(EnvironmentHttpApi, {
              baseUrl: runtimeState.value.origin,
            })).sandboxes;
            const headers = { authorization: `Bearer ${issued.token}` };
            return yield* run({
              list: client.list({ headers }),
              create: (payload) => client.create({ headers, payload }),
              start: (payload) => client.start({ headers, payload }),
              stop: (payload) => client.stop({ headers, payload }),
              remove: (payload) => client.remove({ headers, payload }),
              pair: (payload) => client.pair({ headers, payload }),
            });
          }),
        (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
        ),
      ),
    );
  });

const formatSandbox = (sandbox: SandboxSummary) =>
  [sandbox.id, sandbox.state.padEnd(7), sandbox.label, sandbox.httpBaseUrl ?? ""].join("  ");

const idArgument = Argument.String("id").pipe(Argument.withDescription("Sandbox id."));

const sandboxListCommand = Command.make("list", { ...projectLocationFlags }).pipe(
  Command.withDescription("List this server's sandboxes."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes.list.pipe(
        Effect.flatMap((list) =>
          Console.log(list.length === 0 ? "No sandboxes." : list.map(formatSandbox).join("\n")),
        ),
      ),
    ),
  ),
);

const sandboxCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  repo: Flag.String("repo").pipe(
    Flag.withDescription("Git URL to clone into the sandbox's ~/work and add as a project."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create and start a sandbox, waiting until its server answers."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .create(flags.repo._tag === "Some" ? { repositoryUrl: flags.repo.value } : {})
        .pipe(Effect.flatMap((sandbox) => Console.log(formatSandbox(sandbox)))),
    ),
  ),
);

const sandboxStartCommand = Command.make("start", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Start a stopped sandbox."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .start({ id: flags.id })
        .pipe(Effect.flatMap((sandbox) => Console.log(formatSandbox(sandbox)))),
    ),
  ),
);

const sandboxStopCommand = Command.make("stop", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Stop a sandbox. Its files and conversations are kept."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .stop({ id: flags.id })
        .pipe(Effect.flatMap((sandbox) => Console.log(formatSandbox(sandbox)))),
    ),
  ),
);

const sandboxRemoveCommand = Command.make("rm", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Delete a sandbox and everything in it."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .remove({ id: flags.id })
        .pipe(Effect.andThen(Console.log(`Removed sandbox ${flags.id}.`))),
    ),
  ),
);

const sandboxPairCommand = Command.make("pair", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Print a one-time pairing URL for a running sandbox."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .pair({ id: flags.id })
        .pipe(
          Effect.flatMap((pairing) =>
            Console.log(
              `${pairing.httpBaseUrl}/pair#token=${pairing.credential}\nExpires: ${pairing.expiresAt}`,
            ),
          ),
        ),
    ),
  ),
);

export const sandboxCommand = Command.make("sandbox").pipe(
  Command.withDescription(
    "Create and manage sandboxes, one isolated T3 environment each, through the running server.",
  ),
  Command.withSubcommands([
    sandboxListCommand,
    sandboxCreateCommand,
    sandboxStartCommand,
    sandboxStopCommand,
    sandboxRemoveCommand,
    sandboxPairCommand,
  ]),
);
