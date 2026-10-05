import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as CubeService from "./CubeService.ts";

/** The host's cubes over HTTP, for `t3 cube` commands against the live server. */
export const cubeHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cubes",
  Effect.fnUntraced(function* (handlers) {
    const cubes = yield* CubeService.CubeService;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.cubes.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* cubes.list;
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.cubes.create")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.create(args.payload);
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.cubes.start")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.start(args.payload);
        }),
      )
      .handle(
        "stop",
        Effect.fn("environment.cubes.stop")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.stop(args.payload);
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.cubes.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.remove(args.payload);
        }),
      )
      .handle(
        "pair",
        Effect.fn("environment.cubes.pair")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.pair(args.payload);
        }),
      )
      .handle(
        "createHome",
        Effect.fn("environment.cubes.createHome")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* cubes.createHome;
        }),
      );
  }),
);
