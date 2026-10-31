import { MutationCache, QueryClient } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import { getErrorMessage } from "./utils";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status && status >= 400 && status < 500) return false;
        return count < 2;
      },
    },
  },
  // Every failed mutation surfaces as a toast unless it opts out with meta.silent.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.silent) return;
      toast.error(getErrorMessage(error));
    },
  }),
});
