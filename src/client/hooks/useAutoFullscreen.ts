import * as React from "react";

/** Best-effort fullscreen; retries on first user gesture if the browser blocks auto-entry. */
export function useAutoFullscreen(enabled: boolean) {
  const enteredRef = React.useRef(false);

  const enterFullscreen = React.useCallback(async () => {
    if (!enabled || enteredRef.current || document.fullscreenElement) {
      enteredRef.current = true;
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
      enteredRef.current = true;
    } catch {
      // Blocked without a user gesture — listener below will retry.
    }
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    void enterFullscreen();
  }, [enabled, enterFullscreen]);

  React.useEffect(() => {
    if (!enabled) return;
    const retry = () => {
      void enterFullscreen();
    };
    document.addEventListener("pointerdown", retry, { once: true });
    document.addEventListener("keydown", retry, { once: true });
    return () => {
      document.removeEventListener("pointerdown", retry);
      document.removeEventListener("keydown", retry);
    };
  }, [enabled, enterFullscreen]);
}
