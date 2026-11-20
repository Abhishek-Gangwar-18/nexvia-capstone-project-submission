import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, Link2, Mail, MessageCircle, MoreHorizontal, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn, discountOf, money } from '../../lib/format';
import { Modal } from '../ui/Modal';

/** Copies text, falling back to a hidden textarea where the Clipboard API is unavailable (http, old browsers). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Share a product: preview card, the link with one-click copy, and quick-share buttons. */
interface ShareModalProps {
  open?: boolean;
  onClose?: () => void;
  product?: any;
}

export default function ShareModal({ open, onClose, product }: ShareModalProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const url = typeof window !== 'undefined' ? window.location.href.split('#')[0] : '';
  const off = discountOf(product);
  const message = `Check out ${product.title} for ${money(product.price)} on Vendora`;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copy = async () => {
    if (!(await copyText(url))) return toast.error('Couldn’t copy. Select the link and copy it manually.');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2200);
    return undefined;
  };

  const enc = encodeURIComponent;
  const targets = [
    { label: 'WhatsApp', icon: MessageCircle, tone: 'bg-emerald-500', href: `https://wa.me/?text=${enc(`${message}: ${url}`)}` },
    { label: 'Telegram', icon: Send, tone: 'bg-sky-500', href: `https://t.me/share/url?url=${enc(url)}&text=${enc(message)}` },
    { label: 'X', text: '𝕏', tone: 'bg-zinc-900 dark:bg-zinc-700', href: `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(message)}` },
    { label: 'Email', icon: Mail, tone: 'bg-rose-500', href: `mailto:?subject=${enc(product.title)}&body=${enc(`${message}\n\n${url}`)}` },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Share this product" description="Send it to a friend or save the link for later." size="sm">
      <div className="space-y-5">
        {/* Preview: roughly what the link stands for. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative flex items-center gap-4 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-50 to-indigo-50 p-3 ring-1 ring-brand-100 dark:from-brand-500/10 dark:to-indigo-500/5 dark:ring-white/10"
        >
          <div className="pointer-events-none absolute -top-8 -right-8 h-24 w-24 rounded-full bg-brand-400/20 blur-2xl" />
          <img src={product.thumbnail || product.images?.[0]?.url} alt="" className="h-16 w-16 shrink-0 rounded-xl bg-white object-contain p-1.5 dark:bg-white/5" />
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm font-semibold">{product.title}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-display font-bold">{money(product.price)}</span>
              {off > 0 && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">{off}% off</span>}
            </p>
          </div>
        </motion.div>

        {/* Link + copy */}
        <div>
          <p className="label">Product link</p>
          <div className={cn('flex items-center gap-2 rounded-xl border p-1.5 pl-3 transition', copied ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-zinc-200 dark:border-white/10')}>
            <Link2 className="h-4 w-4 shrink-0 text-zinc-400" />
            <input readOnly value={url} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none" aria-label="Product link" />
            <button type="button" onClick={copy} className={cn('btn btn-sm min-w-[96px] justify-center', copied ? 'bg-emerald-500 text-white hover:bg-emerald-500' : 'btn-primary')}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={String(copied)} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} className="flex items-center gap-1.5">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied!' : 'Copy'}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </div>

        {/* Quick share */}
        <div>
          <p className="label">Share via</p>
          <div className="flex flex-wrap gap-4">
            {targets.map(({ label, icon: Icon, text, tone, href }, i) => (
              <motion.a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * i }}
                whileHover={{ y: -3 }}
                className="flex w-14 flex-col items-center gap-1.5 text-[11px] font-medium muted"
              >
                <span className={cn('flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-md', tone)}>
                  {Icon ? <Icon className="h-5 w-5" /> : <span className="text-lg font-bold">{text}</span>}
                </span>
                {label}
              </motion.a>
            ))}
            {typeof navigator !== 'undefined' && navigator.share && (
              <motion.button
                type="button"
                onClick={() => navigator.share({ title: product.title, text: message, url }).catch(() => {})}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * targets.length }}
                whileHover={{ y: -3 }}
                className="flex w-14 flex-col items-center gap-1.5 text-[11px] font-medium muted"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700 shadow-md dark:bg-white/10 dark:text-zinc-200">
                  <MoreHorizontal className="h-5 w-5" />
                </span>
                More
              </motion.button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
