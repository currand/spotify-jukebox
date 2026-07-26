import * as React from "react";

export type PopupKind = "success" | "error" | "info";

const DEFAULT_DURATION_MS = 3200;

export function usePopup(durationMs = DEFAULT_DURATION_MS) {
  const [popup, setPopup] = React.useState<{
    message: string;
    kind: PopupKind;
  } | null>(null);
  const timerRef = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  const hidePopup = React.useCallback(() => {
    window.clearTimeout(timerRef.current);
    setPopup(null);
  }, []);

  const showPopup = React.useCallback(
    (message: string, kind: PopupKind = "info") => {
      window.clearTimeout(timerRef.current);
      setPopup({ message, kind });
      timerRef.current = window.setTimeout(() => setPopup(null), durationMs);
    },
    [durationMs],
  );

  function PopupHost() {
    if (!popup) return null;
    return (
      <div className="popup-layer" role="status" aria-live="polite">
        <div className={`popup popup--${popup.kind}`}>{popup.message}</div>
      </div>
    );
  }

  return { showPopup, hidePopup, PopupHost };
}
