import type { z } from "zod";
import type { ExtendedConversation } from "../../types/conversation.ts";
import type { projectMetaSchema } from "./project/schema.ts";
import type { sessionMetaSchema } from "./session/schema.ts";
export type { ErrorJsonl, ExtendedConversation } from "../../types/conversation.ts";

export type Project = {
  id: string;
  claudeProjectPath: string;
  lastModifiedAt: Date;
  meta: ProjectMeta;
  // Set when the row could not be built from a healthy read (malformed/transient
  // bad DB row). The entry is still returned so the project is not silently
  // dropped from the list; the UI renders it as an unavailable placeholder.
  unavailable?: boolean;
};

export type ProjectMeta = z.infer<typeof projectMetaSchema>;

export type Session = {
  id: string;
  jsonlFilePath: string;
  lastModifiedAt: Date;
  meta: SessionMeta;
  // Set when the row could not be built from a healthy read (malformed/transient
  // bad DB row). The entry is still returned so the session is not silently
  // dropped from the project detail page; the UI renders it as an unavailable
  // placeholder rather than crashing the whole page.
  unavailable?: boolean;
};

export type SessionMeta = z.infer<typeof sessionMetaSchema>;

export type SessionDetail = Session & {
  conversations: ExtendedConversation[];
};
