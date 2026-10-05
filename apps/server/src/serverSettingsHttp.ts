import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "./auth/http.ts";
import * as ServerSettings from "./serverSettings.ts";

/** Settings over HTTP, for a server handing this one work, such as a cube home. */
export const serverSettingsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "settings",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* ServerSettings.ServerSettingsService;
    return handlers.handle(
      "update",
      Effect.fn("environment.settings.update")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        yield* settings
          .updateSettings(args.payload)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("settings_update_failed", cause)));
      }),
    );
  }),
);
