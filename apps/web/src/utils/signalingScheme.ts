/** Why a signaling server setting whose scheme differs from the page's is
 * refused: an invitation endpoint names no scheme, so the acceptor dials with
 * its own page's. */
export const SIGNALING_SCHEME_MISMATCH =
  "the coordination server's scheme must match the page's (wss: for a page " +
  "served over https, ws: for a page served over http); set it to match and " +
  "rebuild the app";

/** Whether `setting` uses the scheme a page served with `pageProtocol` must
 * use: wss under https, ws otherwise. */
export function signalingSchemeMatchesPage(
  setting: { secure: boolean },
  pageProtocol: string,
): boolean {
  return setting.secure === (pageProtocol === "https:");
}
