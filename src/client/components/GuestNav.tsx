import { Link, useLocation } from "react-router-dom";

export function GuestNav({
  slug,
  activeSongCount,
}: {
  slug: string;
  activeSongCount: number;
}) {
  const location = useLocation();

  const base = `/p/${slug}`;
  const onQueue =
    location.pathname === base || location.pathname === `${base}/`;
  const onMySongs = location.pathname === `${base}/songs`;

  return (
    <nav className="guest-nav" aria-label="Guest sections">
      <Link
        to={base}
        className={`guest-nav-link${onQueue ? " guest-nav-link--active" : ""}`}
      >
        Queue
      </Link>
      <Link
        to={`${base}/songs`}
        className={`guest-nav-link${onMySongs ? " guest-nav-link--active" : ""}`}
      >
        My Songs
        {activeSongCount > 0 ? (
          <span className="guest-nav-badge">{activeSongCount}</span>
        ) : null}
      </Link>
    </nav>
  );
}
