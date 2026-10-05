import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type CubeCreateInput,
  type CubeIdInput,
  type CubePairing,
  type CubeSummary,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class NoLiveServerError extends Error {
  override readonly message =
    "No T3 server is running for this home. Start it (`t3 serve`): cube commands go through it, so it stays the only one managing cubes.";
}

/**
 * Runs cube commands through the server running for this home, over its
 * HTTP API, so the CLI never manages cubes beside it: one server holds the
 * spare, its claim, and its locks.
 */
const runWithCubes = <A, E>(
  flags: CliAuthLocationFlags,
  run: (cubes: {
    readonly list: Effect.Effect<ReadonlyArray<CubeSummary>, Error>;
    readonly create: (input: CubeCreateInput) => Effect.Effect<CubeSummary, Error>;
    readonly start: (input: CubeIdInput) => Effect.Effect<CubeSummary, Error>;
    readonly stop: (input: CubeIdInput) => Effect.Effect<CubeSummary, Error>;
    readonly remove: (input: CubeIdInput) => Effect.Effect<void, Error>;
    readonly pair: (input: CubeIdInput) => Effect.Effect<CubePairing, Error>;
    readonly createHome: Effect.Effect<CubePairing, Error>;
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
        environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 cube cli" }),
        (issued) =>
          Effect.gen(function* () {
            const client = (yield* HttpApiClient.make(EnvironmentHttpApi, {
              baseUrl: runtimeState.value.origin,
            })).cubes;
            const headers = { authorization: `Bearer ${issued.token}` };
            return yield* run({
              list: client.list({ headers }),
              create: (payload) => client.create({ headers, payload }),
              start: (payload) => client.start({ headers, payload }),
              stop: (payload) => client.stop({ headers, payload }),
              remove: (payload) => client.remove({ headers, payload }),
              pair: (payload) => client.pair({ headers, payload }),
              createHome: client.createHome({ headers }),
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

const formatCube = (cube: CubeSummary) =>
  [cube.id, cube.state.padEnd(7), cube.label, cube.httpBaseUrl ?? ""].join("  ");

const idArgument = Argument.String("id").pipe(Argument.withDescription("Cube id."));

const cubeListCommand = Command.make("list", { ...projectLocationFlags }).pipe(
  Command.withDescription("List this server's cubes."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) =>
      cubes.list.pipe(
        Effect.flatMap((list) =>
          Console.log(list.length === 0 ? "No cubes." : list.map(formatCube).join("\n")),
        ),
      ),
    ),
  ),
);

const cubeCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  repo: Flag.String("repo").pipe(
    Flag.withDescription("Git URL to clone into the cube's ~/work and add as a project."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create and start a cube, waiting until its server answers."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) =>
      cubes
        .create(flags.repo._tag === "Some" ? { repositoryUrl: flags.repo.value } : {})
        .pipe(Effect.flatMap((cube) => Console.log(formatCube(cube)))),
    ),
  ),
);

const cubeStartCommand = Command.make("start", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Start a stopped cube."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) =>
      cubes.start({ id: flags.id }).pipe(Effect.flatMap((cube) => Console.log(formatCube(cube)))),
    ),
  ),
);

const cubeStopCommand = Command.make("stop", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Stop a cube. Its files and conversations are kept."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) =>
      cubes.stop({ id: flags.id }).pipe(Effect.flatMap((cube) => Console.log(formatCube(cube)))),
    ),
  ),
);

const cubeRemoveCommand = Command.make("rm", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Delete a cube and everything in it."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) =>
      cubes.remove({ id: flags.id }).pipe(Effect.andThen(Console.log(`Removed cube ${flags.id}.`))),
    ),
  ),
);

const printPairing = (pairing: CubePairing) =>
  Console.log(
    `${pairing.httpBaseUrl}/pair#token=${pairing.credential}\nExpires: ${pairing.expiresAt}`,
  );

const cubePairCommand = Command.make("pair", { ...projectLocationFlags, id: idArgument }).pipe(
  Command.withDescription("Print a one-time pairing URL for a running cube."),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) => cubes.pair({ id: flags.id }).pipe(Effect.flatMap(printPairing))),
  ),
);

const cubeHomeCommand = Command.make("home", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Move cube management to a cube home on Fly, which sleeps when unused, and print a one-time pairing URL for it.",
  ),
  Command.withHandler((flags) =>
    runWithCubes(flags, (cubes) => cubes.createHome.pipe(Effect.flatMap(printPairing))),
  ),
);

export const cubeCommand = Command.make("cube").pipe(
  Command.withDescription(
    "Create and manage cubes, one isolated T3 environment each, through the running server.",
  ),
  Command.withSubcommands([
    cubeListCommand,
    cubeCreateCommand,
    cubeStartCommand,
    cubeStopCommand,
    cubeRemoveCommand,
    cubePairCommand,
    cubeHomeCommand,
  ]),
);
