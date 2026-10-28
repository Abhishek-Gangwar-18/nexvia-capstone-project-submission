import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Building2, CheckCircle2, CreditCard, Lock, ShieldCheck, Smartphone, Wallet, X, XCircle } from 'lucide-react';
import { cn, money } from '../../lib/format';
import { Spinner } from '../ui/Feedback';
import { LogoMark } from '../ui/Brand';

const METHODS = [
  { id: 'upi', label: 'UPI', icon: Smartphone },
  { id: 'card', label: 'Card', icon: CreditCard },
  { id: 'netbanking', label: 'Netbanking', icon: Building2 },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
];

/**
 * Stand-in for Razorpay Checkout when no Razorpay keys are configured.
 * It goes through the same server flow (gateway order → verify) so the whole lifecycle can be demoed offline.
 */
export default function MockPaymentModal({ open, amount, orderNumber, onResult, onClose }) {
  const [method, setMethod] = useState('upi');
  const [stage, setStage] = useState('idle');

  const pay = async (outcome) => {
    setStage('processing');
    await new Promise((r) => setTimeout(r, 1400));
    const ok = await onResult(outcome);
    setStage(ok ? 'success' : 'failed');
    if (!ok) setTimeout(() => setStage('idle'), 1800);
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <motion.div className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className="relative w-full max-w-md overflow-hidden rounded-3xl bg-white text-zinc-900 shadow-2xl"
          >
            <div className="relative bg-gradient-to-br from-[#1b1145] to-brand-700 px-6 py-5 text-white">
              <div className="flex items-center gap-3">
                <LogoMark className="h-10 w-10" />
                <div className="flex-1">
                  <p className="font-semibold">Vendora</p>
                  <p className="text-xs text-indigo-200">Order {orderNumber}</p>
                </div>
                {stage === 'idle' && (
                  <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Close">
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
              <p className="mt-4 text-xs text-indigo-200">Amount payable</p>
              <p className="font-display text-3xl font-bold">{money(amount / 100)}</p>
              <span className="absolute top-5 right-14 rounded-md bg-amber-400 px-2 py-0.5 text-[10px] font-bold tracking-wide text-zinc-900 uppercase">Test mode</span>
            </div>

            <div className="relative min-h-[300px] p-6">
              <AnimatePresence mode="wait">
                {stage === 'idle' && (
                  <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <div className="grid grid-cols-4 gap-2">
                      {METHODS.map(({ id, label, icon: Icon }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setMethod(id)}
                          className={cn('flex flex-col items-center gap-1.5 rounded-2xl border-2 py-3 text-xs font-semibold transition', method === id ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}
                        >
                          <Icon className="h-5 w-5" /> {label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-5 rounded-2xl bg-zinc-50 p-4 text-sm">
                      {method === 'upi' && <p>UPI ID: <span className="font-mono font-semibold">success@razorpay</span></p>}
                      {method === 'card' && <p>Card: <span className="font-mono font-semibold">4111 1111 1111 1111</span> · 12/30 · 123</p>}
                      {method === 'netbanking' && <p>Bank: <span className="font-semibold">Test Bank (Sandbox)</span></p>}
                      {method === 'wallet' && <p>Wallet: <span className="font-semibold">Test Wallet</span></p>}
                      <p className="mt-1 text-xs text-zinc-500">No real money moves. Configure Razorpay test keys to use real Razorpay Checkout.</p>
                    </div>
                    <button type="button" onClick={() => pay('success')} className="btn btn-primary btn-lg mt-5 w-full">
                      <Lock className="h-4 w-4" /> Pay {money(amount / 100)}
                    </button>
                    <button type="button" onClick={() => pay('failure')} className="mt-2 w-full py-2 text-xs font-semibold text-zinc-500 hover:text-rose-600">
                      Simulate a declined payment
                    </button>
                  </motion.div>
                )}
                {stage === 'processing' && (
                  <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-[260px] flex-col items-center justify-center gap-4">
                    <Spinner className="h-12 w-12 text-brand-600" />
                    <p className="font-semibold">Processing payment…</p>
                    <p className="text-xs text-zinc-500">Splitting funds between sellers and the platform</p>
                  </motion.div>
                )}
                {stage === 'success' && (
                  <motion.div key="success" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex h-[260px] flex-col items-center justify-center gap-3 text-center">
                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 12 }}>
                      <CheckCircle2 className="h-16 w-16 text-emerald-500" />
                    </motion.div>
                    <p className="font-display text-xl font-bold">Payment successful</p>
                    <p className="text-sm text-zinc-500">Redirecting to your order…</p>
                  </motion.div>
                )}
                {stage === 'failed' && (
                  <motion.div key="failed" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex h-[260px] flex-col items-center justify-center gap-3 text-center">
                    <motion.div animate={{ x: [0, -10, 10, -6, 6, 0] }} transition={{ duration: 0.5 }}>
                      <XCircle className="h-16 w-16 text-rose-500" />
                    </motion.div>
                    <p className="font-display text-xl font-bold">Payment declined</p>
                    <p className="text-sm text-zinc-500">Your order is saved — you can try again.</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <p className="flex items-center justify-center gap-1.5 border-t border-zinc-100 py-3 text-[11px] text-zinc-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Secured test gateway · Razorpay-compatible flow
            </p>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
