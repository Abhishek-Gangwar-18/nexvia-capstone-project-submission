import {
  ArrowRight, Bell, Building, ChartColumn, Check, ChevronDown, Container, CreditCard, Database, GitBranch, Lock, Menu,
  MessageSquareText, Moon, MousePointer2, Rocket, ScrollText, Server, ShieldCheck, Sparkles, SquareKanban,
  Sun, Users, Webhook, Workflow, X, Zap, type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "@/components/ui/Misc";
import { ROLES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useResolvedTheme, useUI } from "@/store/ui";
import type { Role } from "@/types";

/* ------------------------------------------------------------------ content */

const NAV = [
  { id: "features", label: "Features" },
  { id: "workspaces", label: "Workspaces" },
  { id: "how", label: "How it works" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" },
];

const HIGHLIGHTS = [
  { value: "100%", label: "tenant-isolated data" },
  { value: "4", label: "roles, from owner to viewer" },
  { value: "3", label: "plans with Stripe billing" },
  { value: "24/7", label: "background jobs & webhooks" },
];

const FEATURES: { icon: LucideIcon; title: string; text: string; tint: string; wide?: boolean }[] = [
  {
    icon: SquareKanban, title: "Drag-and-drop Kanban", wide: true, tint: "from-brand-500 to-violet-500",
    text: "Move cards across and within columns. The board updates instantly, respects WIP limits, and snaps a card back if the move isn't allowed.",
  },
  {
    icon: Rocket, title: "Backlog & sprints", tint: "from-emerald-500 to-teal-500",
    text: "Plan, start and complete sprints. Drag work from the backlog; unfinished issues carry over.",
  },
  {
    icon: Workflow, title: "Custom workflows", tint: "from-sky-500 to-cyan-500",
    text: "Your own statuses per project, with rules for which moves are allowed. The board dims blocked columns.",
  },
  {
    icon: MessageSquareText, title: "Comments & files", tint: "from-pink-500 to-rose-500",
    text: "Discuss with @mentions, attach files with private downloads, and see the full history of every issue.",
  },
  {
    icon: Webhook, title: "Webhooks & notifications", tint: "from-amber-500 to-orange-500",
    text: "Signed webhooks with retries, an in-app bell, email for mentions and assignments, plus daily digests.",
  },
  {
    icon: ChartColumn, title: "Reports & dashboards", wide: true, tint: "from-indigo-500 to-blue-500",
    text: "Burndown, velocity and workspace summaries built in the background and exported as CSV, plus a live dashboard of trends, workload and sprint progress.",
  },
  {
    icon: ScrollText, title: "Audit log", tint: "from-slate-500 to-slate-700",
    text: "An append-only, filterable record of who changed what across the whole workspace.",
  },
  {
    icon: CreditCard, title: "Plans & billing", tint: "from-violet-500 to-fuchsia-500",
    text: "Upgrade through Stripe Checkout, manage cards and invoices in the customer portal.",
  },
];

const STEPS = [
  { icon: Building, title: "Create your workspace", text: "Sign up and get a private workspace for your company in seconds." },
  { icon: Users, title: "Invite your team", text: "Send email or link invitations and give each person the right role." },
  { icon: GitBranch, title: "Plan the work", text: "Create projects, shape the workflow and fill the first sprint from the backlog." },
  { icon: ChartColumn, title: "Ship and measure", text: "Move cards to Done, then track burndown and velocity to improve every sprint." },
];

const PLANS = [
  {
    name: "Free", price: 0, blurb: "For small teams getting started.",
    limits: ["3 active projects", "5 members", "10 MB file uploads"],
    features: ["Boards, sprints and custom workflows", "Reports and audit log", "Webhooks and email notifications"],
  },
  {
    name: "Pro", price: 29, blurb: "For growing teams shipping every week.", popular: true,
    limits: ["20 active projects", "50 members", "25 MB file uploads"],
    features: ["Everything in Free", "More projects and members", "Larger file uploads"],
  },
  {
    name: "Enterprise", price: 99, blurb: "For organisations running many teams.",
    limits: ["Unlimited projects", "Unlimited members", "100 MB file uploads"],
    features: ["Everything in Pro", "No project or member limits", "Largest file uploads"],
  },
];

const STACK: { icon: LucideIcon; name: string; role: string }[] = [
  { icon: Server, name: "Django REST Framework", role: "API" },
  { icon: Sparkles, name: "React + TypeScript", role: "Frontend" },
  { icon: Database, name: "PostgreSQL", role: "Database" },
  { icon: Zap, name: "Celery + Redis", role: "Background jobs" },
  { icon: CreditCard, name: "Stripe Billing", role: "Payments" },
  { icon: Container, name: "Docker", role: "Containers" },
  { icon: GitBranch, name: "GitHub Actions", role: "CI/CD" },
];

const FAQ = [
  {
    q: "How is each company's data kept separate?",
    a: "Every company works in its own workspace, and every record carries that workspace's id. Isolation is enforced on each request, in every database query and on every write, so one workspace can never see or reference another's data.",
  },
  {
    q: "Can one person belong to several companies?",
    a: "Yes. A user can be a member of many workspaces with a different role in each, and switch between them from the sidebar.",
  },
  {
    q: "What can each role do?",
    a: "Viewers can read everything; members create and edit issues, sprints, comments and reports; admins also manage projects, workflows, webhooks, members and the audit log; the owner also controls billing and can delete the workspace.",
  },
  {
    q: "What happens when we reach a plan limit?",
    a: "Nothing is lost. Limits only stop you adding more projects, members or larger files, and the app offers an upgrade right where you hit the limit.",
  },
  {
    q: "Is payment information stored in FlowBoard?",
    a: "No. Checkout and card management happen on Stripe's own secure pages, and FlowBoard only keeps the subscription status.",
  },
  {
    q: "Can other tools react to what happens on a board?",
    a: "Yes. Admins register webhook URLs and FlowBoard sends signed events for issue changes, with automatic retries and a delivery history.",
  },
];

/* ----------------------------------------------------------------- helpers */

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SectionHeading({ eyebrow, title, text, center = true }: { eyebrow: string; title: ReactNode; text?: ReactNode; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="text-sm font-semibold tracking-wide text-brand-600 uppercase dark:text-brand-400">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance text-slate-900 sm:text-4xl dark:text-white">{title}</h2>
      {text && <p className="mt-4 text-base leading-relaxed text-pretty text-slate-600 sm:text-lg dark:text-slate-400">{text}</p>}
    </div>
  );
}

function ThemeToggle() {
  const resolved = useResolvedTheme();
  const setTheme = useUI((s) => s.setTheme);
  const dark = resolved === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
    >
      {dark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
    </button>
  );
}

const primaryCta =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:-translate-y-0.5 hover:bg-brand-700 hover:shadow-brand-600/35 dark:bg-brand-600 dark:hover:bg-brand-500";
const secondaryCta =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

/* ----------------------------------------------------------------- header */

function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const go = (id: string) => {
    setOpen(false);
    scrollToId(id);
  };

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled || open
          ? "border-b border-slate-200/70 bg-white/80 backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-950/80"
          : "border-b border-transparent",
      )}
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="cursor-pointer text-lg text-slate-900 dark:text-white" aria-label="FlowBoard home">
          <Logo />
        </button>

        <div className="hidden items-center gap-1 lg:flex">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-white"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <Link to="/login" className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 sm:inline-flex dark:text-slate-200 dark:hover:bg-slate-800">
            Log in
          </Link>
          <Link to="/register" className="hidden items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-brand-600/20 transition hover:bg-brand-700 sm:inline-flex dark:bg-brand-600 dark:hover:bg-brand-500">
            Get started <ArrowRight className="size-4" />
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="animate-fade-in border-t border-slate-200/70 px-4 pt-2 pb-5 lg:hidden dark:border-slate-800/70">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className="block w-full cursor-pointer rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {item.label}
            </button>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link to="/login" className={cn(secondaryCta, "py-2.5")}>Log in</Link>
            <Link to="/register" className={cn(primaryCta, "py-2.5")}>Get started</Link>
          </div>
        </div>
      )}
    </header>
  );
}

/* ------------------------------------------------------------ hero visual */

type MockCard = { key: string; title: string; type: string; pts: number; who: string; color: string };

const COLUMNS: { name: string; dot: string; cards: MockCard[] }[] = [
  {
    name: "To Do", dot: "bg-slate-400",
    cards: [
      { key: "WEB-14", title: "Onboarding wizard copy", type: "bg-emerald-500", pts: 3, who: "AR", color: "bg-pink-700" },
      { key: "API-9", title: "Rate limiter for public API", type: "bg-sky-500", pts: 5, who: "BJ", color: "bg-amber-700" },
    ],
  },
  {
    name: "In Progress", dot: "bg-blue-500",
    cards: [
      { key: "WEB-12", title: "Redesign checkout flow", type: "bg-emerald-500", pts: 8, who: "DJ", color: "bg-brand-600" },
    ],
  },
  {
    name: "In Review", dot: "bg-violet-500",
    cards: [
      { key: "MOB-8", title: "Fix crash on Android 14", type: "bg-rose-500", pts: 2, who: "EM", color: "bg-teal-700" },
      { key: "WEB-10", title: "Dark mode for dashboard", type: "bg-sky-500", pts: 3, who: "JW", color: "bg-violet-700" },
    ],
  },
  {
    name: "Done", dot: "bg-emerald-500",
    cards: [
      { key: "API-4", title: "JWT refresh rotation", type: "bg-sky-500", pts: 5, who: "RC", color: "bg-rose-700" },
    ],
  },
];

function MiniCard({ card, className }: { card: MockCard; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm dark:border-slate-700/80 dark:bg-slate-800", className)}>
      <p className="text-[11px] leading-snug font-medium text-slate-800 dark:text-slate-100">{card.title}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className={cn("size-2.5 rounded-sm", card.type)} />
        <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{card.key}</span>
        <span className="ml-auto rounded bg-slate-100 px-1 text-[9px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{card.pts}</span>
        <span className={cn("flex size-4.5 items-center justify-center rounded-full text-[8px] font-bold text-white", card.color)}>{card.who}</span>
      </div>
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl sm:mt-20">
      <div className="pointer-events-none absolute -inset-x-10 -top-10 -bottom-16 rounded-[3rem] bg-gradient-to-b from-brand-500/20 via-violet-500/10 to-transparent blur-3xl" />

      <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-2xl shadow-brand-900/10 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/90 dark:shadow-black/40">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
          <span className="size-2.5 rounded-full bg-rose-400" />
          <span className="size-2.5 rounded-full bg-amber-400" />
          <span className="size-2.5 rounded-full bg-emerald-400" />
          <div className="mx-auto hidden items-center gap-1.5 rounded-md bg-white px-3 py-1 text-[11px] text-slate-500 ring-1 ring-slate-200 sm:flex dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
            <Lock className="size-3" /> flowboard.app/w/acme/projects/WEB/board
          </div>
        </div>

        <div className="flex">
          {/* sidebar */}
          <aside className="hidden w-44 shrink-0 border-r border-slate-200/80 p-3 md:block dark:border-slate-800">
            <div className="flex items-center gap-2 rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
              <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-violet-500 text-[10px] font-bold text-white">A</span>
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold text-slate-800 dark:text-slate-100">Acme Corp</p>
                <p className="text-[9px] text-slate-500">Pro plan</p>
              </div>
            </div>
            <div className="mt-3 space-y-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              {["Dashboard", "Projects", "All issues", "Reports"].map((label) => (
                <p key={label} className="rounded-md px-2 py-1.5">{label}</p>
              ))}
              <p className="px-2 pt-3 pb-1 text-[9px] font-semibold tracking-wider text-slate-400 uppercase">Projects</p>
              <p className="rounded-md bg-brand-50 px-2 py-1.5 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">Website Revamp</p>
              <p className="rounded-md px-2 py-1.5">Mobile App</p>
              <p className="rounded-md px-2 py-1.5">Platform API</p>
            </div>
          </aside>

          {/* board */}
          <div className="min-w-0 flex-1 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">WEB Sprint 3</p>
                <p className="text-[11px] text-slate-500">Oct 30 – Nov 12 · 14 issues · 64 pts</p>
              </div>
              <div className="flex -space-x-1.5">
                {["bg-brand-600", "bg-pink-700", "bg-amber-700", "bg-teal-700", "bg-violet-700"].map((c, i) => (
                  <span key={c} className={cn("flex size-6 items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 ring-white dark:ring-slate-900", c)}>
                    {["DJ", "AR", "BJ", "EM", "JW"][i]}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {COLUMNS.map((col, i) => (
                <div key={col.name} className={cn("rounded-xl bg-slate-100/80 p-2 dark:bg-slate-800/50", i > 1 && "hidden sm:block")}>
                  <div className="mb-2 flex items-center gap-1.5 px-1">
                    <span className={cn("size-2 rounded-full", col.dot)} />
                    <span className="text-[10px] font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">{col.name}</span>
                    <span className="ml-auto text-[10px] text-slate-400">{col.cards.length}</span>
                  </div>
                  <div className="space-y-2">
                    {col.cards.map((card) => <MiniCard key={card.key} card={card} />)}
                    {col.name === "In Progress" && (
                      <div className="h-[58px] rounded-lg border-2 border-dashed border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/5" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* dragged card */}
      <div className="absolute top-[46%] left-[30%] hidden w-44 -rotate-3 sm:block md:left-[42%]">
        <div className="motion-safe:animate-float">
          <MiniCard
            card={{ key: "WEB-15", title: "Add Stripe checkout to pricing", type: "bg-emerald-500", pts: 5, who: "DJ", color: "bg-brand-600" }}
            className="shadow-2xl ring-2 shadow-brand-900/20 ring-brand-500/60"
          />
          <MousePointer2 className="absolute -right-3 -bottom-4 size-6 fill-slate-900 text-white drop-shadow dark:fill-white dark:text-slate-900" />
        </div>
      </div>

      {/* floating notification */}
      <div className="absolute -top-6 -right-2 hidden w-64 lg:block xl:-right-14">
        <div className="motion-safe:animate-float rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur [animation-delay:1.5s] dark:border-slate-700 dark:bg-slate-900/95">
          <div className="flex items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
              <Bell className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900 dark:text-white">Danielle mentioned you</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">“@alex can you review WEB-12?”</p>
            </div>
          </div>
        </div>
      </div>

      {/* floating stat */}
      <div className="absolute -bottom-8 -left-2 hidden w-56 lg:block xl:-left-14">
        <div className="motion-safe:animate-float rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur [animation-delay:3s] dark:border-slate-700 dark:bg-slate-900/95">
          <p className="text-[11px] font-semibold text-slate-500">Velocity · last 4 sprints</p>
          <div className="mt-2 flex h-12 items-end gap-1.5">
            {[48, 56, 52, 64].map((v, i) => (
              <span key={i} style={{ height: `${(v / 64) * 100}%` }} className={cn("flex-1 rounded-t", i === 3 ? "bg-brand-500" : "bg-brand-200 dark:bg-brand-500/30")} />
            ))}
          </div>
          <p className="mt-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">+23% vs last sprint</p>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sections */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-24 sm:pt-40">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-brand-100),transparent_60%)] dark:bg-[radial-gradient(ellipse_at_top,rgb(99_102_241/0.18),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgb(148_163_184/0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgb(148_163_184/0.12)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)] bg-[size:48px_48px]" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="motion-safe:animate-rise mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/70 px-3 py-1 text-xs font-semibold text-brand-700 shadow-sm backdrop-blur dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full motion-safe:animate-ping rounded-full bg-brand-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
            </span>
            Multi-tenant project management for every team
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-balance text-slate-900 sm:text-6xl dark:text-white">
            Plan, track and ship.{" "}
            <span className="bg-gradient-to-r from-brand-600 via-violet-600 to-fuchsia-500 bg-clip-text text-transparent dark:from-brand-400 dark:via-violet-400 dark:to-fuchsia-400">
              Every company in its own workspace.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-pretty text-slate-600 dark:text-slate-400">
            FlowBoard gives each company a private, isolated workspace with Kanban boards, sprints, custom workflows,
            automation and billing, so teams can focus on shipping instead of managing tools.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/register" className={primaryCta}>
              Start for free <ArrowRight className="size-4" />
            </Link>
            <Link to="/login" className={secondaryCta}>
              <Sparkles className="size-4 text-brand-500" /> Try the live demo
            </Link>
          </div>
          <p className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-slate-500 dark:text-slate-400">
            {["Free plan forever", "No credit card required", "Set up in minutes"].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <Check className="size-4 text-emerald-500" /> {t}
              </span>
            ))}
          </p>
        </div>

        <div className="motion-safe:animate-rise [animation-delay:200ms]">
          <ProductPreview />
        </div>
      </div>
    </section>
  );
}

function Highlights() {
  return (
    <section className="border-y border-slate-200/70 bg-white/60 dark:border-slate-800/70 dark:bg-slate-900/40">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 py-12 sm:px-6 lg:grid-cols-4 lg:px-8">
        {HIGHLIGHTS.map((h) => (
          <div key={h.label} className="text-center">
            <p className="bg-gradient-to-b from-slate-900 to-slate-600 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent dark:from-white dark:to-slate-400">
              {h.value}
            </p>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{h.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Features"
          title="Everything a team needs to go from idea to done"
          text="One place for planning, tracking, collaborating and reporting, with the automation and controls growing companies expect."
        />
        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, text, tint, wide }) => (
            <div
              key={title}
              className={cn(
                "group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700",
                wide && "lg:col-span-2",
              )}
            >
              <div className={cn("pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-gradient-to-br opacity-0 blur-2xl transition duration-500 group-hover:opacity-20", tint)} />
              <span className={cn("inline-flex size-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg", tint)}>
                <Icon className="size-5" />
              </span>
              <h3 className="mt-5 text-base font-semibold text-slate-900 dark:text-white">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const TENANTS = [
  { name: "Acme Corp", plan: "Pro", projects: ["WEB", "MOB", "API"], grad: "from-brand-500 to-violet-500" },
  { name: "Globex", plan: "Free", projects: ["CP", "DATA"], grad: "from-orange-500 to-rose-500" },
  { name: "Initech", plan: "Enterprise", projects: ["PAY", "OPS"], grad: "from-emerald-500 to-teal-500" },
];

function Workspaces() {
  const roles: Role[] = ["owner", "admin", "member", "viewer"];
  return (
    <section id="workspaces" className="relative scroll-mt-20 overflow-hidden bg-slate-900 py-24 text-white sm:py-32 dark:bg-slate-900/60">
      <div className="pointer-events-none absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-brand-600/25 blur-3xl" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-16 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="text-sm font-semibold tracking-wide text-brand-300 uppercase">Built for multi-tenancy</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">Your workspace. Your data. Nobody else's.</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-300">
            Every company gets an isolated workspace. Data is scoped to it on every request, every query and every write,
            and records from other companies simply don't exist from your point of view.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              { icon: ShieldCheck, text: "Isolation enforced in three layers: request, database query and write." },
              { icon: Lock, text: "Secure sign-in with rotating tokens, logout revocation and brute-force protection." },
              { icon: Users, text: "One account can join many workspaces, with a different role in each." },
              { icon: ScrollText, text: "Every change lands in a workspace-wide audit log." },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                  <Icon className="size-4 text-brand-300" />
                </span>
                <span className="text-slate-200">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {TENANTS.map((t) => (
              <div key={t.name} className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur transition hover:bg-white/10">
                <div className="flex items-center gap-2.5">
                  <span className={cn("flex size-9 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-bold", t.grad)}>{t.name[0]}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{t.name}</p>
                    <p className="text-xs text-slate-300">{t.plan} plan</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {t.projects.map((p) => (
                    <span key={p} className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-slate-200">{p}</span>
                  ))}
                </div>
                <p className="mt-4 flex items-center gap-1 text-[11px] text-emerald-300">
                  <Lock className="size-3" /> Isolated
                </p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
            <p className="text-sm font-semibold">Roles inside every workspace</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {roles.map((role) => {
                const { icon: Icon, label, description } = ROLES[role];
                return (
                  <div key={role} className="flex gap-3 rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
                    <Icon className="mt-0.5 size-4 shrink-0 text-brand-300" />
                    <div>
                      <p className="text-sm font-semibold">{label}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="How it works" title="Up and running in four steps" text="From sign-up to your first finished sprint, without setup headaches." />
        <ol className="relative mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          <li aria-hidden="true" className="pointer-events-none absolute top-7 right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-transparent via-brand-300 to-transparent lg:block dark:via-brand-500/40"></li>
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="relative text-center">
              <span className="relative mx-auto flex size-14 items-center justify-center rounded-2xl bg-white text-brand-600 shadow-lg ring-1 shadow-brand-900/5 ring-slate-200 dark:bg-slate-900 dark:text-brand-400 dark:ring-slate-800">
                <Icon className="size-6" />
                <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white dark:bg-brand-600">{i + 1}</span>
              </span>
              <h3 className="mt-6 text-base font-semibold text-slate-900 dark:text-white">{title}</h3>
              <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-slate-600 dark:text-slate-400">{text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-20 border-t border-slate-200/70 bg-white/60 py-24 sm:py-32 dark:border-slate-800/70 dark:bg-slate-900/30">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple plans that grow with your team"
          text="Start free and upgrade when you need more. Every plan includes boards, sprints, workflows, reports and automation."
        />
        <div className="mx-auto mt-16 grid max-w-5xl gap-6 lg:grid-cols-3 lg:items-center">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative rounded-3xl p-8 transition duration-300",
                plan.popular
                  ? "bg-gradient-to-b from-brand-600 to-violet-700 text-white shadow-2xl shadow-brand-600/30 lg:scale-105"
                  : "border border-slate-200 bg-white shadow-sm hover:-translate-y-1 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900",
              )}
            >
              {plan.popular && (
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-300 to-orange-400 px-3 py-1 text-xs font-bold text-amber-950 shadow">
                  Most popular
                </span>
              )}
              <h3 className={cn("text-lg font-semibold", !plan.popular && "text-slate-900 dark:text-white")}>{plan.name}</h3>
              <p className={cn("mt-1 text-sm", plan.popular ? "text-brand-100" : "text-slate-500 dark:text-slate-400")}>{plan.blurb}</p>
              <p className="mt-6 flex items-baseline gap-1">
                <span className={cn("text-5xl font-extrabold tracking-tight", !plan.popular && "text-slate-900 dark:text-white")}>${plan.price}</span>
                <span className={cn("text-sm", plan.popular ? "text-brand-100" : "text-slate-500")}>/ month</span>
              </p>
              <Link
                to="/register"
                className={cn(
                  "mt-8 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition",
                  plan.popular
                    ? "bg-white text-brand-700 shadow-lg hover:bg-brand-50"
                    : "bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200",
                )}
              >
                {plan.price === 0 ? "Start for free" : `Choose ${plan.name}`} <ArrowRight className="size-4" />
              </Link>
              <div className={cn("my-8 h-px", plan.popular ? "bg-white/20" : "bg-slate-200 dark:bg-slate-800")} />
              <ul className="space-y-3 text-sm">
                {[...plan.limits, ...plan.features].map((item, i) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className={cn("mt-0.5 size-4 shrink-0", plan.popular ? "text-emerald-300" : "text-emerald-500")} />
                    <span className={cn(i < plan.limits.length && "font-semibold", plan.popular ? "text-white" : "text-slate-700 dark:text-slate-300")}>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-12 flex items-center justify-center gap-2 text-center text-sm text-slate-500 dark:text-slate-400">
          <CreditCard className="size-4" /> Secure payments by Stripe. Upgrade, downgrade or cancel anytime from the billing portal.
        </p>
      </div>
    </section>
  );
}

function TechStack() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="text-center text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Built on a production-grade stack
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {STACK.map(({ icon: Icon, name, role }) => (
            <div
              key={name}
              className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-brand-500/50"
            >
              <Icon className="size-4 text-brand-600 dark:text-brand-400" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{name}</span>
              <span className="text-xs text-slate-400">· {role}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="FAQ" title="Questions, answered" />
        <div className="mt-12 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {FAQ.map((item, i) => {
            const isOpen = open === i;
            return (
              <div key={item.q}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 px-6 py-5 text-left"
                >
                  <span className="text-sm font-semibold text-slate-900 sm:text-base dark:text-white">{item.q}</span>
                  <ChevronDown className={cn("size-5 shrink-0 text-slate-400 transition-transform duration-300", isOpen && "rotate-180 text-brand-500")} />
                </button>
                <div className={cn("grid transition-all duration-300", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                  <div className="overflow-hidden">
                    <p className="px-6 pb-5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{item.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-4 pb-24 sm:px-6 lg:px-8">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-violet-800 px-6 py-16 text-center shadow-2xl shadow-brand-900/20 sm:px-16">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-fuchsia-400/20 blur-3xl" />
        <div className="relative">
          <h2 className="text-3xl font-bold tracking-tight text-balance text-white sm:text-4xl">Ready to bring your team onto one board?</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-brand-100">
            Create a free workspace in minutes, or explore a fully loaded demo company right now.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/register" className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-700 shadow-lg transition hover:-translate-y-0.5 hover:bg-brand-50">
              Create your workspace <ArrowRight className="size-4" />
            </Link>
            <Link to="/login" className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white ring-1 ring-white/30 transition hover:-translate-y-0.5 hover:bg-white/10">
              <Sparkles className="size-4" /> Explore the demo
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200/70 dark:border-slate-800/70">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-4 py-10 sm:flex-row sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-2 sm:items-start">
          <span className="text-slate-900 dark:text-white"><Logo /></span>
          <p className="text-sm text-slate-500">Multi-tenant project management for modern teams.</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-500 dark:text-slate-400">
          {NAV.map((item) => (
            <button key={item.id} type="button" onClick={() => scrollToId(item.id)} className="cursor-pointer transition hover:text-slate-900 dark:hover:text-white">
              {item.label}
            </button>
          ))}
          <Link to="/login" className="transition hover:text-slate-900 dark:hover:text-white">Log in</Link>
        </div>
      </div>
      <div className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-400 dark:border-slate-800/70">
        © {new Date().getFullYear()} FlowBoard. All rights reserved.
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------- page */

export default function LandingPage() {
  useEffect(() => {
    document.title = "FlowBoard · Multi-tenant project management";
    return () => {
      document.title = "FlowBoard";
    };
  }, []);

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header />
      <main>
        <Hero />
        <Highlights />
        <Features />
        <Workspaces />
        <HowItWorks />
        <Pricing />
        <TechStack />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
