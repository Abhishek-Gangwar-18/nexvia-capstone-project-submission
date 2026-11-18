import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { getErrorMessage, getFieldErrors, isOverdue, isPlanLimit, percent, pluralize, rankBetween, RANK_STEP } from "./utils";

function axiosError(status: number | null, data?: unknown) {
  const config = { headers: new AxiosHeaders() };
  const response = status === null ? undefined : { status, data, statusText: "", headers: {}, config };
  return new AxiosError("fail", "ERR", config, null, response);
}

describe("rankBetween (Kanban drag ordering)", () => {
  it("returns null for an empty column", () => expect(rankBetween()).toBeNull());
  it("goes above the first card", () => expect(rankBetween(undefined, 2048)).toBe(2048 - RANK_STEP));
  it("goes below the last card", () => expect(rankBetween(1024)).toBe(1024 + RANK_STEP));
  it("slots between two neighbours", () => expect(rankBetween(1024, 2048)).toBe(1536));
});

describe("getErrorMessage", () => {
  it("handles a network failure", () =>
    expect(getErrorMessage(axiosError(null))).toMatch(/reach the server/i));
  it("hides server error details", () =>
    expect(getErrorMessage(axiosError(500, { detail: "trace" }))).toMatch(/server hit an error/i));
  it("uses the DRF detail field", () => expect(getErrorMessage(axiosError(403, { detail: "Nope." }))).toBe("Nope."));
  it("humanizes field errors", () =>
    expect(getErrorMessage(axiosError(400, { due_date: ["Invalid."] }))).toBe("Due date: Invalid."));
  it("drops the label for non_field_errors", () =>
    expect(getErrorMessage(axiosError(400, { non_field_errors: ["Bad combo."] }))).toBe("Bad combo."));
  it("falls back for unknown values", () => expect(getErrorMessage(42, "fallback")).toBe("fallback"));
});

describe("helpers", () => {
  it("detects plan limit errors (402)", () => {
    expect(isPlanLimit(axiosError(402))).toBe(true);
    expect(isPlanLimit(axiosError(400))).toBe(false);
  });
  it("maps field errors", () =>
    expect(getFieldErrors(axiosError(400, { email: ["Taken."], name: "Required." }))).toEqual({
      email: "Taken.",
      name: "Required.",
    }));
  it("pluralizes", () => {
    expect(pluralize(1, "issue")).toBe("1 issue");
    expect(pluralize(3, "issue")).toBe("3 issues");
  });
  it("computes percent safely", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBe(0);
  });
  it("flags overdue issues only when not done", () => {
    expect(isOverdue("2000-01-01", false)).toBe(true);
    expect(isOverdue("2000-01-01", true)).toBe(false);
    expect(isOverdue(null, false)).toBe(false);
    expect(isOverdue("2999-01-01", false)).toBe(false);
  });
});
