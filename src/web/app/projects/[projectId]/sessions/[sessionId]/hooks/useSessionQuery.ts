import { useSuspenseQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useSessionPage } from "@/lib/atoms/sessionPage";
import type { Conversation } from "@/lib/conversation-schema";
import { sseAtom } from "@/lib/sse/store/sseAtom";
import { createVirtualUserEntry } from "@/lib/virtual-messages/createVirtualUserEntry";
import { shouldRemoveVirtualMessage } from "@/lib/virtual-messages/shouldRemoveVirtualMessage";
import {
  getVirtualMessage,
  removeVirtualMessage,
} from "@/lib/virtual-messages/virtualMessageStore";
import { sessionDetailQuery } from "@/web/lib/api/queries";

export const PAGE_SIZE = 200;

const filterConversations = (
  conversations: ReadonlyArray<
    Conversation | { type: "x-error"; line: string; lineNumber: number }
  >,
): Conversation[] => conversations.filter((c): c is Conversation => c.type !== "x-error");

export const useSessionQuery = (projectId: string, sessionId: string) => {
  const { isConnected: isSSEConnected } = useAtomValue(sseAtom);
  const [page] = useSessionPage(sessionId);
  const offset = Math.max(0, (page - 1) * PAGE_SIZE);
  const options = { limit: PAGE_SIZE, offset };

  const query = useSuspenseQuery({
    queryKey: sessionDetailQuery(projectId, sessionId, options).queryKey,
    queryFn: async () => {
      const result = await sessionDetailQuery(projectId, sessionId, options).queryFn();

      const virtualMessage = getVirtualMessage(sessionId);

      if (result.session === null) {
        if (virtualMessage) {
          const virtualEntry = createVirtualUserEntry(virtualMessage);
          return {
            session: {
              id: sessionId,
              jsonlFilePath: "",
              meta: {
                messageCount: 0,
                firstUserMessage: null,
                customTitle: null,
                cost: {
                  totalUsd: 0,
                  breakdown: {
                    inputTokensUsd: 0,
                    outputTokensUsd: 0,
                    cacheCreationUsd: 0,
                    cacheReadUsd: 0,
                  },
                  tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                  },
                },
                modelName: null,
                prLinks: [],
              },
              conversations: [virtualEntry],
              lastModifiedAt: virtualMessage.sentAt,
            },
            total: 1,
            hasMore: false,
          };
        }
        return result;
      }

      if (virtualMessage && page === 1) {
        if (
          shouldRemoveVirtualMessage(
            filterConversations(result.session.conversations),
            virtualMessage.sentAt,
            virtualMessage.conversationCount,
          )
        ) {
          if (!virtualMessage.isNewSession) {
            removeVirtualMessage(sessionId);
          }
        } else {
          const virtualEntry = createVirtualUserEntry(virtualMessage);
          return {
            ...result,
            session: {
              ...result.session,
              conversations: [...result.session.conversations, virtualEntry],
            },
          };
        }
      }

      return result;
    },
    refetchInterval: isSSEConnected ? false : 30_000,
    refetchIntervalInBackground: false,
  });

  return query;
};
