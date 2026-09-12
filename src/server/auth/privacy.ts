export const googleIdentityScope = "openid email";

export function createPrivateGoogleUser(
  profile: Record<string, unknown> & { sub?: unknown },
) {
  if (typeof profile.sub !== "string" || profile.sub.length === 0) {
    throw new TypeError("Google did not return an account identifier.");
  }

  return {
    id: profile.sub,
    name: null,
    email: null,
    image: null,
  };
}

export function omitGoogleTokens(_tokens: unknown) {
  return {};
}
