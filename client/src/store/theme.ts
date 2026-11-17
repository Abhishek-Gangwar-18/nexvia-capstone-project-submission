import { create } from 'zustand';

const read = (): 'light' | 'dark' => {
  try {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

interface ThemeState {
  theme: 'light' | 'dark';
  toggle: () => void;
}

export const useTheme = create<ThemeState>()((set, get) => ({
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
