'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

const API_BASE =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3000`
    : 'http://api-gateway:3000';

export function useEventSource() {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const wasConnected = useRef(false);

  const connect = useCallback(() => {
    if (esRef.current) return;

    const es = new EventSource(`${API_BASE}/api/v1/dashboard/stream`);
    esRef.current = es;

    es.onopen = () => {
      if (wasConnected.current) {
        toast.success('Stream reconnected');
      }
      wasConnected.current = true;
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Update query cache with streamed data
        if (data.snapshot) {
          queryClient.setQueryData(['marketSnapshot'], data.snapshot);
        }
        if (data.pipeline) {
          queryClient.setQueryData(['pipeline'], data.pipeline);
        }
        if (data.health) {
          queryClient.setQueryData(['serviceHealth'], data.health);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (wasConnected.current) {
        toast.error('Stream disconnected — reconnecting…');
      }
      // Reconnect after 5 seconds
      setTimeout(connect, 5000);
    };
  }, [queryClient]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);
}
