import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setDefaultLevel } from "loglevel";

import { isConsoleBuild, logLevel } from "@utils/clientConfig";
import { captureInstallPrompt } from "@utils/installPrompt";
import { registerAppShell } from "@utils/appShellUpdate";

import { getRouter } from "./router";

setDefaultLevel(logLevel());

if (!isConsoleBuild()) captureInstallPrompt(window);

// The root route renders the whole document, `<html>` included, so the React
// root is the document itself rather than an element inside it.
createRoot(document).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);

// Registration waits for `load` so the precache does not compete with the first
// render's requests; a dev server is excluded because a worker in front of it
// serves the last document it saw.
if (!isConsoleBuild() && !import.meta.env.DEV && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerAppShell(navigator.serviceWorker);
  });
}
