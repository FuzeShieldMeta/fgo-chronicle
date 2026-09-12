import { describe, expect, it } from "vitest";

import {
  createPrivateGoogleUser,
  googleIdentityScope,
  omitGoogleTokens,
} from "~/server/auth/privacy";

describe("Google identity data", () => {
  it("requests identity and email without the profile scope", () => {
    expect(googleIdentityScope.split(" ")).toEqual(["openid", "email"]);
  });

  it("keeps only the stable Google account identifier", () => {
    expect(
      createPrivateGoogleUser({
        sub: "google-account-123",
        email: "master@example.com",
        name: "Chaldea Master",
        picture: "https://example.com/avatar.png",
      }),
    ).toEqual({
      id: "google-account-123",
      name: null,
      email: null,
      image: null,
    });
  });

  it("rejects a Google response without an account identifier", () => {
    expect(() => createPrivateGoogleUser({})).toThrow(
      "Google did not return an account identifier.",
    );
  });

  it("does not retain OAuth tokens or granted scopes", () => {
    expect(
      omitGoogleTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        scope: "openid email",
      }),
    ).toEqual({});
  });
});
