import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BarChart3, Check, Coins, Percent, ShieldCheck, Ticket, Truck, Upload } from 'lucide-react';
import { useAuth } from '../store/auth';
import { money } from '../lib/format';

const FEATURES = [
  { icon: Upload, title: 'Easy product listing', text: 'Drag-and-drop images to S3, rich specs, live preview.' },
  { icon: Truck, title: 'Simple fulfilment', text: 'Pack → ship → deliver with one click per package.' },
  { icon: Coins, title: 'Automatic payouts', text: 'Stripe Connect transfers your share after delivery.' },
  { icon: BarChart3, title: 'Real-time analytics', text: 'Revenue, earnings, top products and low-stock alerts.' },
  { icon: Ticket, title: 'Your own coupons', text: 'Run store-specific discounts to boost sales.' },
  { icon: ShieldCheck, title: 'Protected payments', text: 'Customers pay upfront — no cash collection risk.' },
];

export default function Sell() {
  const user = useAuth((s) => s.user);
  const [price, setPrice] = useState(2499);
  const [units, setUnits] = useState(120);
  const rate = 10;
  const revenue = price * units;
  const commission = (revenue * rate) / 100;

  const cta = !user ? '/register?role=vendor' : user.role === 'vendor' ? (user.vendor?.status === 'approved' ? '/vendor' : '/vendor/onboarding') : user.role === 'customer' ? '/vendor/onboarding' : '/admin';
  const ctaLabel = user?.role === 'vendor' ? 'Go to Seller Hub' : user?.role === 'admin' ? 'Open admin console' : 'Start selling today';

  return (
    <div className="space-y-16 pb-8">
      <section className="container-page pt-6">
        <div className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-brand-700 via-indigo-700 to-[#100b2e] px-6 py-14 text-white sm:px-12">
          <div className="absolute inset-0 bg-grid opacity-25" />
          <div className="absolute -right-24 -bottom-24 h-96 w-96 animate-blob rounded-full bg-amber-400/25 blur-3xl" />
          <div className="relative max-w-2xl">
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold tracking-wide uppercase">Sell on Vendora</span>
            <h1 className="mt-4 font-display text-4xl leading-tight font-extrabold sm:text-5xl">Your store. Our customers. Automatic payouts.</h1>
            <p className="mt-4 text-lg text-indigo-100">Register your business, list products and start receiving orders. We handle payments and split them automatically.</p>
            <Link to={cta} className="btn btn-accent btn-lg mt-8">
              {ctaLabel} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="container-page">
        <h2 className="section-title text-center">Everything you need to grow</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }, i) => (
            <motion.div key={title} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} className="card p-6 transition hover:-translate-y-1 hover:shadow-lg">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-600/25">
                <Icon className="h-5 w-5" />
              </div>
              <p className="mt-4 font-semibold">{title}</p>
              <p className="mt-1 text-sm muted">{text}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="container-page">
        <div className="card grid gap-8 p-6 sm:p-10 lg:grid-cols-2">
          <div>
            <span className="flex items-center gap-2 text-xs font-bold tracking-[0.2em] text-brand-600 uppercase dark:text-brand-300">
              <Percent className="h-4 w-4" /> Earnings calculator
            </span>
            <h2 className="mt-3 font-display text-3xl font-bold">See what you’ll take home</h2>
            <p className="mt-2 muted">Vendora keeps a flat {rate}% platform commission (some categories are lower). Everything else is yours.</p>
            <div className="mt-6 space-y-6">
              <div>
                <div className="flex justify-between text-sm"><span className="font-semibold">Average selling price</span><span className="font-bold">{money(price)}</span></div>
                <input type="range" min={99} max={50000} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} className="mt-2 w-full accent-brand-600" />
              </div>
              <div>
                <div className="flex justify-between text-sm"><span className="font-semibold">Units sold per month</span><span className="font-bold">{units}</span></div>
                <input type="range" min={1} max={1000} value={units} onChange={(e) => setUnits(Number(e.target.value))} className="mt-2 w-full accent-brand-600" />
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-center rounded-3xl bg-gradient-to-br from-brand-50 to-indigo-50 p-6 dark:from-brand-500/10 dark:to-indigo-500/5">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="muted">Monthly sales</span><span className="font-semibold">{money(revenue)}</span></div>
              <div className="flex justify-between"><span className="muted">Platform commission ({rate}%)</span><span className="font-semibold text-rose-600">−{money(commission)}</span></div>
              <div className="h-3 overflow-hidden rounded-full bg-white dark:bg-white/10">
                <motion.div className="h-full bg-gradient-to-r from-emerald-400 to-teal-500" animate={{ width: `${100 - rate}%` }} />
              </div>
            </div>
            <p className="mt-6 text-sm muted">You earn every month</p>
            <motion.p key={revenue} initial={{ scale: 0.95, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} className="font-display text-5xl font-extrabold text-emerald-600 dark:text-emerald-400">
              {money(revenue - commission)}
            </motion.p>
            <ul className="mt-6 space-y-2 text-sm">
              {['No listing fees', 'Paid automatically after delivery', 'Cancel anytime'].map((t) => (
                <li key={t} className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-500" /> {t}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
