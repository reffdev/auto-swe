/**
 * Single source of truth for all app route paths.
 * Used by main.tsx (router) and tests (renderWithRouter).
 */
export const ROUTE_PATHS = [
  '/',
  '/project/:projectId',
  '/project/:projectId/issue/:issueId',
  '/project/:projectId/planner/:conversationId?',
  '/project/:projectId/settings',
  '/project/:projectId/llm-logs',
  '/machine/:machineId',
] as const;
