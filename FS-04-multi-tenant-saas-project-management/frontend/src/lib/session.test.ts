import axios, { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/store/auth";
import type { Me } from "@/types";
import { api } from "./api";
import { RateLimited, canAutoRefresh, logoutSession, refreshAccessToken, restoreSession, retryAfterSeconds } from "./session";

const user = { id: 1, email: "a@b.com" } as unknown as Me;

function httpError(status: number, config: object = { headers: new AxiosHeaders(), url: "/x" }, headers: object = {}) {
  return new AxiosError("fail", String(status), config as never, null, { status, data: {}, statusText: "", headers, config } as never);
}
const tooMany = (retryAfter = "12") => httpError(429, undefined, { "retry-after": retryAfter });
/** Adapter answer: a 401 carrying the real request config (as axios does), so the interceptor can retry it. */
const reject401 = (config: object) => Promise.reject(httpError(401, config));

/** A Web Locks stand-in that really serialises callbacks, like the browser's. */
function installLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const request = vi.fn((_name: string, cb: () => Promise<unknown>) => {
    const result = tail.then(cb);
    tail = result.catch(() => undefined);
    return result;
  });
  Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });
  return request;
}

describe("session", () => {
  beforeEach(() => {
    useAuth.setState({ status: "restoring", access: null, user: null });
    installLocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
  });

  it("refreshes through the cookie with the browser-mode header and keeps the token in memory", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "new" } });
    await expect(refreshAccessToken()).resolves.toBe("new");
    expect(post).toHaveBeenCalledWith("/api/auth/refresh/", {}, { headers: { "X-Auth-Mode": "cookie" } });
    expect(useAuth.getState().access).toBe("new");
  });

  it("single-flights concurrent refreshes in a tab", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "new" } });
    await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("serialises refreshes through Web Locks and re-checks after getting the lock", async () => {
    const request = installLocks();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Another tab holds the lock while it rotates the cookie.
    const otherTab = navigator.locks.request("flowboard-refresh", () => gate);
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "mine" } });
    const mine = refreshAccessToken();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled(); // waiting for the lock, not racing the other tab
    release();
    await otherTab;
    await expect(mine).resolves.toBe("mine");
    expect(request).toHaveBeenCalledWith("flowboard-refresh", expect.any(Function));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("restores a session: access token, then the user", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "a1" } });
    const get = vi.spyOn(axios, "get").mockResolvedValue({ data: user });
    await restoreSession();
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", access: "a1", user });
    expect(get).toHaveBeenCalledWith("/api/auth/me/", { headers: { "X-Auth-Mode": "cookie", Authorization: "Bearer a1" } });
  });

  it("an ended session (401) goes to anonymous", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(httpError(401));
    await restoreSession();
    expect(useAuth.getState().status).toBe("anonymous");
  });

  it("a network failure during restore keeps the session for a retry", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new AxiosError("Network Error", "ERR_NETWORK"));
    await restoreSession();
    expect(useAuth.getState().status).toBe("error"); // not anonymous: the cookie may still be valid
  });

  it("does not start a second restore while one is running", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "a1" } });
    vi.spyOn(axios, "get").mockResolvedValue({ data: user });
    await Promise.all([restoreSession(), restoreSession()]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a 429 during restore keeps the session and remembers Retry-After (not logged out)", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(tooMany("12"));
    await restoreSession();
    expect(useAuth.getState()).toMatchObject({ status: "rate_limited", retryAfter: 12 });
  });

  it("retrying after the limit resets restores the session", async () => {
    const post = vi.spyOn(axios, "post").mockRejectedValueOnce(tooMany("1")).mockResolvedValueOnce({ data: { access: "a2" } });
    vi.spyOn(axios, "get").mockResolvedValue({ data: user });
    await restoreSession();
    expect(useAuth.getState().status).toBe("rate_limited");
    await restoreSession();
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", access: "a2", retryAfter: null });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("a 429 inside the cross-tab lock releases it, so the next tab's refresh still runs", async () => {
    const request = installLocks();
    const post = vi.spyOn(axios, "post").mockRejectedValueOnce(tooMany()).mockResolvedValueOnce({ data: { access: "next" } });
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(RateLimited);
    await expect(refreshAccessToken()).resolves.toBe("next"); // e.g. another tab, after the wait
    expect(request).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([["12", 12], ["0", 30], ["", 30], ["abc", 30], ["99999", 3600]])("Retry-After %j -> %i s", (header, seconds) => {
    expect(retryAfterSeconds(header)).toBe(seconds);
  });

  it("disables automatic refresh without Web Locks", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    expect(canAutoRefresh()).toBe(false);
    useAuth.getState().signIn({ access: "old", user });
    const refresh = vi.spyOn(axios, "post");
    const adapter = vi.fn().mockRejectedValue(httpError(401));
    await expect(api.get("/workspaces/", { adapter })).rejects.toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(useAuth.getState().status).toBe("anonymous"); // asked to log in again
  });
});

describe("api client", () => {
  beforeEach(() => {
    useAuth.getState().signIn({ access: "old", user });
    installLocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the browser-mode header on every request", async () => {
    const adapter = vi.fn().mockResolvedValue({ data: {}, status: 200, statusText: "", headers: {}, config: {} });
    await api.get("/workspaces/", { adapter });
    const sent = adapter.mock.calls[0][0];
    expect(sent.headers["X-Auth-Mode"]).toBe("cookie");
    expect(sent.headers.Authorization).toBe("Bearer old");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ data: { access: "new" } });
    const adapter = vi.fn()
      .mockImplementationOnce(reject401)
      .mockResolvedValueOnce({ data: { ok: true }, status: 200, statusText: "", headers: {}, config: {} });
    const res = await api.get("/workspaces/", { adapter });
    expect(res.data).toEqual({ ok: true });
    expect(adapter.mock.calls[1][0].headers.Authorization).toBe("Bearer new");
  });

  it("an expired session on refresh logs out", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(httpError(401));
    const adapter = vi.fn().mockRejectedValue(httpError(401));
    await expect(api.get("/workspaces/", { adapter })).rejects.toBeTruthy();
    expect(useAuth.getState().status).toBe("anonymous");
  });

  it("a 429 on refresh keeps the session (rate limited is not logged out)", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(tooMany());
    const adapter = vi.fn().mockRejectedValue(httpError(401));
    await expect(api.get("/workspaces/", { adapter })).rejects.toBeTruthy(); // that request fails…
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", access: "old" }); // …but nobody is logged out
  });

    it("a network error during refresh keeps the session", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new AxiosError("Network Error", "ERR_NETWORK"));
    const adapter = vi.fn().mockRejectedValue(httpError(401));
    await expect(api.get("/workspaces/", { adapter })).rejects.toBeTruthy();
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", access: "old" });
  });
});

describe("logout", () => {
  beforeEach(() => useAuth.getState().signIn({ access: "a1", user }));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["offline", () => new AxiosError("Network Error", "ERR_NETWORK")],
    ["server error", () => httpError(502)],
  ])("a failed logout (%s) keeps the user signed in and tells no other tab", async (_label, failure) => {
    vi.spyOn(axios, "post").mockRejectedValue(failure());
    const broadcast = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const beforeClear = vi.fn();
    await expect(logoutSession(beforeClear)).resolves.toBe(false);
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", access: "a1", user });
    expect(broadcast).not.toHaveBeenCalled();
    expect(beforeClear).not.toHaveBeenCalled(); // the user stays on the page
  });

  it("an unexpected success status isn't treated as a logout", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ status: 200, data: {} });
    await expect(logoutSession()).resolves.toBe(false);
    expect(useAuth.getState().status).toBe("authenticated");
  });

  it("a confirmed 204 clears this tab, then tells the others (no tokens in the message)", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ status: 204, data: "" });
    const broadcast = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const order: string[] = [];
    const beforeClear = vi.fn(() => {
      order.push(`navigate while ${useAuth.getState().status}`);
    });
    await expect(logoutSession(beforeClear)).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith("/api/auth/logout/", {}, { headers: { "X-Auth-Mode": "cookie" } });
    expect(order).toEqual(["navigate while authenticated"]); // leaves the page before the state clears
    expect(useAuth.getState()).toMatchObject({ status: "anonymous", access: null, user: null });
    expect(broadcast).toHaveBeenCalledWith({ type: "logout" });
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("a1");
  });
});
