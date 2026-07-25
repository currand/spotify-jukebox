import * as React from "react";
import { Link } from "react-router-dom";
import type { GuestAdminView, PartyView } from "@/shared/types";
import { AdminNav } from "../components/AdminNav";
import { GuestAdminList } from "../components/GuestAdminList";
import { formatApiError } from "../components/QueueUi";
import { api, apiOptional } from "../http";

interface PartyFull extends PartyView {
  id: string;
  slug: string;
  guestCount?: number;
}

export function AdminGuestsPage() {
  const [party, setParty] = React.useState<PartyFull | null>(null);
  const [guests, setGuests] = React.useState<GuestAdminView[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const p = await apiOptional<PartyFull>("/host/parties/current");
      setParty(p);
      if (p) {
        const g = await api<{ guests: GuestAdminView[] }>(
          `/host/parties/${p.id}/guests`,
        );
        setGuests(g.guests);
      } else {
        setGuests([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  async function resetLimits(guest: GuestAdminView) {
    if (!party) return;
    const label = guest.displayName ?? "this guest";
    if (
      !confirm(
        `Reset limits for ${label}?\n\nThey can add, upvote, veto, and boost again. Any active boosts on their songs are removed so the queue can resync.`,
      )
    ) {
      return;
    }
    try {
      setError(null);
      await api(`/host/parties/${party.id}/guests/${guest.id}/reset-limits`, {
        method: "POST",
      });
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function banToggle(guest: GuestAdminView) {
    if (!party) return;
    try {
      setError(null);
      await api(`/host/parties/${party.id}/guests/${guest.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !guest.disabled }),
      });
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  async function clearAllGuests() {
    if (!party) return;
    if (
      !confirm(
        `Remove all ${guests.length} guest(s)?\n\nTheir sessions, votes, and vetoes will be cleared. Songs they added stay in the queue.`,
      )
    ) {
      return;
    }
    try {
      setError(null);
      await api(`/host/parties/${party.id}/guests`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  const guestCount = guests.length;

  return (
    <div className="app admin-guests-page">
      <h1>Jukebox Admin</h1>
      <AdminNav guestCount={guestCount} partyActive={!!party} />
      {error && <p className="error">{error}</p>}

      {!party ? (
        <div className="card">
          <p>No active party.</p>
          <Link to="/admin" className="admin-back-link">
            ← Back to admin
          </Link>
        </div>
      ) : (
        <div className="card">
          <p className="small guest-page-party">{party.name}</p>
          <GuestAdminList
            guests={guests}
            onBanToggle={(g) => void banToggle(g)}
            onResetLimits={(g) => void resetLimits(g)}
            onClearAll={() => void clearAllGuests()}
          />
        </div>
      )}
    </div>
  );
}
