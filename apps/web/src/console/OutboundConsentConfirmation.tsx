import {
  Alert,
  Button,
  Group,
  List,
  Stack,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { ColumnName } from "@components/ColumnName";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import {
  CHANGE_OUTBOUND_COLUMNS_LABEL,
  CONFIRM_OUTBOUND_COLUMNS_LABEL,
  NO_OUTBOUND_COLUMNS,
  OUTBOUND_COLUMNS_ADDED_LABEL,
  OUTBOUND_COLUMNS_LABEL,
  OUTBOUND_COLUMNS_REMOVED_LABEL,
  OUTBOUND_CONSENT_CONFIRMED_TITLE,
  OUTBOUND_CONSENT_TITLE,
} from "./mountedConfiguration";

import type { OutboundConsentView } from "./mountedConfiguration";

/**
 * The review step's confirmation of the columns this party sends, for an opened
 * configuration whose `outbound_payload_consent` is pending. What it shows and
 * what confirming records are decided by {@link outboundConsentView}; this holds
 * the rendering and the live region, which announces the confirmed title once
 * the confirm control that had focus is gone.
 */

/** One labelled list of the operator's own column names, one name per line so
 * a name holding a list separator cannot read as two. */
function ColumnList({
  label,
  names,
}: {
  label: string;
  names: ReadonlyArray<string>;
}) {
  return (
    <div>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <List size="sm" withPadding listStyleType="circle" my={4}>
        {names.map((column) => (
          <List.Item key={column}>
            <ColumnName name={column} />
          </List.Item>
        ))}
      </List>
    </div>
  );
}

/** The confirmation, or nothing where the view offers none. */
export function OutboundConsentConfirmation({
  view,
  onConfirm,
  onChangeColumns,
}: {
  view: OutboundConsentView | undefined;
  /** Confirm the columns the view lists, passed back as shown. */
  onConfirm: (columns: ReadonlyArray<string>) => void;
  /** Return to the columns step to change what is sent. */
  onChangeColumns: () => void;
}) {
  const announcement = useDeferredAnnouncement(
    view?.kind === "confirmed" ? OUTBOUND_CONSENT_CONFIRMED_TITLE : "",
  );
  const region = (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </VisuallyHidden>
  );
  if (view === undefined) return region;
  if (view.kind === "confirmed")
    return (
      <>
        {region}
        <Alert
          color="blue"
          role="presentation"
          title={OUTBOUND_CONSENT_CONFIRMED_TITLE}
        >
          <Text size="sm">{view.statement}</Text>
        </Alert>
      </>
    );
  const { verdict } = view;
  return (
    <>
      {region}
      <Alert
        color="yellow"
        role="presentation"
        icon={<IconAlertTriangle aria-hidden />}
        title={OUTBOUND_CONSENT_TITLE}
      >
        <Stack gap="xs">
          <Text size="sm">{view.reason}</Text>
          {verdict.columns.length === 0 ? (
            <Text size="sm">
              {OUTBOUND_COLUMNS_LABEL}: {NO_OUTBOUND_COLUMNS}
            </Text>
          ) : (
            <ColumnList
              label={OUTBOUND_COLUMNS_LABEL}
              names={verdict.columns}
            />
          )}
          {verdict.added.length > 0 && (
            <ColumnList
              label={OUTBOUND_COLUMNS_ADDED_LABEL}
              names={verdict.added}
            />
          )}
          {verdict.removed.length > 0 && (
            <ColumnList
              label={OUTBOUND_COLUMNS_REMOVED_LABEL}
              names={verdict.removed}
            />
          )}
          <Text size="sm">{view.effect}</Text>
          <Group gap="xs">
            <Button size="xs" onClick={() => onConfirm(verdict.columns)}>
              {CONFIRM_OUTBOUND_COLUMNS_LABEL}
            </Button>
            <Button size="xs" variant="default" onClick={onChangeColumns}>
              {CHANGE_OUTBOUND_COLUMNS_LABEL}
            </Button>
          </Group>
        </Stack>
      </Alert>
    </>
  );
}
