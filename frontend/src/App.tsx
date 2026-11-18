import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
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
