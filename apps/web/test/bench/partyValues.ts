/**
 * One bench party's values: the first `overlap` are the ones both parties
 * hold, so the expected match is known. Imported by the Node benches and
 * bundled into their pages alike, so it imports nothing.
 */
export function partyValues(
  elements: number,
  overlap: number,
  prefix: string,
): Array<string> {
  return Array.from({ length: elements }, (_, index) =>
    index < overlap ? `shared-${index}` : `${prefix}-${index}`,
  );
}
