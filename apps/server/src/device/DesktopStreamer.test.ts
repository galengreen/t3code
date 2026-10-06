import { describe, expect, it } from "vite-plus/test";

import { __testing } from "./DesktopStreamer.ts";

const { indexOfAud, isKeyframe, semuPacket, toDesktopInput } = __testing;

const aud = [0, 0, 0, 1, 0x09, 0xf0];
const sps = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e];
const idr = [0, 0, 0, 1, 0x65, 0x88];
const slice = [0, 0, 0, 1, 0x41, 0x9a];

describe("DesktopStreamer framing", () => {
  it("finds access-unit boundaries at AUD start codes only", () => {
    const stream = Uint8Array.from([...aud, ...sps, ...idr, ...aud, ...slice]);
    expect(indexOfAud(stream, 0)).toBe(0);
    expect(indexOfAud(stream, aud.length)).toBe(aud.length + sps.length + idr.length);
    expect(indexOfAud(stream, aud.length + sps.length + idr.length + 1)).toBe(-1);
  });

  it("flags IDR access units as keyframes", () => {
    expect(isKeyframe(Uint8Array.from([...aud, ...sps, ...idr]))).toBe(true);
    expect(isKeyframe(Uint8Array.from([...aud, ...slice]))).toBe(false);
  });

  it("prefixes serve-emu's 16-byte SEMU header with the key flag and timestamp", () => {
    const unit = Uint8Array.from([...aud, ...idr]);
    const packet = semuPacket(unit, 1_700_000_000_123);
    const view = new DataView(packet.buffer);
    expect(view.getUint32(0, false)).toBe(0x53454d55);
    expect(view.getUint8(4)).toBe(1);
    expect(view.getUint8(5)).toBe(1);
    expect(Number(view.getBigUint64(8, false))).toBe(1_700_000_000_123);
    expect(packet.subarray(16)).toEqual(unit);
    expect(semuPacket(Uint8Array.from([...aud, ...slice]), 0)[5]).toBe(0);
  });
});

describe("DesktopStreamer input", () => {
  const size = { width: 1600, height: 1000 };
  const input = (message: unknown) => toDesktopInput(JSON.stringify(message), size);

  it("scales normalised points to display pixels and clamps them", () => {
    expect(input({ type: "mouse", action: "move", x: 0.5, y: 0.25, button: 1 })).toEqual({
      kind: "script",
      lines: ["mousemove 800 250"],
    });
    expect(input({ type: "touch", action: "down", x: 1.4, y: -1 })).toEqual({
      kind: "script",
      lines: ["mousemove 1599 0", "mousedown 1"],
    });
  });

  it("presses the requested mouse button", () => {
    expect(input({ type: "mouse", action: "up", x: 0, y: 0, button: 3 })).toEqual({
      kind: "script",
      lines: ["mousemove 0 0", "mouseup 3"],
    });
  });

  it("turns wheel steps into X wheel button clicks, capped per message", () => {
    expect(input({ type: "wheel", dx: 0, dy: -2 })).toEqual({
      kind: "script",
      lines: ["click --repeat 2 4"],
    });
    expect(input({ type: "wheel", dx: 3, dy: 500 })).toEqual({
      kind: "script",
      lines: ["click --repeat 20 5", "click --repeat 3 7"],
    });
    expect(input({ type: "wheel", dx: 0, dy: 0 })).toBeNull();
  });

  it("types text outside the script stream and maps known keys", () => {
    expect(input({ type: "text", text: "'" })).toEqual({ kind: "type", text: "'" });
    expect(input({ type: "text", text: " " })).toEqual({ kind: "script", lines: ["key space"] });
    expect(input({ type: "key", keycode: 66 })).toEqual({ kind: "script", lines: ["key Return"] });
    expect(input({ type: "key", keycode: 9999 })).toBeNull();
  });

  it("ignores malformed and non-input messages", () => {
    expect(toDesktopInput("not json", size)).toBeNull();
    expect(input({ type: "mouse", action: "down", x: 0, y: 0, button: 9 })).toBeNull();
    expect(input({ type: "reset-video" })).toBeNull();
  });
});
