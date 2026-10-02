/**
 * Streams X displays on the server's own machine as `desktop` devices.
 *
 * Unlike simulators and emulators, which expo-device-hub serves on a loopback
 * origin, desktops are served in-process: the only external work is spawning
 * `ffmpeg` (capture and H.264) and `xdotool` (input), so there is nothing to
 * isolate in a child. The proxy routes `/vendor/serve-desktop/*` here.
 *
 * The socket speaks serve-emu's wire format so web and mobile reuse the
 * Android decoder unchanged: each access unit is prefixed with a 16-byte
 * "SEMU" header (magic, version 1, key flag, u64 pts), and the client sends
 * JSON upstream. Touch messages become mouse events; Android keycodes map to
 * X keysyms for the few keys the viewer sends.
 */
import type { DeviceSummary } from "@t3tools/contracts";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpServerResponse } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Socket from "effect/unstable/socket/Socket";

import * as ProcessRunner from "../processRunner.ts";

const X11_SOCKET_DIR = "/tmp/.X11-unix";
const SEMU_MAGIC = 0x53454d55;
const SEMU_FLAG_KEY = 1;
const AUD_START = Uint8Array.from([0, 0, 0, 1, 9]);
const FRAME_RATE = 30;
const SCREENSHOT_TIMEOUT = "15 seconds";

/** Android keycodes the viewer sends for non-text keys, mapped to X keysyms. */
const ANDROID_KEYCODE_TO_KEYSYM: Readonly<Record<number, string>> = {
  66: "Return",
  67: "BackSpace",
  61: "Tab",
  111: "Escape",
  112: "Delete",
  19: "Up",
  20: "Down",
  21: "Left",
  22: "Right",
  62: "space",
  92: "Prior",
  93: "Next",
  122: "Home",
  123: "End",
};

const InputMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("reset-video") }),
  Schema.Struct({
    type: Schema.Literal("touch"),
    action: Schema.Literals(["down", "move", "up"]),
    x: Schema.Number,
    y: Schema.Number,
  }),
  // Desktop viewers send real mouse and wheel input; touch stays for viewers
  // that only know the Android protocol.
  Schema.Struct({
    type: Schema.Literal("mouse"),
    action: Schema.Literals(["down", "move", "up"]),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.Literals([1, 2, 3]),
  }),
  Schema.Struct({ type: Schema.Literal("wheel"), dx: Schema.Int, dy: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("key"), keycode: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("back") }),
  Schema.Struct({ type: Schema.Literal("home") }),
]);
const decodeInputMessage = Schema.decodeUnknownOption(Schema.fromJsonString(InputMessage));

const MAX_WHEEL_STEPS = 20;

/**
 * How one viewer message reaches X. `script` lines go to the viewer's
 * long-lived `xdotool -` and are built only from numbers and fixed key names;
 * typed text runs as a separate argv so it never meets xdotool's script parser.
 */
type DesktopInput =
  | { readonly kind: "script"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "type"; readonly text: string };

/** Viewer points arrive normalised to 0–1 of the rendered screen. */
function toDesktopInput(
  text: string,
  size: { readonly width: number; readonly height: number },
): DesktopInput | null {
  const message = decodeInputMessage(text);
  if (message._tag === "None") return null;
  const input = message.value;
  const at = (x: number, y: number) =>
    `mousemove ${Math.round(clampUnit(x) * (size.width - 1))} ${Math.round(clampUnit(y) * (size.height - 1))}`;
  const script = (...lines: ReadonlyArray<string>): DesktopInput => ({ kind: "script", lines });
  switch (input.type) {
    case "touch":
      if (input.action === "move") return script(at(input.x, input.y));
      return script(at(input.x, input.y), `${input.action === "down" ? "mousedown" : "mouseup"} 1`);
    case "mouse":
      if (input.action === "move") return script(at(input.x, input.y));
      return script(
        at(input.x, input.y),
        `${input.action === "down" ? "mousedown" : "mouseup"} ${input.button}`,
      );
    case "wheel": {
      // X maps wheel directions to buttons 4–7, one click per step.
      const lines: string[] = [];
      const steps = (count: number, negative: number, positive: number) => {
        const repeat = Math.min(Math.abs(count), MAX_WHEEL_STEPS);
        if (repeat > 0) lines.push(`click --repeat ${repeat} ${count < 0 ? negative : positive}`);
      };
      steps(input.dy, 4, 5);
      steps(input.dx, 6, 7);
      return lines.length > 0 ? script(...lines) : null;
    }
    case "key": {
      const keysym = ANDROID_KEYCODE_TO_KEYSYM[input.keycode];
      return keysym === undefined ? null : script(`key ${keysym}`);
    }
    case "text":
      return input.text === " " ? script("key space") : { kind: "type", text: input.text };
    case "back":
      return script("key Escape");
    // The encoder emits a keyframe every second, so a viewer that asks for one
    // waits at most that long. Restarting ffmpeg instead would discard the
    // keyframe a fresh encoder was about to send.
    case "reset-video":
    case "home":
      return null;
  }
}

export class DesktopStreamError extends Schema.TaggedError<DesktopStreamError>()(
  "DesktopStreamError",
  { display: Schema.String, step: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop display ${this.display} failed while ${this.step}.`;
  }
}

export class DesktopStreamer extends Context.Service<
  DesktopStreamer,
  {
    /** Null when this machine can serve desktops; otherwise why not. */
    readonly unavailableReason: Effect.Effect<string | null>;
    /** Running X displays, as devices on the local host. */
    readonly listDisplays: Effect.Effect<ReadonlyArray<DeviceSummary>>;
    /** Serves one viewer socket until either side closes. */
    readonly stream: (
      request: HttpServerRequest.HttpServerRequest,
      display: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, DesktopStreamError>;
    readonly screenshot: (display: string) => Effect.Effect<Uint8Array, DesktopStreamError>;
  }
>()("t3/device/DesktopStreamer") {}

const isDisplayId = (value: string) => /^:\d{1,4}$/.test(value);
const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Geometry of the display's root window, from `xdotool getdisplaygeometry`. */
const displayGeometry = Effect.fn("DesktopStreamer.displayGeometry")(function* (
  runner: ProcessRunner.ProcessRunner["Service"],
  display: string,
) {
  const result = yield* runner
    .run({
      command: "xdotool",
      args: ["getdisplaygeometry"],
      env: { ...process.env, DISPLAY: display },
      timeout: "5 seconds",
    })
    .pipe(Effect.orElseSucceed(() => null));
  const match = result?.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
});

function isKeyframe(accessUnit: Uint8Array): boolean {
  for (let i = 0; i + 3 < accessUnit.length; i++) {
    if (accessUnit[i] === 0 && accessUnit[i + 1] === 0 && accessUnit[i + 2] === 1) {
      if ((accessUnit[i + 3]! & 0x1f) === 5) return true;
    }
  }
  return false;
}

function indexOfAud(buffer: Uint8Array, from: number): number {
  outer: for (let i = from; i + AUD_START.length <= buffer.length; i++) {
    for (let j = 0; j < AUD_START.length; j++) {
      if (buffer[i + j] !== AUD_START[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function semuPacket(accessUnit: Uint8Array, nowMillis: number): Uint8Array {
  const packet = new Uint8Array(16 + accessUnit.length);
  const view = new DataView(packet.buffer);
  view.setUint32(0, SEMU_MAGIC, false);
  view.setUint8(4, 1);
  view.setUint8(5, isKeyframe(accessUnit) ? SEMU_FLAG_KEY : 0);
  view.setBigUint64(8, BigInt(nowMillis), false);
  packet.set(accessUnit, 16);
  return packet;
}

export const make = Effect.fn("DesktopStreamer.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* ProcessRunner.ProcessRunner;

  const unavailableReason: Effect.Effect<string | null> = Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    if (hostPlatform !== "linux") return "Desktop streaming needs a Linux host with an X display.";
    if (!(yield* isCommandAvailable("ffmpeg"))) return "ffmpeg was not found on PATH.";
    if (!(yield* isCommandAvailable("xdotool"))) return "xdotool was not found on PATH.";
    return null;
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));

  const listDisplays: Effect.Effect<ReadonlyArray<DeviceSummary>> = Effect.gen(function* () {
    if ((yield* unavailableReason) !== null) return [];
    const entries = yield* fs.readDirectory(X11_SOCKET_DIR).pipe(Effect.orElseSucceed(() => []));
    const displays: DeviceSummary[] = [];
    for (const entry of entries) {
      const match = entry.match(/^X(\d{1,4})$/);
      if (!match) continue;
      const display = `:${match[1]}`;
      // A socket file outlives a crashed or restarted X server, so only
      // displays that answer a geometry query are listed.
      const geometry = yield* displayGeometry(runner, display);
      if (geometry === null) continue;
      displays.push({
        hostId: LOCAL_DEVICE_HOST_ID,
        id: display,
        platform: "desktop",
        name: `Display ${display}`,
        version: `${geometry.width}×${geometry.height}`,
        booted: true,
        physical: false,
      });
    }
    return displays;
  });

  const typeText = (display: string, text: string) =>
    runner
      .run({
        command: "xdotool",
        args: ["type", "--", text],
        env: { ...process.env, DISPLAY: display },
        timeout: "5 seconds",
      })
      .pipe(Effect.ignore);

  /** One encoder per viewer, for the life of its socket. */
  const runEncoder = Effect.fn("DesktopStreamer.runEncoder")(function* (
    display: string,
    write: (packet: Uint8Array) => Effect.Effect<void, Socket.SocketError>,
  ) {
    const geometry = yield* displayGeometry(runner, display);
    const size = geometry ? `${geometry.width}x${geometry.height}` : "1280x800";
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        [
          "-loglevel",
          "error",
          "-f",
          "x11grab",
          // The viewer shows the local cursor, which tracks the pointer with
          // no network or encode delay; a painted remote cursor would lag it.
          "-draw_mouse",
          "0",
          "-framerate",
          String(FRAME_RATE),
          "-video_size",
          size,
          "-i",
          display,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-g",
          String(FRAME_RATE),
          "-keyint_min",
          String(FRAME_RATE),
          "-bf",
          "0",
          "-x264-params",
          "repeat-headers=1:aud=1",
          "-b:v",
          "6M",
          "-maxrate",
          "8M",
          "-bufsize",
          "2M",
          "-f",
          "h264",
          "-",
        ],
        { detached: false, shell: false, stdout: "pipe", stderr: "ignore" },
      ),
    );
    let pending = new Uint8Array(0);
    yield* child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const joined = new Uint8Array(pending.length + chunk.length);
          joined.set(pending);
          joined.set(chunk, pending.length);
          let start = 0;
          for (;;) {
            const next = indexOfAud(joined, start + AUD_START.length);
            if (next < 0) break;
            yield* write(semuPacket(joined.subarray(start, next), yield* Clock.currentTimeMillis));
            start = next;
          }
          pending = joined.subarray(start);
        }),
      ),
    );
  });

  const stream = Effect.fn("DesktopStreamer.stream")(function* (
    request: HttpServerRequest.HttpServerRequest,
    display: string,
  ) {
    if (!isDisplayId(display)) {
      return HttpServerResponse.text("Unknown display", { status: 404 });
    }
    const socket = yield* request.upgrade.pipe(
      Effect.mapError((cause) => new DesktopStreamError({ display, step: "upgrading", cause })),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const { pull } = yield* socket.reader;
        yield* Effect.forkScoped(
          runEncoder(display, (packet) => writer.write(packet)).pipe(Effect.ignoreCause),
        );
        const size = (yield* displayGeometry(runner, display)) ?? { width: 1280, height: 800 };
        // One xdotool per viewer reads commands as they arrive, so hover
        // movement does not spawn a process per event.
        const commands = yield* Queue.unbounded<string>();
        yield* spawner
          .spawn(
            ChildProcess.make("xdotool", ["-"], {
              detached: false,
              shell: false,
              stdin: Stream.fromQueue(commands).pipe(
                Stream.map((line) => textEncoder.encode(`${line}\n`)),
              ),
              stdout: "ignore",
              stderr: "ignore",
              env: { ...process.env, DISPLAY: display },
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new DesktopStreamError({ display, step: "starting input", cause }),
            ),
          );
        while (true) {
          const frames = yield* pull;
          for (const frame of frames) {
            // Node can deliver text frames as bytes; input is always JSON text.
            const input = toDesktopInput(
              typeof frame === "string" ? frame : textDecoder.decode(frame),
              size,
            );
            if (input?.kind === "script") yield* Queue.offerAll(commands, input.lines);
            else if (input?.kind === "type") yield* typeText(display, input.text);
          }
        }
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  });

  const screenshot = Effect.fn("DesktopStreamer.screenshot")(function* (display: string) {
    if (!isDisplayId(display)) {
      return yield* new DesktopStreamError({
        display,
        step: "capturing",
        cause: new Error("Unknown display"),
      });
    }
    const chunks: Uint8Array[] = [];
    const result = yield* runner
      .run({
        command: "ffmpeg",
        args: [
          "-loglevel",
          "error",
          "-f",
          "x11grab",
          "-i",
          display,
          "-frames:v",
          "1",
          "-f",
          "image2",
          "-c:v",
          "png",
          "-",
        ],
        timeout: SCREENSHOT_TIMEOUT,
        maxOutputBytes: 64 * 1024 * 1024,
        onStdoutChunk: (chunk) => chunks.push(chunk),
      })
      .pipe(
        Effect.mapError((cause) => new DesktopStreamError({ display, step: "capturing", cause })),
      );
    if (result.code !== 0) {
      return yield* new DesktopStreamError({
        display,
        step: "capturing",
        cause: new Error(result.stderr.trim() || `ffmpeg exited with ${result.code}`),
      });
    }
    const png = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      png.set(chunk, offset);
      offset += chunk.length;
    }
    return png;
  });

  return DesktopStreamer.of({ unavailableReason, listDisplays, stream, screenshot });
});

export const layer = Layer.effect(DesktopStreamer, make());

/** Exposed for tests. */
export const __testing = { indexOfAud, isKeyframe, semuPacket, toDesktopInput };
