import React from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./globals.css";
import App from "./App";
import { I18nProvider } from "./i18n";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
