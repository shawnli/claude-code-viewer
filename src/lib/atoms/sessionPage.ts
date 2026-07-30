import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

// Page state persisted in the URL search param (?page=N).
export const useSessionPage = (_sessionId: string) => {
  const search = useSearch({ from: "/projects/$projectId/session" }) as {
    page?: number;
  };
  const navigate = useNavigate({ from: "/projects/$projectId/session" });
  const page = search.page ?? 1;
  const setPage = useCallback(
    (next: number) => {
      const clamped = Math.max(1, next);
      void navigate({
        search: (prev) => ({
          ...prev,
          page: clamped === 1 ? undefined : clamped,
        }),
        replace: false,
      });
    },
    [navigate],
  );
  return [page, setPage] as const;
};
