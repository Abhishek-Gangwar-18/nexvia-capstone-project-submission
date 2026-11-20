import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/Button";
import { Logo, PageLoader } from "@/components/ui/Misc";
import { queryClient } from "@/lib/queryClient";
import { listenToOtherTabs, restoreSession } from "@/lib/session";
import { router } from "@/router";
import { useAuth } from "@/store/auth";
import { useResolvedTheme } from "@/store/ui";

/** Nothing renders until the session is restored from the refresh cookie (or known to be absent), so protected
 *  routes never flash a login redirect and auth pages never flash for a signed-in user. */
function SessionGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  useEffect(() => {
    void restoreSession();
  }, []);
  useEffect(() => listenToOtherTabs(() => queryClient.clear()), []);

  if (status === "restoring") return <PageLoader />;
  if (status === "rate_limited") return <RateLimitedScreen />;
  if (status === "error") {
    // Network or server trouble: the session may well still be valid, so don't log the user out.
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <Logo />
        <p className="max-w-sm text-sm text-slate-600 dark:text-slate-300">
          We couldn't reach FlowBoard to restore your session. Check your connection and try again.
        </p>
        <Button variant="primary" onClick={() => void restoreSession()}>
          Try again
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}

/** 429 while restoring: the session is fine, the server just asked us to slow down. Count down Retry-After, then
 *  retry by itself (the button works once the wait is over). Never logs the user out. */
function RateLimitedScreen() {
  const retryAfter = useAuth((s) => s.retryAfter) ?? 30;
  const [left, setLeft] = useState(retryAfter);
  useEffect(() => {
    setLeft(retryAfter);
    const timer = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [retryAfter]);
  useEffect(() => {
    if (left === 0) void restoreSession();
  }, [left]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      <p className="max-w-sm text-sm text-slate-600 dark:text-slate-300" role="status">
        Too many requests right now, so FlowBoard is pausing for a moment. You're still signed in.
        {left > 0 ? ` Trying again in ${left} second${left === 1 ? "" : "s"}.` : " Trying again…"}
      </p>
      <Button variant="primary" disabled={left > 0} onClick={() => void restoreSession()}>
        Try again
      </Button>
    </div>
  );
}

export default function App() {
  const theme = useResolvedTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate>
        <RouterProvider router={router} />
      </SessionGate>
      <Toaster position="bottom-right" theme={theme} richColors closeButton toastOptions={{ className: "font-sans" }} />
    </QueryClientProvider>
  );
}
