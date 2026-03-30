"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEventSource } from "@/lib/use-event-source";
import { ThemeProvider } from "@/lib/theme";
import { useState, type ReactNode } from "react";
import { Toaster, toast } from "sonner";

function EventSourceConnector() {
  useEventSource();
  return null;
}

/** Deduplicate error toasts — only show once per query key within 30s. */
const recentErrors = new Map<string, number>();
const DEDUP_MS = 30_000;

function showQueryError(queryKey: string, error: unknown) {
  const now = Date.now();
  const last = recentErrors.get(queryKey);
  if (last && now - last < DEDUP_MS) return;
  recentErrors.set(queryKey, now);

  const msg = error instanceof Error ? error.message : String(error);
  toast.error(`${queryKey}: ${msg}`);
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error, query) => {
            const key = Array.isArray(query.queryKey)
              ? query.queryKey.join("/")
              : String(query.queryKey);
            showQueryError(key, error);
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchInterval: 10_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary)",
              fontSize: "12px",
            },
          }}
        />
        <EventSourceConnector />
        {children}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
