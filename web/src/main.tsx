import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from '@/components/app-shell'
import { DashboardPage } from '@/pages/dashboard'
import { PricingPage } from '@/pages/pricing'
import { SessionPage } from '@/pages/session'
import './index.css'

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/sessions/:id', element: <SessionPage /> },
      { path: '/pricing', element: <PricingPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </StrictMode>,
)
