import { FileSystem } from "@effect/platform";
import { desc, eq } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option } from "effect";
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
  // oxlint-disable-next-line node/no-process-env -- configuration boundary
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
      // oxlint-disable-next-line no-unsafe-type-assertion -- createReadStream with utf8 encoding always yields string chunks
      lastChunk = chunk as string;
      // oxlint-disable-next-line no-unsafe-type-assertion -- createReadStream with utf8 encoding always yields string chunks
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
      // oxlint-disable-next-line no-unsafe-type-assertion -- createReadStream with utf8 encoding always yields string chunks
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
          options?.limit !== undefined || options?.offset !== undefined || total > pageSize;

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

      // Ensure project is synced in DB.
      // fs.watch(recursive:true) on Linux is known to miss events under load, so we can't
      // rely on the file watcher alone. Cheap defense: compare the projects dir's current
      // mtime with what we stored on the last sync — if the dir has changed since (a file
      // was added or removed), re-run syncProjectList. This makes getSessions self-healing
      // for missed-watch cases at negligible cost (one fs.stat per API call).
      const projectRow = db
        .select({ dirMtimeMs: projects.dirMtimeMs })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
      if (projectRow === undefined) {
        yield* syncService.syncProjectList(projectId).pipe(Effect.catchAll(() => Effect.void));
      } else {
        const currentStat = yield* fs
          .stat(claudeProjectPath)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (currentStat !== null) {
          const currentMtimeMs = Option.getOrElse(currentStat.mtime, () => new Date(0)).getTime();
          if (currentMtimeMs > projectRow.dirMtimeMs) {
            yield* syncService.syncProjectList(projectId).pipe(Effect.catchAll(() => Effect.void));
          }
        }
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

      const buildSession = (row: (typeof rows)[number]): Effect.Effect<Session, Error> =>
        Effect.gen(function* () {
          if (!row.id) {
            return yield* Effect.fail(new Error("blank session id"));
          }
          const meta = yield* sessionMetaService.getSessionMeta(projectId, row.id);
          const session: Session = {
            id: row.id,
            jsonlFilePath: row.filePath,
            lastModifiedAt: new Date(row.lastModifiedAt),
            meta,
          };
          return session;
        });

      const sessionsResult = yield* Effect.all(
        sessionsToReturn.map((row) =>
          // A malformed row is usually a transient bad read, so retry once
          // (sandbox/unsandbox lets retry see thrown defects too). If it still
          // fails, keep the row as an unavailable placeholder instead of
          // dropping it, so a broken session never silently vanishes and a bad
          // row can never crash the whole project detail page.
          buildSession(row).pipe(
            Effect.sandbox,
            Effect.retry({ times: 1 }),
            Effect.unsandbox,
            Effect.catchAllCause((cause) => {
              const errMsg = (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, 120);
              const looksCorrupt =
                (row.id?.length ?? 0) > 40 && /^[A-Za-z0-9_-]+$/.test(row.id ?? "");
              const placeholder: Session = {
                id: row.id || "<unavailable>",
                jsonlFilePath: row.filePath ?? "",
                lastModifiedAt: new Date(row.lastModifiedAt),
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
                unavailable: true,
              };
              return (
                looksCorrupt
                  ? Effect.logError(
                      `getSessions: row id looks like a project id — possible DB corruption; id=${row.id} path=${row.filePath ?? "(no path)"} error=${errMsg}`,
                    )
                  : Effect.logWarning(
                      `getSessions: row unavailable; id=${row.id ?? "<blank>"} path=${row.filePath ?? "(no path)"} error=${errMsg}`,
                    )
              ).pipe(Effect.andThen(Effect.succeed(placeholder)));
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );

      const badIds = sessionsResult.filter((s) => s.unavailable === true).map((s) => s.id);
      if (badIds.length > 0) {
        // One capped line per request (not per row) to name the bad ids
        // without spamming the log when many rows are bad.
        const sample = badIds.slice(0, 5).join(", ");
        const suffix = badIds.length > 5 ? `, +${badIds.length - 5} more` : "";
        yield* Effect.logWarning(
          `getSessions: ${badIds.length}/${sessionsResult.length} session row(s) unavailable after retry; ids: ${sample}${suffix}`,
        );
      }

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
