import type { DeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { useEffect, useRef, type RefObject } from "react";

/** Pixels of wheel travel per X wheel click, close to one line of text. */
const WHEEL_STEP_PX = 40;
const LINE_PX = 40;
const PAGE_PX = 800;

const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
};

const xButton = (event: React.PointerEvent<HTMLElement>) =>
  event.button === 1 ? 2 : event.button === 2 ? 3 : 1;

/**
 * Mouse input for desktop screens: hover moves (at most one per frame, and
 * only while the pointer is moving), real buttons, and the wheel. The local
 * cursor stays visible because the stream is captured without one.
 */
export function useDesktopPointer(clientRef: RefObject<DeviceStreamClient | null>) {
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const wheelRemainder = useRef({ x: 0, y: 0 });

  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const flushMove = () => {
    moveFrame.current = null;
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point) clientRef.current?.sendMouse("move", point.x, point.y, 1);
  };

  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      (event.currentTarget.parentElement as HTMLElement | null)?.focus();
      const { x, y } = normalizedPoint(event);
      clientRef.current?.sendMouse("down", x, y, xButton(event));
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      pendingMove.current = normalizedPoint(event);
      moveFrame.current ??= requestAnimationFrame(flushMove);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const { x, y } = normalizedPoint(event);
      clientRef.current?.sendMouse("up", x, y, xButton(event));
    },
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => event.preventDefault(),
    onWheel: (event: React.WheelEvent<HTMLElement>) => {
      const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
      const remainder = wheelRemainder.current;
      remainder.x += event.deltaX * scale;
      remainder.y += event.deltaY * scale;
      const dx = Math.trunc(remainder.x / WHEEL_STEP_PX);
      const dy = Math.trunc(remainder.y / WHEEL_STEP_PX);
      remainder.x -= dx * WHEEL_STEP_PX;
      remainder.y -= dy * WHEEL_STEP_PX;
      clientRef.current?.sendWheel(dx, dy);
    },
  };
}
