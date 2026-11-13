import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { surfaceActive } from "./cadence";
import { sharedClock } from "./clock";

// Hidden surfaces do not poll. react-native-web maps document visibility onto AppState.
export function useSurfaceActive(): boolean {
  const [active, setActive] = useState(() => surfaceActive(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setActive(surfaceActive(state)));
    return () => subscription.remove();
  }, []);
  return active;
}

// Non-React variant for code that installs and removes controls outside a component.
export function onSurfaceChange(listener: (active: boolean) => void): () => void {
  const subscription = AppState.addEventListener("change", state => listener(surfaceActive(state)));
  return () => subscription.remove();
}

// Re-render when the earliest visible change of this control is due; one timer serves every control.
export function useClockRender(nextAt: (now: number) => number | null): void {
  const latest = useRef(nextAt);
  latest.current = nextAt;
  const [, setTick] = useState(0);
  useEffect(() => sharedClock.subscribe(() => setTick(tick => tick + 1), now => latest.current(now)), []);
  useEffect(() => {
    sharedClock.reschedule();
  });
}
