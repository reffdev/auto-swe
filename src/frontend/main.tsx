import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import { DashboardLayout } from './Dashboard'
import type { ViewName } from './routes'

/** Each route maps to a view name — the layout renders the right component */
const routes: Array<{ path: string; view: ViewName }> = [
  { path: '/', view: 'landing' },
  { path: '/project/:projectId/overview', view: 'project-overview' },
  { path: '/project/:projectId', view: 'issue-list' },
  { path: '/project/:projectId/issue/:issueId', view: 'issue-detail' },
  { path: '/project/:projectId/planner/:conversationId?', view: 'planner' },
  { path: '/project/:projectId/settings', view: 'settings' },
  { path: '/project/:projectId/llm-logs', view: 'llm-logs' },
  { path: '/project/:projectId/analysis', view: 'analysis' },
  { path: '/machine/:machineId', view: 'machine-detail' },
  { path: '/foreman', view: 'foreman-dashboard' },
  { path: '/foreman/task/:taskId', view: 'foreman-task-detail' },
  { path: '/foreman/config', view: 'foreman-config' },
  { path: '/director', view: 'director-dashboard' },
  { path: '/director/review/:reviewId', view: 'director-review' },
  { path: '/director/:directiveId/conversation', view: 'director-conversation' },
  { path: '/director/:directiveId', view: 'director-detail' },
  { path: '/terminal/:projectId', view: 'terminal' },
]

const router = createHashRouter(
  routes.map(({ path, view }) => ({
    path,
    element: <DashboardLayout view={view} />,
  }))
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
