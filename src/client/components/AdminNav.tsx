import { Link, useLocation } from "react-router-dom";

export function AdminNav({
  guestCount,
  partyActive,
}: {
  guestCount: number;
  partyActive: boolean;
}) {
  const location = useLocation();
  if (!partyActive) return null;

  const onQueue = location.pathname === "/admin";
  const onGuests = location.pathname === "/admin/guests";
  const onDisplay = location.pathname === "/admin/display";
  const onDiagnostics = location.pathname === "/admin/diagnostics";

  return (
    <nav className="admin-nav" aria-label="Admin sections">
      {partyActive ? (
        <>
          <Link
            to="/admin"
            className={`admin-nav-link${onQueue ? " admin-nav-link--active" : ""}`}
          >
            Queue
          </Link>
          <Link
            to="/admin/guests"
            className={`admin-nav-link${onGuests ? " admin-nav-link--active" : ""}`}
          >
            Guests
            {guestCount > 0 ? (
              <span className="admin-nav-badge">{guestCount}</span>
            ) : null}
          </Link>
          <Link
            to="/admin/display"
            className={`admin-nav-link${onDisplay ? " admin-nav-link--active" : ""}`}
          >
            Display
          </Link>
        </>
      ) : null}
      <Link
        to="/admin/diagnostics"
        className={`admin-nav-link${onDiagnostics ? " admin-nav-link--active" : ""}`}
      >
        Stats
      </Link>
    </nav>
  );
}
