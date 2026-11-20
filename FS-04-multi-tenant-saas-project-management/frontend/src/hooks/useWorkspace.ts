import { createContext, useContext } from "react";
import { useOutletContext } from "react-router";
import type { Project, Role, Workspace } from "@/types";

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside a workspace route");
  return workspace;
}

export function useWorkspaceSlug(): string {
  return useWorkspace().slug;
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Mirrors the backend role ladder so the UI only offers what the API will allow. */
export function usePermissions() {
  const { role } = useWorkspace();
  const atLeast = (minimum: Role) => RANK[role] >= RANK[minimum];
  return {
    role,
    canEdit: atLeast("member"),
    isAdmin: atLeast("admin"),
    isOwner: role === "owner",
  };
}

export function useProjectContext(): Project {
  return useOutletContext<Project>();
}
