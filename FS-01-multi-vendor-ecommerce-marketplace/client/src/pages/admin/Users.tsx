import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { formatDate, timeAgo } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { useAuth } from '../../store/auth';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented, Switch } from '../../components/ui/Controls';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import { UserAvatar } from '../../components/ui/Brand';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';
import OpenOrdersDialog from '../../components/admin/OpenOrdersDialog';
import { ReasonDialog } from '../../components/ui/Modal';

const ROLE_STYLE = {
  customer: 'bg-sky-100 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300',
  vendor: 'bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
  admin: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-400/10 dark:text-fuchsia-300',
};

const openOrdersToast = (data) => {
  if (data?.openOrders) {
    const { count, cancelled } = data.openOrders;
    toast(cancelled ? `${cancelled} of ${count} open order(s) cancelled and refunded` : `${count} open order(s) kept: handle them from Orders`, { icon: '📦' });
  }
};

export default function Users() {
  const me = useAuth((s) => s.user);
  const queryClient = useQueryClient();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [blocking, setBlocking] = useState(null);
  // Blocking a seller whose store has paid, unshipped orders: the API asks what to do with them (409 OPEN_ORDERS).
  const [openOrders, setOpenOrders] = useState(null);
  const search = useDebounce(q, 300);
  const queryKey = ['admin-users', role, search, page];

  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => api.get('/admin/users', { params: { role: role || undefined, q: search || undefined, page } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const block = useMutation({
    mutationFn: ({ id, status, reason, openOrders: choice }: Record<string, any>) => api.patch(`/admin/users/${id}`, { status, reason, openOrders: choice }),
    onSuccess: ({ data }, { status }) => {
      openOrdersToast(data);
      setOpenOrders(null);
      setBlocking(null);
      toast.success(status === 'blocked' ? 'User blocked — their sessions stop working immediately' : 'User unblocked');
      if (data.store?.changed) toast(data.store.status === 'suspended' ? 'Their store was suspended and is now hidden' : 'Their store is live again');
      queryClient.invalidateQueries({ queryKey: ['admin-vendors'] });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err, variables) => {
      const details = err.response?.data?.details;
      if (details?.code === 'OPEN_ORDERS') return setOpenOrders({ count: details.count, variables });
      return toast.error(errorMessage(err));
    },
  });

  const counts = data?.counts || {};
  return (
    <div>
      <PageHeader title="Users" description="Customers, sellers and admins on the platform." />
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/5">
          <Segmented
            size="sm"
            value={role}
            onChange={(v) => { setRole(v); setPage(1); }}
            options={[
              { value: '', label: 'All' },
              { value: 'customer', label: 'Customers', count: counts.customer || 0 },
              { value: 'vendor', label: 'Sellers', count: counts.vendor || 0 },
              { value: 'admin', label: 'Admins', count: counts.admin || 0 },
            ]}
          />
          <div className="relative lg:w-72">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name or email" className="input py-2 pl-9" />
          </div>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>User</th><th>Role</th><th>Joined</th><th>Last login</th><th>Status</th><th className="text-center">Blocked</th></tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 8 }, (_, i) => <tr key={i}><td colSpan={6}><Skeleton className="h-8" /></td></tr>)
                  : data.items.map((u) => (
                      <tr key={u._id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <UserAvatar user={u} />
                            <div>
                              <p className="font-semibold">{u.name}</p>
                              <p className="text-xs muted">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td><span className={`rounded-md px-2 py-0.5 text-xs font-bold capitalize ${ROLE_STYLE[u.role]}`}>{u.role}</span></td>
                        <td className="text-xs whitespace-nowrap">{formatDate(u.createdAt)}</td>
                        <td className="text-xs whitespace-nowrap muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</td>
                        <td title={u.blockedReason || undefined}><StatusBadge status={u.status || 'active'} /></td>
                        <td className="text-center">
                          {u.role !== 'admin' && u._id !== me._id ? (
                            <Switch
                              size="sm"
                              checked={u.status === 'blocked'}
                              onChange={(blocked) => {
                                if (!blocked) return block.mutate({ id: u._id, status: 'active' });
                                setBlocking(u);
                              }}
                              label="Block user"
                            />
                          ) : (
                            <span className="text-xs muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
      <OpenOrdersDialog
        pending={openOrders}
        loading={block.isPending}
        onClose={() => setOpenOrders(null)}
        onChoose={(choice) => block.mutate({ ...openOrders.variables, openOrders: choice })}
      />
      <ReasonDialog
        open={!!blocking && !openOrders}
        onClose={() => setBlocking(null)}
        onConfirm={(reason) => block.mutate({ id: blocking._id, status: 'blocked', reason }, { onSuccess: () => setBlocking(null) })}
        loading={block.isPending}
        danger
        title={`Block ${blocking?.name || 'user'}?`}
        description="They are signed out everywhere and can't log in until unblocked."
        placeholder="Why are you blocking this user?"
        confirmLabel="Block user"
      />
    </div>
  );
}
