/**
 * Single source of truth for all app route paths.
 * Used by main.tsx (router) and tests (renderWithRouter).
 */
export const ROUTE_PATHS = [
  '/',
  '/project/:projectId/overview',
  '/project/:projectId',
  '/project/:projectId/issue/:issueId',
  '/project/:projectId/planner/:conversationId?',
  '/project/:projectId/settings',
  '/project/:projectId/llm-logs',
  '/project/:projectId/analysis',
  '/machine/:machineId',
  '/foreman',
  '/foreman/task/:taskId',
  '/foreman/config',
  '/director',
  '/director/:directiveId',
  '/director/:directiveId/conversation',
  '/director/review/:reviewId',
  '/terminal/:projectId',
] as const;

/** Route names for view discrimination */
export type ViewName =
  | 'landing'
  | 'project-overview'
  | 'issue-list'
  | 'issue-detail'
  | 'planner'
  | 'settings'
  | 'llm-logs'
  | 'analysis'
  | 'machine-detail'
  | 'foreman-dashboard'
  | 'foreman-task-detail'
  | 'foreman-config'
  | 'director-dashboard'
  | 'director-detail'
  | 'director-conversation'
  | 'director-review'
  | 'terminal'
