import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, Search } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="container-page flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <motion.p
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 14 }}
        className="bg-gradient-to-br from-brand-500 to-indigo-600 bg-clip-text font-display text-[8rem] leading-none font-extrabold text-transparent"
      >
        404
      </motion.p>
      <h1 className="mt-4 font-display text-2xl font-bold">This page took a wrong turn</h1>
      <p className="mt-2 max-w-sm muted">The page you’re looking for doesn’t exist or has been moved.</p>
      <div className="mt-8 flex gap-3">
        <Link to="/" className="btn btn-primary"><Home className="h-4 w-4" /> Go home</Link>
        <Link to="/search" className="btn btn-secondary"><Search className="h-4 w-4" /> Browse products</Link>
      </div>
    </div>
  );
}
