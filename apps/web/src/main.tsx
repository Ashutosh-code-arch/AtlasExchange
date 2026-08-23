import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { readInitialApplicationRoute } from "./app/initial-route";
import { webConfig } from "./config/runtime-config";
import { AuthenticationProvider } from "./features/authentication";
import "./styles.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");
const initialRoute = readInitialApplicationRoute(window.location, window.history);

if (rootElement === null) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthenticationProvider apiBaseUrl={webConfig.apiBaseUrl}>
      <App apiBaseUrl={webConfig.apiBaseUrl} initialRoute={initialRoute} />
    </AuthenticationProvider>
  </StrictMode>,
);
