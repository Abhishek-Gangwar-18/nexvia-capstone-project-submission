import { Building } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useCreateWorkspace } from "@/hooks/queries";

export function CreateWorkspaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const create = useCreateWorkspace();
  const navigate = useNavigate();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name },
      {
        onSuccess: (workspace) => {
          toast.success(`Welcome to ${workspace.name}`);
          setName("");
          onClose();
          navigate(`/w/${workspace.slug}/projects`);
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Create a workspace"
      description="Workspaces are fully isolated: separate projects, members and billing."
      icon={<span className="flex size-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10"><Building className="size-5" /></span>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Company or team name">
          <Input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>Create workspace</Button>
        </div>
      </form>
    </Modal>
  );
}
