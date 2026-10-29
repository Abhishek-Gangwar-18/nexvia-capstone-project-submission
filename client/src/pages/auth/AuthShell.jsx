import { motion } from 'framer-motion';
import { BadgeCheck, Split, Truck } from 'lucide-react';
import { Logo } from '../../components/ui/Brand';

const POINTS = [
  { icon: BadgeCheck, title: 'Verified sellers', text: 'Every store is reviewed before going live' },
  { icon: Split, title: 'Split payments', text: 'Stripe Connect pays sellers automatically' },
  { icon: Truck, title: 'Track every package', text: 'Live status from placed to delivered' },
];

/** Two-column layout for sign-in / sign-up pages. */
export default function AuthShell({ title, subtitle, children }) {
  return (
    <div className="container-page grid min-h-[calc(100vh-140px)] items-center gap-10 py-10 lg:grid-cols-2">
      <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="relative hidden h-full min-h-[560px] overflow-hidden rounded-[2rem] bg-[#100b2e] p-10 text-white lg:flex lg:flex-col">
        <div className="absolute -top-20 -left-20 h-80 w-80 animate-blob rounded-full bg-brand-600/50 blur-3xl" />
        <div className="absolute right-0 bottom-0 h-72 w-72 animate-blob rounded-full bg-fuchsia-500/30 blur-3xl [animation-delay:-5s]" />
        <div className="absolute inset-0 bg-grid opacity-30" />
        <div className="relative [&_span]:text-white">
          <Logo />
        </div>
        <div className="relative mt-auto">
          <h2 className="font-display text-4xl leading-tight font-extrabold">
            One marketplace.
            <br />
            <span className="bg-gradient-to-r from-amber-300 to-pink-300 bg-clip-text text-transparent">Hundreds of sellers.</span>
          </h2>
          <div className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, title, text }, i) => (
              <motion.div key={title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.1 }} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
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
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-md">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-2 muted">{subtitle}</p>
        <div className="mt-8">{children}</div>
      </motion.div>
    </div>
  );
}
