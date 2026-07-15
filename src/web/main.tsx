import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/web/app";
import "@/web/index.css";
import { initializePreferences } from "@/web/lib/preferences";

initializePreferences();

const root = document.querySelector("#root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
