import { Link, useLocation } from "wouter";
import { BarChart3, Zap, FileText, Settings, Activity, Trophy } from "lucide-react";

const navItems = [
  { path: "/", icon: BarChart3, label: "Dashboard" },
  { path: "/signals", icon: Activity, label: "Signals" },
  { path: "/analyses", icon: FileText, label: "Analyses" },
  { path: "/scorecard", icon: Trophy, label: "Scorecard" },
  { path: "/setup", icon: Settings, label: "Setup" },
];

export default function Sidebar() {
  const [location] = useLocation();

  return (
    <aside className="w-16 lg:w-56 flex-shrink-0 bg-card border-r border-border flex flex-col">
      {/* Logo */}
      <div className="h-14 flex items-center px-3 lg:px-4 border-b border-border gap-3">
        <div className="w-8 h-8 flex-shrink-0">
          <svg viewBox="0 0 32 32" fill="none" aria-label="NQ Analyst" className="w-8 h-8">
            <rect width="32" height="32" rx="6" fill="hsl(220 12% 14%)" />
            {/* Chart line */}
            <polyline
              points="4,22 9,16 14,19 20,10 28,13"
              stroke="var(--color-bull)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            {/* Signal dot */}
            <circle cx="28" cy="13" r="2.5" fill="var(--color-bull)" />
          </svg>
        </div>
        <div className="hidden lg:block">
          <div className="text-sm font-bold tracking-tight text-foreground">NQ Analyst</div>
          <div className="text-xs text-muted-foreground font-mono">ICT · AI</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map(({ path, icon: Icon, label }) => {
          const active = location === path;
          return (
            <Link key={path} href={path}>
              <a
                className={`flex items-center gap-3 px-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
                data-testid={`nav-${label.toLowerCase()}`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="hidden lg:block">{label}</span>
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Status indicator */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="hidden lg:block text-xs text-muted-foreground font-mono">NQ1! LIVE</span>
        </div>
      </div>
    </aside>
  );
}
