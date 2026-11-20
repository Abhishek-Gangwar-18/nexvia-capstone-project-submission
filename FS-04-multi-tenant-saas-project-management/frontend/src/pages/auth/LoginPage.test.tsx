import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/store/auth";
import LoginPage, { safeNext } from "./LoginPage";

const loginMock = vi.fn();
vi.mock("@/hooks/queries", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return { useLogin: () => useMutation({ mutationFn: (vars: unknown) => loginMock(vars) }) };
});

function renderLogin(path = "/login") {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<p>landed</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("safeNext (open-redirect guard)", () => {
  it.each([
    [null, "/"],
    ["https://evil.com", "/"],
    ["//evil.com", "/"],
    ["/login?x=1", "/"],
    ["/register", "/"],
    ["/projects/1/board", "/projects/1/board"],
  ])("%s -> %s", (input, expected) => expect(safeNext(input)).toBe(expected));
});

describe("LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset();
    useAuth.getState().clear();
  });

  it("submits credentials and redirects on success", async () => {
    loginMock.mockResolvedValue({});
    renderLogin("/login?next=/projects");
    await userEvent.type(screen.getByLabelText("Email"), "me@x.com");
    await userEvent.type(screen.getByLabelText("Password"), "secret123");
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => expect(screen.getByText("landed")).toBeInTheDocument());
    expect(loginMock).toHaveBeenCalledWith({ email: "me@x.com", password: "secret123" });
  });

  it("shows the error message when login fails", async () => {
    loginMock.mockRejectedValue(new Error("Invalid email or password."));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "me@x.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("skips the form when already signed in", () => {
    useAuth.setState({ access: "token" });
    renderLogin();
    expect(screen.getByText("landed")).toBeInTheDocument();
  });
});
