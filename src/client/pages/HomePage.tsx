export function HomePage() {
  return (
    <div className="app">
      <h1>Jukebox</h1>
      <p>Party queue for Spotify — guests vote on what plays next.</p>
      <div className="card">
        <h2>Host</h2>
        <p>
          <a href="/admin">Open admin</a> to connect Spotify and run a party.
        </p>
      </div>
      <div className="card">
        <h2>Guest</h2>
        <p className="small">
          Open the link or scan the QR code your host shared (looks like{" "}
          <code>/p/your-party</code>).
        </p>
      </div>
    </div>
  );
}
