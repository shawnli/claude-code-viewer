import { FileSystem } from "@effect/platform";
import { desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { DrizzleService } from "../../../lib/db/DrizzleService.ts";
import { projects, sessions } from "../../../lib/db/schema.ts";
import type { InferEffect } from "../../../lib/effect/types.ts";
import { parseJsonl } from "../../claude-code/functions/parseJsonl.ts";
import { ApplicationContext } from "../../platform/services/ApplicationContext.ts";
import { decodeProjectId, validateProjectPath } from "../../project/functions/id.ts";
import { SyncService } from "../../sync/services/SyncService.ts";
import type { Session, SessionDetail } from "../../types.ts";
import { decodeSessionId, validateSessionId } from "../functions/id.ts";
import { SessionMetaService } from "../services/SessionMetaService.ts";

const DEFAULT_PAGE_SIZE = 200;

const getSessionPageSize = (): number => {
  const envVal = process.env.SESSION_PAGE_SIZE;
  if (envVal !== undefined && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PAGE_SIZE;
};

/**
 * Count total lines in a file without reading the entire content into memory.
 * Reads the file in chunks and counts newline characters.
 */
const countFileLines = async (filePath: string): Promise<number> => {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    let lastChunk = "";
    stream.on("data", (chunk) => {
      lastChunk = chunk as string;
      for (const ch of chunk as string) if (ch === "\n") count++;
    });
    stream.on("end", () => {
      if (lastChunk.length > 0 && lastChunk[lastChunk.length - 1] !== "\n") count++;
      resolve(count);
    });
    stream.on("error", reject);
  });
};

/**
 * Read specific lines from a file using streaming.
 * offset=0 means the last `limit` lines; offset=50 means skip the last 50 and take `limit` before those.
 * Returns lines from oldest to newest within the page.
 */
const readLinesFromEnd = async (
  filePath: string,
  total: number,
  offset: number,
  limit: number,
): Promise<string[]> => {
  const { createReadStream } = await import("node:fs");
  const endLine = total - offset;
  const startLine = Math.max(0, endLine - limit);
  if (startLine >= endLine || startLine >= total) return [];
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let currentLine = 0;
    let buffer = "";
    let destroyed = false;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    stream.on("data", (chunk) => {
      if (destroyed) return;
      buffer += chunk as string;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (currentLine >= startLine && currentLine < endLine) {
          if (line.trim() !== "") lines.push(line);
        }
        currentLine++;
        if (currentLine >= endLine) {
          destroyed = true;
          stream.destroy();
          resolve(lines);
          return;
        }
      }
    });
    stream.on("end", () => {
      if (destroyed) return;
      if (buffer.trim() !== "" && currentLine >= startLine && currentLine < endLine) {
        lines.push(buffer);
      }
      resolve(lines);
    });
    stream.on("error", (err) => {
      if (!destroyed) reject(err);
    });
  });
};

const LayerImpl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sessionMetaService = yield* SessionMetaService;
  const appContext = yield* ApplicationContext;
  const { db } = yield* DrizzleService;
  const syncService = yield* SyncService;

  const getSession = (
    projectId: string,
    sessionId: string,
    options?: { offset?: number; limit?: number },
  ) =>
    Effect.gen(function* () {
      // Validate sessionId contains only safe characters
      if (!validateSessionId(sessionId)) {
        return yield* Effect.fail(new Error("Invalid session ID: contains unsafe characters"));
      }

      // Validate that the project path is within the Claude projects directory
      const projectPath = decodeProjectId(projectId);
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(projectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      const sessionPath = decodeSessionId(projectId, sessionId);

      // Check if session file exists
      const exists = yield* fs.exists(sessionPath);
      if (!exists) {
        return { session: null, total: 0, hasMore: false };
      }

      const sessionDetail = yield* Effect.gen(function* () {
        const pageSize = getSessionPageSize();
        const limit = options?.limit ?? pageSize;
        const offset = options?.offset ?? 0;

        // Count total lines to decide whether to paginate.
        const total = yield* Effect.promise(() => countFileLines(sessionPath));
        const shouldPaginate =
          options?.limit !== undefined ||
          options?.offset !== undefined ||
          total > pageSize;

        let conversations;
        let actualTotal: number;
        let hasMore: boolean;
        if (!shouldPaginate) {
          // Small session or unpaginated request: read whole file.
          const content = yield* fs.readFileString(sessionPath);
          const allLines = content.split("\n").filter((line) => line.trim());
          conversations = parseJsonl(allLines.join("\n"));
          actualTotal = conversations.length;
          hasMore = false;
        } else {
          const pageLines = yield* Effect.promise(() =>
            readLinesFromEnd(sessionPath, total, offset, limit),
          );
          conversations = parseJsonl(pageLines.join("\n"));
          actualTotal = total;
          hasMore = offset + limit < total;
        }

        // Get file stats
        const stat = yield* fs.stat(sessionPath);

        // Get session metadata
        const meta = yield* sessionMetaService.getSessionMeta(projectId, sessionId);

        const sessionDetail: SessionDetail = {
          id: sessionId,
          jsonlFilePath: sessionPath,
          meta,
          conversations,
          lastModifiedAt: Option.getOrElse(stat.mtime, () => new Date()),
        };

        return { sessionDetail, total: actualTotal, hasMore };
      });

      return {
        session: sessionDetail.sessionDetail,
        total: sessionDetail.total,
        hasMore: sessionDetail.hasMore,
      };
    });

  const getSessions = (
    projectId: string,
    options?: {
      maxCount?: number;
      cursor?: string;
    },
  ) =>
    Effect.gen(function* () {
      const { maxCount = 20, cursor } = options ?? {};

      const claudeProjectPath = decodeProjectId(projectId);

      // Validate that the project path is within the Claude projects directory
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(claudeProjectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      // Ensure project is synced in DB
      const projectExists = db
        .select({ one: sql<number>`1` })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
      if (!projectExists) {
        yield* syncService.syncProjectList(projectId).pipe(Effect.catchAll(() => Effect.void));
      }

      // Fetch all sessions for project ordered by lastModifiedAt DESC
      const rows = db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projectId))
        .orderBy(desc(sessions.lastModifiedAt))
        .all();

      if (rows.length === 0) {
        return { sessions: [] };
      }

      // Cursor-based pagination
      const startIndex =
        cursor !== undefined
          ? (() => {
              const idx = rows.findIndex((r) => r.id === cursor);
              return idx === -1 ? 0 : idx + 1;
            })()
          : 0;

      const sessionsToReturn = rows.slice(startIndex, startIndex + maxCount);

      const sessionsResult: Session[] = yield* Effect.all(
        sessionsToReturn.map((row) =>
          Effect.gen(function* () {
            const meta = yield* sessionMetaService.getSessionMeta(projectId, row.id);
            return {
              id: row.id,
              jsonlFilePath: row.filePath,
              lastModifiedAt: new Date(row.lastModifiedAt),
              meta,
            } satisfies Session;
          }),
        ),
        { concurrency: "unbounded" },
      );

      return { sessions: sessionsResult };
    });

  return {
    getSession,
    getSessions,
  };
});

export type ISessionRepository = InferEffect<typeof LayerImpl>;

export class SessionRepository extends Context.Tag("SessionRepository")<
  SessionRepository,
  ISessionRepository
>() {
  static Live = Layer.effect(this, LayerImpl);
}
