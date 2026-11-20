import { Building, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Misc";

const features = [
  { icon: Building, title: "Isolated workspaces", text: "Every company gets its own tenant: projects, members, data." },
  { icon: Sparkles, title: "Drag-and-drop boards", text: "Kanban and scrum boards that feel instant." },
  { icon: GitBranch, title: "Sprints & workflows", text: "Plan sprints, track velocity, ship on time." },
  { icon: ShieldCheck, title: "Role-based access", text: "Owners, admins, members and read-only viewers." },
];

const demoCards = [
  { key: "WEB-12", title: "Redesign checkout flow", color: "bg-emerald-400", w: "w-3/4" },
  { key: "API-4", title: "Rate limiter for public API", color: "bg-sky-400", w: "w-2/3" },
  { key: "MOB-8", title: "Fix crash on Android 14", color: "bg-rose-400", w: "w-1/2" },
];

export function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-violet-700 p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 size-[28rem] rounded-full bg-violet-400/20 blur-3xl" />
        <Logo className="relative text-lg [&_svg]:drop-shadow" />
        <div className="relative mt-auto max-w-lg">
          <h1 className="text-4xl leading-tight font-bold tracking-tight">Plan, track and ship, together.</h1>
          <p className="mt-4 text-base text-brand-100">
            A multi-tenant project management platform with boards, sprints, workflows and billing for every team.
          </p>
          <div className="mt-8 space-y-2.5">
            {demoCards.map((card, i) => (
              <div
                key={card.key}
                style={{ animationDelay: `${i * 120}ms`, marginLeft: `${i * 28}px` }}
                className="animate-slide-up flex max-w-sm items-center gap-3 rounded-xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur"
              >
                <span className={`size-2.5 rounded-full ${card.color}`} />
                <span className="text-xs font-semibold text-brand-100">{card.key}</span>
                <span className="truncate text-sm">{card.title}</span>
              </div>
            ))}
          </div>
          <div className="mt-10 grid grid-cols-2 gap-5">
            {features.map(({ icon: Icon, title, text }) => (
              <div key={title}>
                <Icon className="mb-2 size-5 text-brand-200" />
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-brand-100/80">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="animate-slide-up w-full max-w-sm">
          <Logo className="mb-8 text-lg lg:hidden" />
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}
