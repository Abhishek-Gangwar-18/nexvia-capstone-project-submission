import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { Spinner } from '../../components/ui/Feedback';

/** Landing page for the emailed link: /verify-email?token=… */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState({ status: token ? 'loading' : 'error', message: token ? '' : 'This verification link is incomplete.' });
  // Tokens are single-use: guard against React StrictMode running the effect twice.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api
      .post('/auth/verify-email', { token })
      .then(({ data }) => {
        const { user, setUser } = useAuth.getState();
        if (user && user._id === data.user._id) setUser(data.user);
        setState({ status: 'done' });
      })
      .catch((err) => setState({ status: 'error', message: errorMessage(err) }));
  }, [token]);

  return (
    <div className="container-page flex min-h-[60vh] items-center justify-center py-16">
      <div className="card w-full max-w-md p-8 text-center">
        {state.status === 'loading' && (
          <>
            <Spinner className="mx-auto h-8 w-8" />
            <p className="mt-4 muted">Verifying your email…</p>
          </>
        )}
        {state.status === 'done' && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h1 className="mt-4 font-display text-2xl font-bold">Email verified</h1>
            <p className="mt-2 muted">You can now check out and open a store.</p>
            <Link to="/" className="btn btn-primary mt-6">Continue shopping</Link>
          </>
        )}
        {state.status === 'error' && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-rose-500" />
            <h1 className="mt-4 font-display text-2xl font-bold">Couldn’t verify</h1>
            <p className="mt-2 muted">{state.message}</p>
            <Link to="/account" className="btn btn-secondary mt-6">Resend from your account</Link>
          </>
        )}
      </div>
    </div>
  );
}
