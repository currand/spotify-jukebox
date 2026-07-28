import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { AdminDisplayPage } from "./pages/AdminDisplayPage";
import { AdminDiagnosticsPage } from "./pages/AdminDiagnosticsPage";
import { AdminGuestsPage } from "./pages/AdminGuestsPage";
import { AdminPage } from "./pages/AdminPage";
import { GuestMyInfoPage } from "./pages/GuestMyInfoPage";
import { GuestPage } from "./pages/GuestPage";
import "./styles.css";

function RedirectGuestSongsToInfo() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <Navigate to={`/p/${slug}/info`} replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/p/:slug/info" element={<GuestMyInfoPage />} />
        <Route path="/p/:slug/songs" element={<RedirectGuestSongsToInfo />} />
        <Route path="/p/:slug" element={<GuestPage />} />
        <Route path="/admin/display" element={<AdminDisplayPage />} />
        <Route path="/admin/guests" element={<AdminGuestsPage />} />
        <Route path="/admin/diagnostics" element={<AdminDiagnosticsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
