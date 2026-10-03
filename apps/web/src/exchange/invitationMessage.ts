import { dateTimeLabel } from "@psi/formatting";

/**
 * The message an inviter copies to send a browser partner: what the invitation
 * is for, the link, when it stops working and that the inviter's page has to
 * stay open meanwhile, and, where the partner can reach this site, where to
 * practice with sample data first. No React.
 */
export function invitationMessage({
  inviterName,
  deepLink,
  expires,
  practiceOrigin,
}: {
  /** The name the inviter gave; the message is signed with it when set. */
  inviterName: string;
  deepLink: string;
  /** The invitation's expiry, ISO 8601. */
  expires: string;
  /** The site to point the partner at for a sample-data practice run, or
   * undefined where the partner cannot reach it. */
  practiceOrigin: string | undefined;
}): string {
  const paragraphs = [
    "Hello,",
    "I am inviting you to link our records with Alcove. Alcove finds the " +
      "records we both hold without either of us seeing the other's data.",
    `Open this link to review the terms and accept:\n${deepLink}`,
    `The link works until ${dateTimeLabel(new Date(expires))}. It contains ` +
      "a one-time secret, so please do not forward it. My Alcove page needs " +
      "to stay open while you accept, so let me know when you plan to open it.",
  ];
  if (practiceOrigin !== undefined)
    paragraphs.push(
      "To try Alcove with sample data first, open " +
        `${practiceOrigin}/quick and choose "Start with sample data".`,
    );
  const name = inviterName.trim();
  if (name !== "") paragraphs.push(name);
  return paragraphs.join("\n\n");
}
