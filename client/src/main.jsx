import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { queryClient } from './lib/queryClient';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="bottom-center"
          toastOptions={{
            duration: 3000,
            style: { borderRadius: '14px', background: '#18181b', color: '#fafafa', fontSize: '14px', fontWeight: 500, padding: '10px 14px' },
            success: { iconTheme: { primary: '#34d399', secondary: '#18181b' } },
            error: { iconTheme: { primary: '#fb7185', secondary: '#18181b' } },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
