import { Trans } from "@lingui/react";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, FolderIcon } from "lucide-react";
import type { FC } from "react";
import { formatLocaleDate } from "@/lib/date/formatLocaleDate";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { useConfig } from "../../hooks/useConfig";
import { useProjects } from "../hooks/useProjects";

export const ProjectList: FC = () => {
  const {
    data: { projects },
  } = useProjects();
  const { config } = useConfig();

  if (projects.length === 0) {
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12">
        <FolderIcon className="w-12 h-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">
          <Trans id="project_list.no_projects.title" />
        </h3>
        <p className="text-muted-foreground text-center max-w-md">
          <Trans id="project_list.no_projects.description" />
        </p>
      </CardContent>
    </Card>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Card
          key={project.id}
          className={
            project.unavailable === true
              ? "border-destructive/40 opacity-60"
              : "hover:shadow-md transition-shadow"
          }
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 justify-start items-start">
              {project.unavailable === true ? (
                <AlertTriangleIcon className="w-5 h-5 flex-shrink-0 text-destructive" />
              ) : (
                <FolderIcon className="w-5 h-5 flex-shrink-0" />
              )}
              <span className="text-wrap flex-1">
                {project.meta.projectName ?? project.claudeProjectPath}
              </span>
              {project.unavailable === true ? (
                <span className="flex-shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                  <Trans id="project_list.unavailable" />
                </span>
              ) : null}
            </CardTitle>
            {project.meta.projectPath !== undefined && project.meta.projectPath !== "" ? (
              <CardDescription>{project.meta.projectPath}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <Trans id="project_list.last_modified" />{" "}
              {project.lastModifiedAt
                ? formatLocaleDate(project.lastModifiedAt, {
                    locale: config.locale,
                    target: "time",
                  })
                : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              <Trans id="project_list.messages" /> {project.meta.sessionCount}
            </p>
          </CardContent>
          <CardContent className="pt-0">
            {project.unavailable === true ? (
              <Button className="w-full" variant="outline" disabled>
                <Trans id="project_list.unavailable" />
              </Button>
            ) : (
              <Button asChild className="w-full">
                <Link to={"/projects/$projectId/session"} params={{ projectId: project.id }}>
                  <Trans id="project_list.view_conversations" />
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
