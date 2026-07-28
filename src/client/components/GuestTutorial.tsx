import * as React from "react";
import {
  ThumbsDownIcon,
  ThumbsUpIcon,
  BoostButton,
} from "./QueueUi";
import { api } from "../http";

const STEPS = [
  {
    title: "Upvote songs you like",
    body: "Tap the thumbs up on someone else's track to bump it higher in the queue.",
    icon: <ThumbsUpIcon size={28} />,
  },
  {
    title: "Downvote to skip",
    body: "Thumbs down adds a veto. Enough downvotes skip the song for everyone.",
    icon: <ThumbsDownIcon size={28} />,
  },
  {
    title: "Boost once per party",
    body: "Use your one boost to jump a song into the fast lane — higher upvotes play sooner there.",
    icon: <BoostButton disabled />,
  },
] as const;

export function GuestTutorial({
  slug,
  onDismiss,
}: {
  slug: string;
  onDismiss: () => void;
}) {
  const [step, setStep] = React.useState(0);
  const [saving, setSaving] = React.useState(false);

  async function dismiss() {
    if (saving) return;
    setSaving(true);
    try {
      await api(`/parties/${slug}/me`, {
        method: "PATCH",
        body: JSON.stringify({ tutorialSeen: true }),
      });
      onDismiss();
    } catch {
      onDismiss();
    } finally {
      setSaving(false);
    }
  }

  const current = STEPS[step]!;
  const isLast = step >= STEPS.length - 1;

  return (
    <div className="guest-tutorial-overlay" role="dialog" aria-modal="true">
      <div className="guest-tutorial-sheet card">
        <p className="small guest-tutorial-progress">
          Step {step + 1} of {STEPS.length}
        </p>
        <div className="guest-tutorial-icon">{current.icon}</div>
        <h2>{current.title}</h2>
        <p className="guest-tutorial-body">{current.body}</p>
        <div className="row guest-tutorial-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void dismiss()}
            disabled={saving}
          >
            Skip
          </button>
          {isLast ? (
            <button type="button" onClick={() => void dismiss()} disabled={saving}>
              {saving ? "Saving…" : "Got it"}
            </button>
          ) : (
            <button type="button" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
