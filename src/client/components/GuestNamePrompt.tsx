import * as React from "react";
import { ApiError, api } from "../http";
import { setStoredGuestSession } from "../utils/guest-session";

export function GuestNamePrompt({
  slug,
  onSaved,
}: {
  slug: string;
  onSaved: (profile: {
    id: string;
    displayName: string | null;
    boostUsed: boolean;
    activeSongCount?: number;
    quota?: { add: number; upvote: number; veto: number };
  }) => void;
}) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [nameTaken, setNameTaken] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function saveName(confirmReclaim = false) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{
        id: string;
        displayName: string | null;
        boostUsed: boolean;
        sessionToken?: string;
      }>(`/parties/${slug}/me`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: trimmed, confirmReclaim }),
      });
      if (result.sessionToken) {
        setStoredGuestSession(slug, result.sessionToken);
      }
      setNameTaken(null);
      const profile = await api<Parameters<typeof onSaved>[0]>(`/parties/${slug}/me`);
      onSaved(profile);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NAME_TAKEN") {
        setNameTaken(trimmed);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "Could not save name");
        setNameTaken(null);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app guest-name-gate">
      <div className="card guest-name-card">
        <h1>Welcome</h1>
        <p className="guest-name-intro">
          Enter your name to join the party queue.
        </p>

        {nameTaken ? (
          <div className="guest-name-taken">
            <p>
              Someone named <strong>{nameTaken}</strong> is already here. Is
              that you?
            </p>
            <div className="guest-name-taken-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveName(true)}
              >
                Yes, that&apos;s me
              </button>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => {
                  setNameTaken(null);
                  setName("");
                }}
              >
                No, pick another name
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="guest-name-label" htmlFor="guest-display-name">
              Your name
            </label>
            <input
              id="guest-display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && void saveName()}
            />
            <div className="guest-name-submit">
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={!name.trim() || saving}
              >
                {saving ? "Saving…" : "Continue"}
              </button>
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
