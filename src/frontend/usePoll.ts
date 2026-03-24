import { useState, useEffect, useCallback } from "react";
import { poll, type PollResponse } from "./api";

const POLL_INTERVAL = 4000;

export function usePoll(projectId?: string) {
  const [data, setData] = useState<PollResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    poll(projectId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { data, error, loading, refresh };
}
