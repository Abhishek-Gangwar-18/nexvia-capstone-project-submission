import { useMutation } from '@tanstack/react-query';
import { MailWarning } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../store/auth';

/** Nudges signed-in, unverified users; checkout and seller onboarding stay locked until they verify. */
export default function VerifyEmailBanner() {
  const user = useAuth((s) => s.user);
  const resend = useMutation({
    mutationFn: () => api.post('/auth/verify-email/resend').then((r) => r.data),
    onSuccess: (data) => toast.success(data.message),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!user || user.role === 'admin' || user.emailVerified !== false) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
      <div className="container-page flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
        <MailWarning className="h-4 w-4 shrink-0" />
        <span>
          Verify <strong>{user.email}</strong> to check out and sell. Check your inbox for the link.
        </span>
        <button type="button" onClick={() => resend.mutate()} disabled={resend.isPending} className="font-semibold underline underline-offset-2 disabled:opacity-60">
          {resend.isPending ? 'Sending…' : 'Resend email'}
        </button>
      </div>
    </div>
  );
}
