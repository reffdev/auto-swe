import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { Dashboard } from './Dashboard'
import { ROUTE_PATHS } from './routes'

const router = createHashRouter(
  ROUTE_PATHS.map(path => ({ path, element: <Dashboard /> }))
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
