import { Compass } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Misc";

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <EmptyState
        icon={<Compass className="size-6" />}
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={<Link to="/"><Button variant="primary">Back to FlowBoard</Button></Link>}
      />
    </div>
  );
}
