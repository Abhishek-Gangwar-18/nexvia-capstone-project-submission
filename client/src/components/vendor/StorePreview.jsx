import { BadgeCheck, Eye, Mail, MapPin, Phone, Star } from 'lucide-react';
import { cn, gradientFor } from '../../lib/format';
import { StoreAvatar } from '../ui/Brand';

/**
 * Live preview of the store as shoppers will see it, built from the unsaved form. The rating comes
 * from the saved store. Without a banner it shows the same name-based gradient shoppers see.
 */
export default function StorePreview({ form, stats }) {
  const store = { ...form, storeName: form.storeName.trim() || 'Your store name' };
  const place = [form.address?.city, form.address?.state].filter(Boolean).join(', ');

  return (
    <div>
      <p className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide uppercase muted">
        <Eye className="h-3.5 w-3.5" /> Live preview
      </p>
      <div className="card overflow-hidden">
        <div className={cn('relative h-28 overflow-hidden bg-gradient-to-br', gradientFor(store.storeName))}>
          {store.banner ? <img src={store.banner} alt="" className="h-full w-full object-cover" /> : <div className="absolute inset-0 bg-grid opacity-30" />}
        </div>
        <div className="px-4 pb-4">
          <StoreAvatar store={store} size="h-16 w-16" className="relative z-10 -mt-8 ring-4 ring-white dark:ring-surface-dark" />
          <div className="mt-2 flex items-center gap-1.5">
            <p className="truncate font-display text-lg font-bold">{store.storeName}</p>
            <BadgeCheck className="h-4 w-4 shrink-0 text-sky-500" />
          </div>
          {form.tagline ? <p className="text-sm muted">{form.tagline}</p> : <p className="text-sm italic opacity-50">Your tagline</p>}
          <p className="mt-2 flex items-center gap-1 text-xs font-semibold">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" /> {(stats?.rating || 0).toFixed(1)}
          </p>
          {form.description && <p className="mt-3 line-clamp-4 text-xs leading-relaxed muted">{form.description}</p>}
          {(place || form.email || form.phone) && (
            <div className="mt-3 space-y-1 border-t border-zinc-100 pt-3 text-xs muted dark:border-white/5">
              {place && <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {place}</p>}
              {form.email && <p className="flex items-center gap-1.5 truncate"><Mail className="h-3.5 w-3.5" /> {form.email}</p>}
              {form.phone && <p className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {form.phone}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
