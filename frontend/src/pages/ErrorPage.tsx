import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Misc";

export default function ErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <EmptyState
        icon={<TriangleAlert className="size-6" />}
        title="Something went wrong"
        description="This page hit an unexpected error. Reloading usually fixes it."
        action={<Button variant="primary" onClick={() => window.location.assign("/")}>Back to FlowBoard</Button>}
      />
    </div>
  );
}
