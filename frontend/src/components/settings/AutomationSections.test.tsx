import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookDelivery, WebhookEndpoint } from "@/types";
import { WebhooksSection } from "./AutomationSections";

// Real query hooks and component; only the HTTP layer is a small in-memory fake of the webhook API.
const server = vi.hoisted(() => ({
  endpoints: [] as WebhookEndpoint[],
  deliveries: [] as WebhookDelivery[],
  deliveryGets: 0,
  redeliverFails: false,
  posts: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/webhooks/") return { data: server.endpoints };
      if (/\/webhooks\/\d+\/deliveries\/$/.test(url)) {
        server.deliveryGets += 1;
        return { data: server.deliveries };
      }
      throw new Error(`unexpected GET ${url}`);
    }),
    post: vi.fn(async (url: string) => {
      server.posts.push(url);
      if (url.endsWith("/redeliver/")) {
        if (server.redeliverFails) {
          throw Object.assign(new Error("400"), {
            isAxiosError: true,
            response: { status: 400, data: { detail: "This endpoint is disabled." } },
          });
        }
        const copy = { ...server.deliveries[0], id: 99, state: "pending" as const, attempts: 0 };
        server.deliveries = [copy, ...server.deliveries];
        return { data: copy };
      }
      if (url.endsWith("/test/")) {
        const d = delivery({ id: 50, state: "pending", event: "webhook.test" });
        server.deliveries = [d, ...server.deliveries];
        return { data: d };
      }
      throw new Error(`unexpected POST ${url}`);
    }),
  },
}));

const permissions = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/hooks/useWorkspace", () => ({
  useWorkspaceSlug: () => "acme",
  usePermissions: () => ({ isAdmin: permissions.isAdmin, canEdit: true, isOwner: permissions.isAdmin }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

function endpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 7, name: "CI hook", url: "https://hooks.example.com/ci", secret_hint: "••••a1b2", events: ["issue.created"],
    is_active: true, consecutive_failures: 0, disabled_at: null, disabled_reason: "", created_at: "", updated_at: "",
    ...overrides,
  } as WebhookEndpoint;
}
function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 1, event: "issue.created", state: "failed", attempts: 6, response_status: null,
    last_error: "Could not resolve the webhook host", created_at: "", updated_at: "", ...overrides,
  } as WebhookDelivery;
}

async function openDeliveries() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WebhooksSection />
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: "View recent deliveries" }));
}

beforeEach(() => {
  Object.assign(server, { endpoints: [endpoint()], deliveries: [], deliveryGets: 0, redeliverFails: false, posts: [] });
  permissions.isAdmin = true;
  toasts.success.mockClear();
  toasts.error.mockClear();
});

describe("webhook deliveries", () => {
  it("polls while a delivery is in flight and stops once it is terminal", async () => {
    server.deliveries = [delivery({ state: "processing", attempts: 2 })];
    await openDeliveries();
    expect(await screen.findByText("processing")).toBeInTheDocument();
    server.deliveries = [delivery({ state: "delivered", attempts: 3, response_status: 200, last_error: "" })];
    expect(await screen.findByText("delivered", {}, { timeout: 6000 })).toBeInTheDocument(); // no reload needed
    const gets = server.deliveryGets;
    await new Promise((r) => setTimeout(r, 3000));
    expect(server.deliveryGets).toBe(gets); // terminal: polling stopped
  }, 15_000);

  it("a failed delivery offers Redeliver; success queues it and the new attempt appears", async () => {
    server.deliveries = [delivery()];
    await openDeliveries();
    await userEvent.click(await screen.findByRole("button", { name: "Redeliver issue.created" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Redelivery queued"));
    expect(server.posts).toContain("/webhooks/7/deliveries/1/redeliver/"); // the existing API
    expect(await screen.findByText("pending")).toBeInTheDocument(); // refreshed after the retry
  });

  it("a refused redelivery shows the server's reason", async () => {
    server.deliveries = [delivery()];
    server.redeliverFails = true;
    await openDeliveries();
    await userEvent.click(await screen.findByRole("button", { name: "Redeliver issue.created" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("This endpoint is disabled."));
  });

  it("delivered and in-flight deliveries have no Redeliver button", async () => {
    server.deliveries = [delivery({ id: 2, state: "delivered", last_error: "" }), delivery({ id: 3, state: "pending" })];
    await openDeliveries();
    await screen.findByText("delivered");
    expect(screen.queryByRole("button", { name: /^Redeliver/ })).toBeNull();
  });

  it("a disabled endpoint can't redeliver or send tests", async () => {
    server.endpoints = [endpoint({ is_active: false, disabled_reason: "Disabled after 10 failed deliveries in a row." })];
    server.deliveries = [delivery()];
    await openDeliveries();
    expect(await screen.findByRole("button", { name: "Redeliver issue.created" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send test event" })).toBeDisabled();
    expect(screen.getByText(/Disabled after 10 failed deliveries/)).toBeInTheDocument();
  });

  it("sending a test opens the delivery list and follows the new delivery", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WebhooksSection />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Send test event" }));
    const row = await screen.findByText("webhook.test");
    expect(within(row.parentElement!).getByText("pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide deliveries" })).toBeInTheDocument();
  });

  it("non-admins see no webhook controls at all", async () => {
    permissions.isAdmin = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WebhooksSection />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Webhook settings are managed by workspace admins.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Redeliver|Send test event|View recent deliveries/ })).toBeNull();
  });
});
