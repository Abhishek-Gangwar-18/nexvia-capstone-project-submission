import { Bell, CheckCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { IconButton } from "@/components/ui/Button";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from "@/hooks/queries";
import { cn, timeAgo } from "@/lib/utils";
import type { NotificationItem } from "@/types";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const unread = data?.unread_count ?? 0;
  const items = data?.results ?? [];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openItem = (item: NotificationItem) => {
    if (!item.read_at) markRead.mutate(item.id);
    setOpen(false);
    if (item.url) navigate(item.url);
  };

  return (
    <div ref={panel} className="relative">
      <IconButton label="Notifications" className="relative" onClick={() => setOpen((value) => !value)}>
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </IconButton>
      {open && (
        <div className="absolute top-11 right-0 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <div>
              <p className="text-sm font-semibold">Notifications</p>
              <p className="text-[11px] text-slate-500">{unread} unread</p>
            </div>
            <button
              onClick={() => markAllRead.mutate()}
              disabled={!unread}
              className="flex cursor-pointer items-center gap-1 text-xs text-brand-600 hover:text-brand-700 disabled:cursor-default disabled:opacity-50"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <p className="px-4 py-8 text-center text-xs text-slate-400">You're all caught up.</p>}
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => openItem(item)}
                className={cn(
                  "flex w-full cursor-pointer gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60",
                  !item.read_at && "bg-brand-50/50 dark:bg-brand-500/5",
                )}
              >
                <span className={cn("mt-1 size-2 shrink-0 rounded-full", item.read_at ? "bg-transparent" : "bg-brand-500")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold">{item.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{item.body}</span>
                  <span className="mt-1 block text-[10px] text-slate-400">{timeAgo(item.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
