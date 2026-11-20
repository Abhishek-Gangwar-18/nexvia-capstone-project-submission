import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, Pencil, RotateCcw, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { ConfirmDialog } from '../ui/Modal';

/**
 * What a vendor or admin sees on a product page instead of Add to cart / Buy now (only customers shop):
 * the vendor gets "Edit product" on their own listings, the admin can remove or restore the listing.
 */
interface StaffProductActionsProps {
  user?: any;
  product?: any;
}

export default function StaffProductActions({ user, product }: StaffProductActionsProps) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const removed = product.moderation?.status === 'removed';

  const moderate = useMutation({
    mutationFn: (body: any) => api.patch(`/admin/products/${product._id}`, body),
    onSuccess: (_, body) => {
      toast.success(body.status === 'removed' ? 'Listing removed from the marketplace' : 'Listing restored');
      setRemoving(false);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['product', product._id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const note = (text) => (
    <p className="flex items-start gap-2 rounded-xl bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {text}
    </p>
  );

  if (user.role === 'vendor') {
    const own = String(product.vendor?._id) === String(user.vendor?._id);
    return (
      <div className="mt-5 space-y-3">
        {own && (
          <Link to={`/vendor/products/${product._id}/edit`} className="btn btn-primary btn-lg w-full">
            <Pencil className="h-4 w-4" /> Edit product
          </Link>
        )}
        {note('You’re signed in as a seller. Use a customer account to shop.')}
      </div>
    );
  }

  // Admin
  return (
    <div className="mt-5 space-y-3">
      {removed ? (
        <button type="button" disabled={moderate.isPending} onClick={() => moderate.mutate({ status: 'approved' })} className="btn btn-secondary btn-lg w-full">
          <RotateCcw className="h-4 w-4" /> Restore listing
        </button>
      ) : (
        <button type="button" onClick={() => setRemoving(true)} className="btn btn-secondary btn-lg w-full text-rose-600">
          <ShieldAlert className="h-4 w-4" /> Moderate: remove listing
        </button>
      )}
      {removed && product.moderation?.reason && note(`Removed by an admin: ${product.moderation.reason}`)}
      {note('Admin view: buying is disabled for admin accounts.')}
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={() => (reason.trim().length >= 3 ? moderate.mutate({ status: 'removed', reason: reason.trim() }) : toast.error('Give a reason (at least 3 characters)'))}
        loading={moderate.isPending}
        danger
        title="Remove this listing?"
        description="It disappears from search, the store and carts. The seller sees your reason and you can restore it any time."
        confirmLabel="Remove listing"
      >
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} placeholder="Reason (shown to the seller)" className="input mt-3" />
      </ConfirmDialog>
    </div>
  );
}
