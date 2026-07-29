import { FileSystem } from "@effect/platform";
import { desc } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { DrizzleService } from "../../../lib/db/DrizzleService.ts";
import { projects } from "../../../lib/db/schema.ts";
import type { InferEffect } from "../../../lib/effect/types.ts";
import { ApplicationContext } from "../../platform/services/ApplicationContext.ts";
import type { Project } from "../../types.ts";
import { decodeProjectId, validateProjectPath } from "../functions/id.ts";
import { ProjectMetaService } from "../services/ProjectMetaService.ts";

const LayerImpl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectMetaService = yield* ProjectMetaService;
  const context = yield* ApplicationContext;
  const { db } = yield* DrizzleService;

  const getProject = (projectId: string) =>
    Effect.gen(function* () {
      const fullPath = decodeProjectId(projectId);

      // Validate that the decoded path is within the Claude projects directory
      const { claudeProjectsDirPath } = yield* context.claudeCodePaths;
      if (!validateProjectPath(fullPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      // Check if project directory exists
      const exists = yield* fs.exists(fullPath);
      if (!exists) {
        return yield* Effect.fail(new Error("Project not found"));
      }

      // Get file stats
      const stat = yield* fs.stat(fullPath);

      // Get project metadata
      const meta = yield* projectMetaService.getProjectMeta(projectId);

      return {
        project: {
          id: projectId,
          claudeProjectPath: fullPath,
          lastModifiedAt: Option.getOrElse(stat.mtime, () => new Date()),
          meta,
        },
      };
    });

  const getProjects = () =>
    Effect.gen(function* () {
      // Fetch all projects from DB ordered by dirMtimeMs DESC
      const rows = db.select().from(projects).orderBy(desc(projects.dirMtimeMs)).all();

      if (rows.length === 0) {
        return { projects: [] };
      }

      const buildProject = (row: (typeof rows)[number]): Effect.Effect<Project, Error> =>
        Effect.gen(function* () {
          if (!row.id) {
            return yield* Effect.fail(new Error("blank project id"));
          }
          const meta = yield* projectMetaService.getProjectMeta(row.id);
          const project: Project = {
            id: row.id,
            claudeProjectPath: row.path ?? decodeProjectId(row.id),
            lastModifiedAt: new Date(row.dirMtimeMs),
            meta,
          };
          return project;
        });

      const projectsList = yield* Effect.all(
        rows.map((row) =>
          // A malformed row is usually a transient bad read, so retry once
          // (sandbox/unsandbox lets retry see thrown defects too). If it still
          // fails, keep the row as an unavailable placeholder instead of
          // dropping it, so a broken project never silently vanishes.
          buildProject(row).pipe(
            Effect.sandbox,
            Effect.retry({ times: 1 }),
            Effect.unsandbox,
            Effect.catchAllCause((cause) => {
              const errMsg = (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, 120);
              const looksCorrupt =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  row.id ?? "",
                );
              const placeholder: Project = {
                id: row.id || "<unavailable>",
                claudeProjectPath: row.path ?? "",
                lastModifiedAt: new Date(row.dirMtimeMs),
                meta: { projectName: null, projectPath: row.path ?? null, sessionCount: 0 },
                unavailable: true,
              };
              return (
                looksCorrupt
                  ? Effect.logError(
                      `getProjects: row id looks like a session uuid — possible DB corruption; id=${row.id} path=${row.path ?? "(no path)"} error=${errMsg}`,
                    )
                  : Effect.logWarning(
                      `getProjects: row unavailable; id=${row.id ?? "<blank>"} path=${row.path ?? "(no path)"} error=${errMsg}`,
                    )
              ).pipe(Effect.andThen(Effect.succeed(placeholder)));
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );

      const badIds = projectsList.filter((p) => p.unavailable === true).map((p) => p.id);
      if (badIds.length > 0) {
        // One capped line per request (not per row) to name the bad ids
        // without spamming the log when many rows are bad.
        const sample = badIds.slice(0, 5).join(", ");
        const suffix = badIds.length > 5 ? `, +${badIds.length - 5} more` : "";
        yield* Effect.logWarning(
          `getProjects: ${badIds.length}/${projectsList.length} project row(s) unavailable after retry; ids: ${sample}${suffix}`,
        );
      }

      return { projects: projectsList };
    });

  return {
    getProject,
    getProjects,
  };
});

export type IProjectRepository = InferEffect<typeof LayerImpl>;
export class ProjectRepository extends Context.Tag("ProjectRepository")<
  ProjectRepository,
  IProjectRepository
>() {
  static Live = Layer.effect(this, LayerImpl);
}
