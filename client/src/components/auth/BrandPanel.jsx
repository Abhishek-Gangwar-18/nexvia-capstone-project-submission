import { motion } from 'framer-motion';
import { BadgeCheck, Split, Truck } from 'lucide-react';
import { cn } from '../../lib/format';
import { Logo } from '../ui/Brand';

const POINTS = [
  { icon: BadgeCheck, title: 'Verified sellers', text: 'Every store is reviewed before going live' },
  { icon: Split, title: 'Split payments', text: 'Stripe Connect pays sellers automatically' },
  { icon: Truck, title: 'Track every package', text: 'Live status from placed to delivered' },
];

/** The dark marketing column beside the sign-in / sign-up forms. */
export default function BrandPanel({ className }) {
  return (
    <div className={cn('relative flex-col overflow-hidden bg-[#100b2e] p-8 text-white', className)}>
      <div className="absolute -top-20 -left-20 h-80 w-80 animate-blob rounded-full bg-brand-600/50 blur-3xl" />
      <div className="absolute right-0 bottom-0 h-72 w-72 animate-blob rounded-full bg-fuchsia-500/30 blur-3xl [animation-delay:-5s]" />
      <div className="absolute inset-0 bg-grid opacity-30" />
      <div className="relative [&_span]:text-white">
        <Logo />
      </div>
      <div className="relative mt-auto pt-10">
        <h2 className="font-display text-3xl leading-tight font-extrabold">
          One marketplace.
          <br />
          <span className="bg-gradient-to-r from-amber-300 to-pink-300 bg-clip-text text-transparent">Hundreds of sellers.</span>
        </h2>
        <div className="mt-6 space-y-3">
          {POINTS.map(({ icon: Icon, title, text }, i) => (
            <motion.div key={title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.1 }} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-3.5 backdrop-blur">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10">
                <Icon className="h-5 w-5 text-amber-300" />
              </div>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-indigo-200">{text}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
