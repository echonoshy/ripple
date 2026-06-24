import React from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./globals.css";
import App from "./App";
import ClientContextDemoPage from "@/components/clientContextDemo/ClientContextDemoPage";
import { I18nProvider } from "./i18n";

const isClientContextDemoRoute =
  typeof window !== "undefined" &&
  window.location.pathname.replace(/\/+$/, "") === "/client-context-demo";
const RootComponent = isClientContextDemoRoute ? ClientContextDemoPage : App;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <RootComponent />
    </I18nProvider>
  </React.StrictMode>
);
