import * as React from "react";
import type { PartyRateLimits, RateLimitConfig } from "@/shared/types";
import { DEFAULT_RATE_LIMITS } from "@/shared/types";
import { api } from "../http";
import { formatApiError } from "./QueueUi";

function LimitRow({
  label,
  hint,
  value,
  windowUnit,
  onChange,
}: {
  label: string;
  hint: string;
  value: RateLimitConfig;
  windowUnit: "min" | "sec";
  onChange: (next: RateLimitConfig) => void;
}) {
  const windowValue =
    windowUnit === "sec"
      ? Math.round(value.windowMs / 1000)
      : Math.round(value.windowMs / 60_000);

  return (
    <div className="limit-row">
      <div className="limit-row-label">{label}</div>
      <div className="small">{hint}</div>
      <div className="row limit-row-inputs">
        <label className="small">
          Max{" "}
          <input
            type="number"
            min={1}
            max={999}
            className="limit-row-number"
            value={value.count}
            onChange={(e) =>
              onChange({ ...value, count: Number(e.target.value) })
            }
          />
        </label>
        <label className="small">
          per{" "}
          <input
            type="number"
            min={1}
            max={windowUnit === "sec" ? 300 : 240}
            className="limit-row-number"
            value={windowValue}
            onChange={(e) => {
              const amount = Number(e.target.value);
              onChange({
                ...value,
                windowMs:
                  windowUnit === "sec" ? amount * 1000 : amount * 60_000,
              });
            }}
          />{" "}
          {windowUnit === "sec" ? "seconds" : "minutes"}
        </label>
      </div>
    </div>
  );
}

export function GuestLimitsFields({
  vetoThreshold,
  boostCap,
  rateLimits,
  onVetoThresholdChange,
  onBoostCapChange,
  onRateLimitsChange,
  showIntro = true,
}: {
  vetoThreshold: number;
  boostCap: number | null;
  rateLimits: PartyRateLimits;
  onVetoThresholdChange: (value: number) => void;
  onBoostCapChange: (value: number | null) => void;
  onRateLimitsChange: (next: PartyRateLimits) => void;
  showIntro?: boolean;
}) {
  function patchLimit(key: keyof PartyRateLimits, next: RateLimitConfig) {
    onRateLimitsChange({ ...rateLimits, [key]: next });
  }

  return (
    <>
      {showIntro && (
        <p className="small guest-limits-intro">
          Per-guest action budgets reset after each time window. Boost cap limits
          how many tracks can be boosted in the queue at once. Reset individual
          guests from the Guests page.
        </p>
      )}
      <label className="form-field">
        <span>Downvotes to skip a song</span>
        <input
          type="number"
          min={1}
          max={20}
          value={vetoThreshold}
          onChange={(e) => onVetoThresholdChange(Number(e.target.value))}
        />
      </label>
      <label className="form-field">
        <span>Active boost cap</span>
        <input
          type="number"
          min={1}
          max={99}
          placeholder="Unlimited"
          value={boostCap ?? ""}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onBoostCapChange(raw === "" ? null : Number(raw));
          }}
        />
        <span className="small">
          Max boosted tracks in the queue at once. Leave blank for unlimited.
        </span>
      </label>
      <LimitRow
        label="Add songs"
        hint="How many tracks a guest can queue in the window."
        value={rateLimits.add}
        windowUnit="min"
        onChange={(next) => patchLimit("add", next)}
      />
      <LimitRow
        label="Upvotes"
        hint="How many upvotes a guest can spend in the window."
        value={rateLimits.upvote}
        windowUnit="min"
        onChange={(next) => patchLimit("upvote", next)}
      />
      <LimitRow
        label="Downvotes"
        hint="How many downvotes a guest can cast in the window."
        value={rateLimits.veto}
        windowUnit="min"
        onChange={(next) => patchLimit("veto", next)}
      />
      <LimitRow
        label="Boost"
        hint="How many times a guest can boost a song in the window."
        value={rateLimits.boost}
        windowUnit="min"
        onChange={(next) => patchLimit("boost", next)}
      />
      <LimitRow
        label="Search (per guest)"
        hint="Spotify searches one guest can trigger in the window."
        value={rateLimits.search}
        windowUnit="min"
        onChange={(next) => patchLimit("search", next)}
      />
      <LimitRow
        label="Search (party-wide)"
        hint="Total Spotify searches across all guests in the window."
        value={rateLimits.partySearch}
        windowUnit="sec"
        onChange={(next) => patchLimit("partySearch", next)}
      />
    </>
  );
}

export function GuestLimitsPanel({
  partyId,
  vetoThreshold,
  boostCap,
  rateLimits,
  onSaved,
}: {
  partyId: string;
  vetoThreshold: number;
  boostCap: number | null;
  rateLimits: PartyRateLimits;
  onSaved: () => void;
}) {
  const [limits, setLimits] = React.useState<PartyRateLimits>(rateLimits);
  const [vetoes, setVetoes] = React.useState(vetoThreshold);
  const [boostCapValue, setBoostCapValue] = React.useState<number | null>(boostCap);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLimits(rateLimits);
    setVetoes(vetoThreshold);
    setBoostCapValue(boostCap);
  }, [partyId, rateLimits, vetoThreshold, boostCap]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/host/parties/${partyId}`, {
        method: "PATCH",
        body: JSON.stringify({
          rateLimits: limits,
          vetoThreshold: vetoes,
          boostCap: boostCapValue,
        }),
      });
      setNotice("Guest limits saved.");
      onSaved();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-section admin-limits-panel">
      <h3>Guest limits</h3>
      <GuestLimitsFields
        vetoThreshold={vetoes}
        boostCap={boostCapValue}
        rateLimits={limits}
        onVetoThresholdChange={setVetoes}
        onBoostCapChange={setBoostCapValue}
        onRateLimitsChange={setLimits}
      />
      {error && <p className="error">{error}</p>}
      {notice && <p className="small">{notice}</p>}
      <div className="row party-controls">
        <button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save limits"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setLimits(DEFAULT_RATE_LIMITS);
            setVetoes(3);
            setBoostCapValue(null);
          }}
        >
          Reset defaults
        </button>
      </div>
    </div>
  );
}
