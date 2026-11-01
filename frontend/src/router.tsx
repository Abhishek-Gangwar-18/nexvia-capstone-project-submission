import { createBrowserRouter, Navigate } from "react-router";
import { HomeRedirect, RequireAuth, WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import AcceptInvitePage from "@/pages/auth/AcceptInvitePage";
import LoginPage from "@/pages/auth/LoginPage";
import RegisterPage from "@/pages/auth/RegisterPage";
import DashboardPage from "@/pages/DashboardPage";
import IssuesPage from "@/pages/IssuesPage";
import MembersPage from "@/pages/MembersPage";
import NotFoundPage from "@/pages/NotFoundPage";
import OnboardingPage from "@/pages/OnboardingPage";
import ProfilePage from "@/pages/ProfilePage";
import BacklogPage from "@/pages/project/BacklogPage";
import BoardPage from "@/pages/project/BoardPage";
import ProjectLayout from "@/pages/project/ProjectLayout";
import ProjectsPage from "@/pages/ProjectsPage";
import WorkflowPage from "@/pages/project/WorkflowPage";
import SettingsPage from "@/pages/SettingsPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  { path: "/invite/:token", element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <HomeRedirect /> },
      { path: "/onboarding", element: <OnboardingPage /> },
      {
        path: "/w/:slug",
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", element: <DashboardPage /> },
          { path: "projects", element: <ProjectsPage /> },
          {
            path: "projects/:key",
            element: <ProjectLayout />,
            children: [
              { index: true, element: <Navigate to="board" replace /> },
              { path: "board", element: <BoardPage /> },
              { path: "backlog", element: <BacklogPage /> },
              { path: "issues", element: <IssuesPage /> },
              { path: "workflow", element: <WorkflowPage /> },
            ],
          },
          { path: "issues", element: <IssuesPage /> },
          { path: "members", element: <MembersPage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "profile", element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);
