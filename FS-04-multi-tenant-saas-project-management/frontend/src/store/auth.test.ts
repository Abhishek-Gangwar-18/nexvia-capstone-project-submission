import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/types";
import { LEGACY_AUTH_KEY, useAuth } from "./auth";

const user = { id: 1, email: "a@b.com" } as unknown as Me;

describe("auth store (in memory only)", () => {
  beforeEach(() => useAuth.getState().clear());

  it("starts as restoring, not anonymous", async () => {
    vi.resetModules();
    const fresh = await import("./auth");
    expect(fresh.useAuth.getState()).toMatchObject({ status: "restoring", access: null, user: null });
  });

  it("signs in without persisting anything", () => {
    useAuth.getState().signIn({ access: "a1", user });
    expect(useAuth.getState()).toMatchObject({ access: "a1", user, status: "authenticated" });
    expect(JSON.stringify({ ...localStorage })).not.toContain("a1");
    expect(localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull();
  });

  it("updates the access token and clears on logout", () => {
    useAuth.getState().signIn({ access: "a1", user });
    useAuth.getState().setAccess("a2");
    expect(useAuth.getState().access).toBe("a2");
    useAuth.getState().clear();
    expect(useAuth.getState()).toMatchObject({ access: null, user: null, status: "anonymous" });
  });

  it("removes the legacy persisted tokens on load", async () => {
    localStorage.setItem(LEGACY_AUTH_KEY, JSON.stringify({ state: { access: "old", refresh: "old-refresh" } }));
    vi.resetModules();
    await import("./auth");
    expect(localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain("old-refresh");
  });
});
