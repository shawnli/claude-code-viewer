import { useCallback, useMemo } from "react";
import { useSessionPage } from "@/lib/atoms/sessionPage";
import { PAGE_SIZE, useSessionQuery } from "./useSessionQuery";

export const useSession = (projectId: string, sessionId: string) => {
  const query = useSessionQuery(projectId, sessionId);
  const session = query.data?.session;
  if (session === undefined || session === null) {
    throw new Error("Session not found");
  }

  const total = query.data.total ?? session.conversations.length;
  const hasMore = query.data.hasMore ?? false;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [page, setPage] = useSessionPage(sessionId);

  const toolResultMap = useMemo(() => {
    const entries = session.conversations.flatMap((conversation) => {
      if (conversation.type !== "user") return [];
      if (typeof conversation.message.content === "string") return [];
      return conversation.message.content.flatMap((message) => {
        if (typeof message === "string") return [];
        if (message.type !== "tool_result") return [];
        return [[message.tool_use_id, message] as const];
      });
    });
    return new Map(entries);
  }, [session.conversations]);

  const getToolResult = useCallback(
    (toolUseId: string) => toolResultMap.get(toolUseId),
    [toolResultMap],
  );

  return {
    session,
    conversations: session.conversations,
    getToolResult,
    page,
    setPage,
    totalPages,
    total,
    hasMore,
    pageSize: PAGE_SIZE,
  };
};
