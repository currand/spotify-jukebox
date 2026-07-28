import * as React from "react";
import type { DisplayNameConflictKind } from "@/shared/dedup";
import type { GuestMe } from "@/shared/types";
import { ApiError, api } from "../http";
import { setStoredGuestSession } from "../utils/guest-session";

export function GuestNamePrompt({
  slug,
  onSaved,
}: {
  slug: string;
  onSaved: (profile: GuestMe) => void;
}) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [nameTaken, setNameTaken] = React.useState<{
    existingName: string;
    matchKind: DisplayNameConflictKind;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function saveName(options?: {
    confirmReclaim?: boolean;
    confirmDistinctName?: boolean;
  }) {
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
        body: JSON.stringify({
          displayName: trimmed,
          confirmReclaim: options?.confirmReclaim,
          confirmDistinctName: options?.confirmDistinctName,
        }),
      });
      if (result.sessionToken) {
        setStoredGuestSession(slug, result.sessionToken);
      }
      setNameTaken(null);
      const profile = await api<Parameters<typeof onSaved>[0]>(`/parties/${slug}/me`);
      onSaved(profile);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NAME_TAKEN") {
        setNameTaken({
          existingName: e.displayName ?? trimmed,
          matchKind: e.matchKind ?? "exact",
        });
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
              Someone named <strong>{nameTaken.existingName}</strong> is already
              here. Is that you?
            </p>
            <div className="guest-name-taken-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveName({ confirmReclaim: true })}
              >
                Yes, that&apos;s me
              </button>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => {
                  if (nameTaken.matchKind === "fuzzy") {
                    void saveName({ confirmDistinctName: true });
                    return;
                  }
                  setNameTaken(null);
                  setName("");
                }}
              >
                {nameTaken.matchKind === "fuzzy"
                  ? "No, that's not me"
                  : "No, pick another name"}
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
