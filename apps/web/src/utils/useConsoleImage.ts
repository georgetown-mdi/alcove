import { useEffect, useState } from "react";

import {
  UNREPORTED_CONSOLE_IMAGE,
  fetchConsoleImage,
} from "@psi/jobClient/consoleImageClient";

import { isConsoleBuild } from "./clientConfig";

import type { ConsoleImage } from "@jobContract/consoleImage";

/**
 * The image the console runs, fetched once per mount on a console build; any
 * other build has no job API to ask and names {@link UNREPORTED_CONSOLE_IMAGE}.
 * Undefined while the fetch is in flight.
 */
export function useConsoleImage(): ConsoleImage | undefined {
  const [image, setImage] = useState<ConsoleImage | undefined>(
    isConsoleBuild() ? undefined : UNREPORTED_CONSOLE_IMAGE,
  );
  useEffect(() => {
    if (!isConsoleBuild()) return;
    let cancelled = false;
    void fetchConsoleImage().then((reported) => {
      if (!cancelled) setImage(reported);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return image;
}
