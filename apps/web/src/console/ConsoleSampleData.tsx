import { useState } from "react";

import { Anchor, Text } from "@mantine/core";

import { addSampleInputs } from "@psi/jobClient/workInputClient";

import {
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";
import styles from "@styles/app.module.css";

import type { AddSampleInputsResult } from "@psi/jobClient/workInputClient";

/** What the console says once the sample files are in the folder. */
export const SAMPLE_FILES_ADDED =
  `${SAMPLE_INVITER_FILE_NAME} and ${SAMPLE_PARTNER_FILE_NAME} are in your ` +
  `folder. Choose ${SAMPLE_INVITER_FILE_NAME} above; the partner file is ` +
  "for the other side of the practice exchange.";

/** What the console says when it could not write the sample files, by
 * outcome; undefined for a write that went through. */
export function sampleInputsFailure(
  result: AddSampleInputsResult,
): string | undefined {
  switch (result.kind) {
    case "added":
      return undefined;
    case "unwritable":
      return (
        "The console could not write the sample files into your folder, " +
        "which may be mounted read-only. Download them instead and copy one " +
        "into your folder."
      );
    case "disabled":
      return (
        "This console was started without a folder, so it has nowhere to " +
        "write the sample files. Download them instead."
      );
    case "error":
      return (
        "The console did not answer. Try again, or download the sample " +
        "files instead."
      );
  }
}

/**
 * The console's sample-data line under the file picker: write the two sample
 * CSVs into the folder the picker lists, with the download kept as the
 * fallback for a folder the console cannot write into.
 */
export function ConsoleSampleData({
  onAdded,
  onDownloadSamples,
}: {
  /** The files are in the folder: the picker lists it again. */
  onAdded: () => void;
  onDownloadSamples: () => void;
}) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "adding" }
    | { status: "added" }
    | { status: "failed"; message: string }
  >({ status: "idle" });

  async function addSamples() {
    setState({ status: "adding" });
    const result = await addSampleInputs();
    const failure = sampleInputsFailure(result);
    if (failure !== undefined) {
      setState({ status: "failed", message: failure });
      return;
    }
    setState({ status: "added" });
    onAdded();
  }

  return (
    <>
      <p className={`${styles.small} ${styles.sub}`}>
        Use sample data:{" "}
        <Anchor
          inherit
          component="button"
          type="button"
          disabled={state.status === "adding"}
          onClick={() => void addSamples()}
        >
          Add sample files to my folder
        </Anchor>
        , or{" "}
        <Anchor
          inherit
          component="button"
          type="button"
          onClick={onDownloadSamples}
        >
          download the CSVs
        </Anchor>
        .
      </p>
      <div role="status" aria-live="polite">
        {state.status === "added" && (
          <Text size="sm">{SAMPLE_FILES_ADDED}</Text>
        )}
        {state.status === "failed" && (
          <Text size="sm" c="red">
            {state.message}
          </Text>
        )}
      </div>
    </>
  );
}
