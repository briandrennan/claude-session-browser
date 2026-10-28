import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { Moon, Sun, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem('theme')
    if (t === 'light' || t === 'dark') return t
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function AppShell() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* storage unavailable */
    }
  }, [theme])

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Terminal className="size-5 text-[var(--series-2)]" />
            Session Browser
          </Link>
          <nav className="ml-4 flex items-center gap-1 text-sm">
            {[
              ['/', 'Usage'],
              ['/pricing', 'Pricing'],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  `rounded-md px-2.5 py-1 ${isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
