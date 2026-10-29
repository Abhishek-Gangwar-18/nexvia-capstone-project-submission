import { Link } from 'react-router-dom';
import { CreditCard, Headphones, RotateCcw, ShieldCheck } from 'lucide-react';
import { Logo } from '../ui/Brand';

const PERKS = [
  { icon: ShieldCheck, title: 'Secure payments', text: 'Stripe-protected checkout' },
  { icon: RotateCcw, title: 'Easy returns', text: '7-day hassle-free returns' },
  { icon: CreditCard, title: 'Split payouts', text: 'Sellers paid after delivery' },
  { icon: Headphones, title: '24×7 support', text: 'We’re here to help' },
];

const COLUMNS = [
  { title: 'Shop', links: [['All products', '/search'], ['Top stores', '/stores'], ['Deals', '/search?sort=discount'], ['New arrivals', '/search?sort=newest']] },
  { title: 'Sell', links: [['Become a seller', '/sell'], ['Seller dashboard', '/vendor'], ['Seller login', '/login']] },
  { title: 'Account', links: [['My orders', '/orders'], ['Wishlist', '/account?tab=wishlist'], ['Addresses', '/account?tab=addresses']] },
];

export default function Footer() {
  return (
    <footer className="mt-20 border-t border-zinc-200/70 bg-white dark:border-white/[0.06] dark:bg-surface-dark">
      <div className="container-page grid grid-cols-2 gap-4 border-b border-zinc-100 py-8 lg:grid-cols-4 dark:border-white/5">
        {PERKS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{title}</p>
              <p className="text-xs muted">{text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="container-page grid gap-10 py-12 md:grid-cols-5">
        <div className="md:col-span-2">
          <Logo />
          <p className="mt-4 max-w-sm text-sm muted">
            Vendora is a multi-vendor marketplace where independent sellers reach customers across India. Every payment is split
            automatically between the seller and the platform.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <p className="text-sm font-semibold">{col.title}</p>
            <ul className="mt-3 space-y-2">
              {col.links.map(([label, to]) => (
                <li key={label}>
                  <Link to={to} className="text-sm muted transition hover:text-brand-600 dark:hover:text-brand-300">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-zinc-100 py-5 dark:border-white/5">
        <p className="container-page text-center text-xs muted">
          © {new Date().getFullYear()} Vendora Marketplace · Built with React, Node.js, MongoDB, Elasticsearch, Redis, AWS S3 & Stripe Connect
        </p>
      </div>
    </footer>
  );
}
