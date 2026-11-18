import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse, Me } from "@/types";
import { useAuth } from "./auth";

const user = { id: 1, email: "a@b.com" } as unknown as Me;
const session = { access: "a1", refresh: "r1", user } as unknown as AuthResponse;

describe("auth store", () => {
  beforeEach(() => useAuth.getState().clear());

  it("signs in and persists tokens", () => {
    useAuth.getState().signIn(session);
    expect(useAuth.getState()).toMatchObject({ access: "a1", refresh: "r1", user });
    expect(localStorage.getItem("flowboard-auth")).toContain("a1");
  });

  it("rotates tokens and clears on logout", () => {
    useAuth.getState().signIn(session);
    useAuth.getState().setTokens("a2", "r2");
    expect(useAuth.getState().access).toBe("a2");
    useAuth.getState().clear();
    expect(useAuth.getState()).toMatchObject({ access: null, refresh: null, user: null });
  });
});
