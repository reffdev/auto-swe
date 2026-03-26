import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { Dashboard } from './Dashboard'

const router = createHashRouter([
  { path: '/', element: <Dashboard /> },
  { path: '/project/:projectId', element: <Dashboard /> },
  { path: '/project/:projectId/issue/:issueId', element: <Dashboard /> },
  { path: '/project/:projectId/planner/:conversationId?', element: <Dashboard /> },
  { path: '/machine/:machineId', element: <Dashboard /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
