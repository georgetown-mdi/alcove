import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setDefaultLevel } from "loglevel";

import { logLevel } from "@utils/clientConfig";

import { getRouter } from "./router";

setDefaultLevel(logLevel());

// The root route renders the whole document, `<html>` included, so the React
// root is the document itself rather than an element inside it.
createRoot(document).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);
