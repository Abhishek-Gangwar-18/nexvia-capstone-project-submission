import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import BacklogPage from "./BacklogPage";
import BoardPage from "./BoardPage";

// Regression: on a scrum board with no active sprint the issues query is disabled, and a fresh `[]` default on
// every render fed useSortableContainers' state-syncing effect, so the page re-rendered forever. In the browser
// that starved React Router: clicking Backlog / Issues / Workflow changed the URL but the board stayed on screen.
// These tests count renders (through calls to the issues hook) while the queries have no data.

const renders = { issues: 0 };
const noData = { data: undefined, isLoading: false };
const mutation = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/queries", () => ({
  useIssues: () => {
    renders.issues += 1;
    // A render loop starves the event loop (timers never fire), so fail fast instead of hanging the run.
    if (renders.issues > 50) throw new Error("BoardPage/BacklogPage keep re-rendering (render loop)");
    return noData;
  },
  useSprints: () => noData,
  useMembers: () => noData,
  useLabels: () => noData,
  useWorkflow: () => noData,
  useCreateIssue: () => mutation,
  useMoveIssue: () => mutation,
  useUpdateBoard: () => mutation,
  useDeleteSprint: () => mutation,
  useCompleteSprint: () => mutation,
  useStartSprint: () => mutation,
  useSaveSprint: () => mutation,
  useCreateSprint: () => mutation,
  useUpdateSprint: () => mutation,
}));

const project = {
  id: 1, key: "NEW", name: "New project", is_archived: false, active_sprint: null, enforce_transitions: false,
  board: { id: 1, board_type: "scrum", wip_limits: {} },
  statuses: [
    { id: 1, name: "To Do", category: "todo", color: "#64748b", position: 0 },
    { id: 2, name: "Done", category: "done", color: "#10b981", position: 1 },
  ],
};

vi.mock("@/hooks/useWorkspace", () => ({
  useProjectContext: () => project,
  useWorkspace: () => ({ slug: "acme", name: "Acme", role: "owner", plan: "pro" }),
  usePermissions: () => ({ canEdit: true, isAdmin: true, isOwner: true }),
}));

function renderPage(page: () => React.ReactNode) {
  const client = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/w/acme/projects/NEW/board"]}>{page()}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  // The loop needs one ordinary re-render to start (in the app: any other query or state update), so trigger one.
  view.rerender(tree());
  return view;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("no active sprint / no data yet: pages settle instead of re-rendering forever", () => {
  afterEach(() => {
    renders.issues = 0;
  });

  it("BoardPage shows the empty state and stops rendering", async () => {
    renderPage(() => <BoardPage />);
    expect(await screen.findByText("No active sprint")).toBeInTheDocument();
    await settle();
    const settled = renders.issues;
    await settle();
    expect(renders.issues).toBe(settled); // nothing re-renders on its own
    expect(settled).toBeLessThan(10);
  });

  it("BacklogPage with queries still empty stops rendering", async () => {
    renderPage(() => <BacklogPage />);
    await settle();
    const settled = renders.issues;
    await settle();
    expect(renders.issues).toBe(settled);
    expect(settled).toBeLessThan(10);
  });
});
