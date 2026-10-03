import type { SandboxSummary } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DockerSandboxDriver from "../sandbox/DockerSandboxDriver.ts";
import * as SandboxService from "../sandbox/SandboxService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Runs the sandbox service in this process. It only needs Docker and the
 * server's settings, so no running server is required.
 */
const runWithSandboxes = <A, E>(
  flags: CliAuthLocationFlags,
  run: (sandboxes: SandboxService.SandboxService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const cliLogLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, cliLogLevel);
    // Startup logs (such as database migrations) would bury the output.
    const logLevel = Option.isSome(cliLogLevel) ? config.logLevel : "Warn";
    return yield* SandboxService.SandboxService.pipe(
      Effect.flatMap(run),
      Effect.provide(
        SandboxService.layer.pipe(
          Layer.provide(DockerSandboxDriver.layer),
          Layer.provide(
            ServerSettings.layer.pipe(
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(SqlitePersistence.layerConfig),
            ),
          ),
          Layer.provide(ProcessRunner.layer),
          Layer.provide(FetchHttpClient.layer),
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
  label: Flag.String("label").pipe(
    Flag.withDescription("Name shown for the sandbox."),
    Flag.optional,
  ),
  repo: Flag.String("repo").pipe(
    Flag.withDescription("Git URL to clone into the sandbox on first start."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create and start a sandbox, waiting until its server answers."),
  Command.withHandler((flags) =>
    runWithSandboxes(flags, (sandboxes) =>
      sandboxes
        .create({
          ...(flags.label._tag === "Some" ? { label: flags.label.value } : {}),
          ...(flags.repo._tag === "Some" ? { repositoryUrl: flags.repo.value } : {}),
        })
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
  Command.withDescription("Create and manage Docker sandboxes, one isolated T3 environment each."),
  Command.withSubcommands([
    sandboxListCommand,
    sandboxCreateCommand,
    sandboxStartCommand,
    sandboxStopCommand,
    sandboxRemoveCommand,
    sandboxPairCommand,
  ]),
);
