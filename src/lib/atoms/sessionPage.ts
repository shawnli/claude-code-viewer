import { atom, useAtom } from "jotai";
import { useCallback } from "react";

const sessionPageStoreAtom = atom<Record<string, number>>({});

export const useSessionPage = (sessionId: string) => {
  const [store, setStore] = useAtom(sessionPageStoreAtom);
  const page = store[sessionId] ?? 1;
  const setPage = useCallback(
    (next: number) => {
      setStore((prev) => ({ ...prev, [sessionId]: Math.max(1, next) }));
    },
    [sessionId, setStore],
  );
  return [page, setPage] as const;
};
