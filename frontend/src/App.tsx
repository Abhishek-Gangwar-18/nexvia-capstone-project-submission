import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "sonner";
import { queryClient } from "@/lib/queryClient";
import { router } from "@/router";
import { useResolvedTheme } from "@/store/ui";

export default function App() {
  const theme = useResolvedTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme={theme} richColors closeButton toastOptions={{ className: "font-sans" }} />
    </QueryClientProvider>
  );
}
