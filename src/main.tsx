import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function start() {
  // Plain-browser preview (`npm run dev` without Tauri): fake the backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
