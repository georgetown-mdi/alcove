/**
 * Who can open an invitation link, judged from the host of the address it was
 * created on. A link carries this page's origin, so an invitation created on a
 * development server or a console bound to loopback sends a remote partner to
 * their own machine. No React.
 */

/** Where an invitation link can be opened: `thisComputer` for a loopback host,
 * `localNetwork` for a private-range, link-local or unqualified host, and
 * `anywhere` otherwise. */
export type InvitationReach = "thisComputer" | "localNetwork" | "anywhere";

/** Classify the host of `link`, an absolute URL. A link that does not parse is
 * treated as reachable from anywhere, since nothing can be said about it. */
export function invitationReach(link: string): InvitationReach {
  let hostname: string;
  try {
    hostname = new URL(link).hostname.replace(/\.$/, "");
  } catch {
    return "anywhere";
  }
  if (hostname.startsWith("[") && hostname.endsWith("]"))
    return ipv6Reach(hostname.slice(1, -1));
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) return ipv4Reach(ipv4);
  if (hostname === "localhost" || hostname.endsWith(".localhost"))
    return "thisComputer";
  if (
    !hostname.includes(".") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home.arpa")
  )
    return "localNetwork";
  return "anywhere";
}

function parseIpv4(hostname: string): Array<number> | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part)))
    return undefined;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function ipv4Reach([a, b]: Array<number>): InvitationReach {
  if (a === 127 || a === 0) return "thisComputer";
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
    return "localNetwork";
  return "anywhere";
}

// The URL parser has already compressed the address, so `::1` and `::` are the
// only spellings of loopback and unspecified, and an IPv4-mapped address reads
// as `::ffff:` followed by two hex groups.
function ipv6Reach(address: string): InvitationReach {
  if (address === "::1" || address === "::") return "thisComputer";
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped !== null) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return ipv4Reach([high >> 8, high & 255, low >> 8, low & 255]);
  }
  if (
    /^f[cd][0-9a-f]{0,2}:/.test(address) ||
    /^fe[89ab][0-9a-f]?:/.test(address)
  )
    return "localNetwork";
  return "anywhere";
}
