import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/store/auth";

// The router and the restore call are stubbed: this checks only what SessionGate shows for each restore outcome.
const restore = vi.fn(async () => {});
vi.mock("@/lib/session", () => ({ restoreSession: () => restore(), listenToOtherTabs: () => () => {} }));
vi.mock("@/router", () => ({ router: {} }));
vi.mock("react-router/dom", () => ({ RouterProvider: () => <p>app</p> }));

// jsdom has no matchMedia (used by the theme hook).
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});
const { default: App } = await import("./App");

describe("SessionGate messages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restore.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("429: says it's rate limited (not offline), keeps you signed in, counts down Retry-After and retries", async () => {
    render(<App />);
    act(() => useAuth.getState().setRateLimited(3));
    expect(screen.getByRole("status")).toHaveTextContent("Too many requests right now");
    expect(screen.getByRole("status")).toHaveTextContent("You're still signed in");
    expect(screen.getByRole("status")).toHaveTextContent("Trying again in 3 seconds");
    expect(screen.queryByText(/couldn't reach FlowBoard/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    const before = restore.mock.calls.length; // the mount-time restore
    await act(async () => vi.advanceTimersByTime(3000));
    expect(restore.mock.calls.length).toBe(before + 1); // retried by itself once the wait was over
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("network or server trouble: the connection message with a retry", () => {
    render(<App />);
    act(() => useAuth.getState().setStatus("error"));
    expect(screen.getByText(/couldn't reach FlowBoard/)).toBeInTheDocument();
  });

  it("401 (session ended): no error screen; the app (login) renders", () => {
    render(<App />);
    act(() => useAuth.getState().clear());
    expect(screen.getByText("app")).toBeInTheDocument();
  });
});
