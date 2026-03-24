import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import './index.css'
import { Dashboard } from './Dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Dashboard />
    </TooltipProvider>
  </StrictMode>,
)
