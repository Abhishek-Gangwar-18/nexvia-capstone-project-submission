import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { PageLoader } from "@/components/ui/Misc";
import { useAuth } from "@/store/auth";
import AuditLogPage from "@/pages/AuditLogPage";
import BillingPage from "@/pages/BillingPage";
import { HomeRedirect, RequireAuth, WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import AcceptInvitePage from "@/pages/auth/AcceptInvitePage";
import ForgotPasswordPage from "@/pages/auth/ForgotPasswordPage";
import LoginPage from "@/pages/auth/LoginPage";
import ResetPasswordPage from "@/pages/auth/ResetPasswordPage";
import RegisterPage from "@/pages/auth/RegisterPage";
import DashboardPage from "@/pages/DashboardPage";
import ErrorPage from "@/pages/ErrorPage";
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
import ReportsPage from "@/pages/ReportsPage";
import SettingsPage from "@/pages/SettingsPage";

// The public landing page is its own chunk, so the app bundle doesn't grow for logged-in users.
const LandingPage = lazy(() => import("@/pages/LandingPage"));

/** "/" → the landing page for visitors, the last-used workspace for signed-in users. */
function HomeEntry() {
  const access = useAuth((s) => s.access);
  if (access) return <HomeRedirect />;
  return (
    <Suspense fallback={<PageLoader />}>
      <LandingPage />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  {
    errorElement: <ErrorPage />,
    children: [
      { path: "/", element: <HomeEntry /> },
      { path: "/login", element: <LoginPage /> },
      { path: "/register", element: <RegisterPage /> },
      { path: "/forgot-password", element: <ForgotPasswordPage /> },
      { path: "/reset-password/:uid/:token", element: <ResetPasswordPage /> },
      { path: "/invite/:token", element: <AcceptInvitePage /> },
      {
        element: <RequireAuth />,
        children: [
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
              { path: "reports", element: <ReportsPage /> },
              { path: "audit", element: <AuditLogPage /> },
              { path: "billing", element: <BillingPage /> },
              { path: "members", element: <MembersPage /> },
              { path: "settings", element: <SettingsPage /> },
              { path: "profile", element: <ProfilePage /> },
            ],
          },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
