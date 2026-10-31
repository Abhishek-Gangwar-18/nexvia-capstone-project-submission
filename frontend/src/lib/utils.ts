import axios from "axios";
import { clsx, type ClassValue } from "clsx";
import { format, formatDistanceToNowStrict, isPast, isToday, parseISO } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

function humanize(field: string) {
  return field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function firstMessage(value: unknown): string {
  if (Array.isArray(value)) return firstMessage(value[0]);
  if (value && typeof value === "object") return firstMessage(Object.values(value)[0]);
  return String(value ?? "");
}

/** Turn any API/network error into one human sentence. */
export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return "Can't reach the server. Is the backend running?";
    const data = error.response.data as unknown;
    if (error.response.status >= 500) return "The server hit an error. Please try again.";
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      if ("detail" in record) return firstMessage(record.detail);
      const [field, value] = Object.entries(record)[0] ?? [];
      if (field) {
        const message = firstMessage(value);
        return field === "non_field_errors" ? message : `${humanize(field)}: ${message}`;
      }
    }
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Field -> first error message, for inline form errors. */
export function getFieldErrors(error: unknown): Record<string, string> {
  if (!axios.isAxiosError(error) || !error.response?.data || typeof error.response.data !== "object") return {};
  return Object.fromEntries(
    Object.entries(error.response.data as Record<string, unknown>).map(([k, v]) => [k, firstMessage(v)]),
  );
}

export function formatDate(value: string | null | undefined, pattern = "MMM d, yyyy") {
  if (!value) return "";
  return format(parseISO(value), pattern);
}

export function timeAgo(value: string | null | undefined) {
  if (!value) return "";
  return `${formatDistanceToNowStrict(parseISO(value))} ago`;
}

export function isOverdue(dueDate: string | null, done: boolean) {
  if (!dueDate || done) return false;
  const date = parseISO(dueDate);
  return isPast(date) && !isToday(date);
}

export const RANK_STEP = 1024;

/** Mirror of the backend's rank_between: the rank that slots between two neighbours. */
export function rankBetween(prev?: number, next?: number): number | null {
  if (prev === undefined && next === undefined) return null;
  if (prev === undefined) return next! - RANK_STEP;
  if (next === undefined) return prev + RANK_STEP;
  return (prev + next) / 2;
}

export function pluralize(count: number, word: string, plural = `${word}s`) {
  return `${count} ${count === 1 ? word : plural}`;
}

export function percent(part: number, total: number) {
  return total ? Math.round((part / total) * 100) : 0;
}
