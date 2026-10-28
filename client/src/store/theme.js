import { create } from 'zustand';

const read = () => {
  try {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const useTheme = create((set, get) => ({
  theme: read(),
  toggle: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('vendora-theme', next);
    } catch {
      /* storage unavailable (private mode) — theme still applies for this visit */
    }
    set({ theme: next });
  },
}));
