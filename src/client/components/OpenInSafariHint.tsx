import * as React from "react";
import { dismissSafariHint, shouldShowSafariHint } from "../utils/guest-session";

export function OpenInSafariHint({ joinUrl }: { joinUrl: string }) {
  const [visible, setVisible] = React.useState(shouldShowSafariHint);

  if (!visible) return null;

  function dismiss() {
    dismissSafariHint();
    setVisible(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="banner warn safari-hint">
      <strong>Save your session on iPhone</strong>
      <p className="small safari-hint-body">
        The Camera app opens a temporary browser — if you close it and scan again,
        you&apos;ll look like a new guest. Tap{" "}
        <strong>Open in Safari</strong> in the bar at the bottom (or copy the link
        and paste it in Safari).
      </p>
      <div className="safari-hint-actions">
        <button type="button" className="secondary" onClick={() => void copyLink()}>
          Copy party link
        </button>
        <button type="button" className="linkish" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
