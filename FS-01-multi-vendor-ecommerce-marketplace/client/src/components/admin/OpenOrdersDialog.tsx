import { PackageX } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Feedback';

/**
 * Asked when an admin takes a store offline (suspend it, or block its owner) while it still has paid,
 * unshipped orders (API 409 OPEN_ORDERS). onChoose('cancel' | 'keep') re-sends the action with the choice.
 */
interface OpenOrdersDialogProps {
  pending?: any;
  onChoose?: any;
  onClose?: () => void;
  loading?: boolean;
}

export default function OpenOrdersDialog({ pending, onChoose, onClose, loading }: OpenOrdersDialogProps) {
  return (
    <Modal open={Boolean(pending)} onClose={onClose} title="This store still has orders to ship" size="sm">
      {pending && (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
            <PackageX className="h-5 w-5 shrink-0" />
            <p>
              <span className="font-semibold">{pending.count} paid order{pending.count > 1 ? 's' : ''}</span> from this store {pending.count > 1 ? 'are' : 'is'} not shipped
              yet. Once the store is offline the seller can’t fulfil {pending.count > 1 ? 'them' : 'it'}.
            </p>
          </div>
          <button type="button" disabled={loading} onClick={() => onChoose('cancel')} className="btn btn-danger w-full">
            {loading && <Spinner className="h-4 w-4" />} Cancel and refund {pending.count > 1 ? 'them' : 'it'}
          </button>
          <button type="button" disabled={loading} onClick={() => onChoose('keep')} className="btn btn-secondary w-full">
            Keep {pending.count > 1 ? 'them' : 'it'} (I’ll handle {pending.count > 1 ? 'them' : 'it'} from Orders)
          </button>
          <p className="text-center text-xs muted">Shipped packages are not affected either way.</p>
        </div>
      )}
    </Modal>
  );
}
