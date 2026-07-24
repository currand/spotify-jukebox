import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { AdminGuestsPage } from "./pages/AdminGuestsPage";
import { AdminPage } from "./pages/AdminPage";
import { GuestMySongsPage } from "./pages/GuestMySongsPage";
import { GuestPage } from "./pages/GuestPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/p/:slug/songs" element={<GuestMySongsPage />} />
        <Route path="/p/:slug" element={<GuestPage />} />
        <Route path="/admin/guests" element={<AdminGuestsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
