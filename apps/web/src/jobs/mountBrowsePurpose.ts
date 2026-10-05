/**
 * The `purpose` query value of a secrets-mount listing asked for while the
 * signing identity location is picked. A listing without it is a credential
 * browse, which leaves the console's own top-level names out; this one keeps
 * them, since an identity file is what that browse is for. Browser-safe: the
 * picker and the route both read it.
 */
export const SIGNING_IDENTITY_BROWSE_PURPOSE = "signing-identity";
