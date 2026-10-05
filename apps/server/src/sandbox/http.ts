import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as SandboxService from "./SandboxService.ts";

/** The host's sandboxes over HTTP, for `t3 sandbox` commands against the live server. */
export const sandboxHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "sandboxes",
  Effect.fnUntraced(function* (handlers) {
    const sandboxes = yield* SandboxService.SandboxService;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.sandboxes.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* sandboxes.list;
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.sandboxes.create")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sandboxes.create(args.payload);
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.sandboxes.start")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sandboxes.start(args.payload);
        }),
      )
      .handle(
        "stop",
        Effect.fn("environment.sandboxes.stop")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sandboxes.stop(args.payload);
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.sandboxes.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sandboxes.remove(args.payload);
        }),
      )
      .handle(
        "pair",
        Effect.fn("environment.sandboxes.pair")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sandboxes.pair(args.payload);
        }),
      );
  }),
);
