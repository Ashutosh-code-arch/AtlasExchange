import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { webConfig } from "./config/runtime-config";
import { AuthenticationProvider } from "./features/authentication";
import "./styles.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (rootElement === null) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthenticationProvider apiBaseUrl={webConfig.apiBaseUrl}>
      <App apiBaseUrl={webConfig.apiBaseUrl} />
    </AuthenticationProvider>
  </StrictMode>,
);
