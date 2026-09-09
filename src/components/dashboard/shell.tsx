'use client'

/**
 * GamificationOG — Dashboard Shell.
 * Sidebar navigation with progressive disclosure (Section 107), auth guard,
 * environment/project scope switcher, and responsive mobile drawer.
 */
import { useEffect, useState, ReactNode, Suspense, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Zap, GitBranch, Trophy, Target, Flame, Gift, Coins,
  Package, BarChart3, Users, PieChart, Activity, ScrollText, FlaskConical,
  Settings, Blocks, LogOut, Gamepad2, ShieldCheck, ChevronDown, Menu, Loader2, CreditCard,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/client-api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/sonner-bridge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  hint?: string
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    title: 'Live Data',
    items: [
      { href: '/events', label: 'Events', icon: Zap, hint: 'Ingestion feed' },
      { href: '/traces', label: 'Decision Traces', icon: Activity, hint: 'Engine transparency' },
      { href: '/playground', label: 'Playground', icon: Gamepad2, hint: 'Simulate events' },
    ],
  },
  {
    title: 'Engagement',
    items: [
      { href: '/rules', label: 'Rules', icon: GitBranch, hint: 'WHEN / IF / THEN' },
      { href: '/packs', label: 'Packs', icon: Package, hint: 'Behavior bundles' },
      { href: '/challenges', label: 'Challenges', icon: Target },
      { href: '/achievements', label: 'Achievements', icon: Trophy },
      { href: '/streaks', label: 'Streaks', icon: Flame },
    ],
  },
  {
    title: 'Economy & Rewards',
    items: [
      { href: '/rewards', label: 'Rewards', icon: Gift },
      { href: '/economy', label: 'Economy', icon: Coins, hint: 'Ledger & wallets' },
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/leaderboards', label: 'Leaderboards', icon: BarChart3 },
    ],
  },
  {
    title: 'Targeting',
    items: [
      { href: '/segments', label: 'Segments', icon: PieChart },
      { href: '/experiments', label: 'Experiments & Flags', icon: FlaskConical },
      { href: '/monetization', label: 'Monetization', icon: CreditCard, hint: 'Offers · paywalls · subscriptions' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { href: '/users', label: 'Users', icon: Users },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/audit', label: 'Audit Log', icon: ScrollText },
    ],
  },
  {
    title: 'Platform',
    items: [
      { href: '/registry', label: 'Capabilities', icon: Blocks },
      { href: '/settings', label: 'Settings', icon: Settings, hint: 'API keys' },
    ],
  },
]

interface ScopeInfo {
  scope: {
    projectId: string
    environmentId: string
    projectName: string
    environmentName: string
    environments?: Array<{ id: string; name: string }>
  } | null
  organizations: Record<string, {
    name: string
    workspaces: Record<string, {
      name: string
      projects: Array<{ id: string; name: string; environments: Array<{ id: string; name: string }> }>
    }>
  }>
}

function envBadgeColor(name: string) {
  switch (name) {
    case 'production': return 'bg-red-500/10 text-red-600 border-red-500/30'
    case 'staging': return 'bg-amber-500/10 text-amber-600 border-amber-500/30'
    default: return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
  }
}

// ---------------------------------------------------------------------------
// Module-level components (never created during render)
// ---------------------------------------------------------------------------
function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-5 px-3 py-4 overflow-y-auto flex-1" aria-label="Main navigation">
      {NAV_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group.title}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors min-h-[36px]',
                    active
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.hint && (
                    <span className="ml-auto hidden xl:inline text-[10px] text-muted-foreground/50 group-hover:text-muted-foreground">
                      {item.hint}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

function ScopeSwitcher({ scopeInfo, onSwitch }: {
  scopeInfo: ScopeInfo | null
  onSwitch: (projectId: string, environmentId: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted transition-colors min-h-[36px]">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium max-w-[140px] truncate">
            {scopeInfo?.scope?.projectName ?? 'No project'}
          </span>
          {scopeInfo?.scope?.environmentName && (
            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', envBadgeColor(scopeInfo.scope.environmentName))}>
              {scopeInfo.scope.environmentName}
            </Badge>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-h-[70vh] overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Organization / Workspace / Project
        </DropdownMenuLabel>
        {Object.entries(scopeInfo?.organizations ?? {}).map(([orgName, org]) =>
          Object.entries(org.workspaces).map(([wsName, ws]) => (
            <div key={`${orgName}-${wsName}`}>
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground/70 py-1">
                {orgName} — {wsName}
              </DropdownMenuLabel>
              {ws.projects.map((p) => (
                p.environments.map((env) => (
                  <DropdownMenuItem
                    key={env.id}
                    onClick={() => onSwitch(p.id, env.id)}
                    className={cn(
                      'gap-2 py-1.5',
                      scopeInfo?.scope?.projectId === p.id && scopeInfo?.scope?.environmentId === env.id && 'bg-primary/10',
                    )}
                  >
                    <span className="flex-1 truncate text-sm">{p.name}</span>
                    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', envBadgeColor(env.name))}>
                      {env.name}
                    </Badge>
                  </DropdownMenuItem>
                ))
              ))}
            </div>
          )),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardShell({ children, title, subtitle }: {
  children: ReactNode
  title: string
  subtitle?: string
}) {
  const router = useRouter()
  const [scopeInfo, setScopeInfo] = useState<ScopeInfo | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiGet<ScopeInfo>('/api/admin/scope')
      .then((data) => { if (!cancelled) setScopeInfo(data) })
      .catch(() => { if (!cancelled) setScopeInfo(null) })
    return () => { cancelled = true }
  }, [])

  const switchScope = useCallback(async (projectId: string, environmentId: string) => {
    await apiPost('/api/admin/scope', { projectId, environmentId })
    toast.success('Scope switched — reloading data')
    router.refresh()
    setTimeout(() => window.location.reload(), 400)
  }, [router])

  const logout = useCallback(async () => {
    await apiPost('/api/admin/auth/logout')
    window.location.href = '/login'
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar */}
        <aside className="hidden lg:flex flex-col w-64 shrink-0 border-r bg-card/50 backdrop-blur">
          <div className="flex items-center gap-2 px-4 h-14 border-b">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Gamepad2 className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="leading-tight">
              <p className="font-semibold text-sm">GamificationOG</p>
              <p className="text-[10px] text-muted-foreground">Engagement OS</p>
            </div>
          </div>
          <Nav />
          <div className="border-t p-3">
            <ScopeSwitcher scopeInfo={scopeInfo} onSwitch={switchScope} />
          </div>
        </aside>

        {/* Main column */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-30 flex items-center gap-3 h-14 border-b bg-background/80 backdrop-blur px-4 lg:px-6">
            {/* Mobile nav */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0 flex flex-col">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <div className="flex items-center gap-2 px-4 h-14 border-b">
                  <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Gamepad2 className="h-4 w-4 text-primary" />
                  </div>
                  <p className="font-semibold text-sm">GamificationOG</p>
                </div>
                <Nav onNavigate={() => setMobileOpen(false)} />
                <div className="border-t p-3">
                  <ScopeSwitcher scopeInfo={scopeInfo} onSwitch={switchScope} />
                </div>
              </SheetContent>
            </Sheet>

            <div className="min-w-0">
              <h1 className="font-semibold text-base lg:text-lg leading-tight truncate">{title}</h1>
              {subtitle && <p className="text-xs text-muted-foreground truncate hidden sm:block">{subtitle}</p>}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="lg:hidden">
                <ScopeSwitcher scopeInfo={scopeInfo} onSwitch={switchScope} />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-9 w-9 rounded-full" aria-label="Account menu">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">OG</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                    <LogOut className="h-4 w-4 mr-2" /> Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <main className="flex-1 p-4 lg:p-6 min-w-0">
            <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
              {children}
            </Suspense>
          </main>

          <footer className="border-t px-4 lg:px-6 py-3 text-[11px] text-muted-foreground/60 mt-auto">
            GamificationOG — configuration-first, event-driven engagement infrastructure
          </footer>
        </div>
      </div>
    </div>
  )
}
