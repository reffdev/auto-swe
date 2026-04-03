import { useState, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePoll } from './usePoll'
import { Sidebar } from './Sidebar'
import { IssueList } from './IssueList'
import { IssueDetail } from './IssueDetail'
import { MachineDetail } from './MachineDetail'
import { DashboardLanding } from './DashboardLanding'
import { Planner } from './Planner'
import { ProjectSettings } from './ProjectSettings'
import { LlmLogs } from './LlmLogs'
import { AnalysisView } from './AnalysisView'
import { ForemanDashboard } from './ForemanDashboard'
import { ForemanTaskDetail } from './ForemanTaskDetail'
import { ForemanConfig } from './ForemanConfig'
import { DirectorDashboard } from './DirectorDashboard'
import { DirectorConversation } from './DirectorConversation'
import { DirectorReview } from './DirectorReview'
import { ProjectOverview } from './ProjectOverview'
import { TerminalView } from './Terminal'
import { ManualCommits } from './ManualCommits'
import type { Issue, Run } from './api'
import type { ViewName } from './routes'

export function DashboardLayout({ view }: { view: ViewName }) {
  const { projectId, issueId, machineId, conversationId, taskId, directiveId, reviewId } = useParams<{
    projectId?: string
    issueId?: string
    machineId?: string
    conversationId?: string
    taskId?: string
    directiveId?: string
    reviewId?: string
  }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const selectedProjectId = projectId ?? null
  const selectedIssueId = issueId ?? null
  const selectedMachineId = machineId ?? null

  // Status filter: read from URL, write to URL — single source of truth, no effects
  const statusFilter = searchParams.get('status') ?? 'all'
  const setStatusFilter = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') next.delete('status')
    else next.set('status', value)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const { data, error, loading, refresh } = usePoll(selectedProjectId ?? undefined)

  const projects = data?.projects ?? []
  const machines = data?.machines ?? []
  const issues = data?.issues ?? []
  const runs = data?.runs ?? []

  // Build a run lookup by issue id (latest run per issue)
  const runByIssue = new Map<string, Run>()
  for (const run of runs) {
    const existing = runByIssue.get(run.issue_id)
    if (!existing || run.created_at > existing.created_at) {
      runByIssue.set(run.issue_id, run)
    }
  }

  // Filter issues by status
  const filteredIssues = statusFilter === 'all'
    ? issues
    : issues.filter((i) => i.status === statusFilter || (statusFilter === 'failed' && i.status === 'cancelled'))

  // Keep the last known issue so the detail view doesn't flicker
  const [lastIssue, setLastIssue] = useState<Issue | null>(null)
  const freshIssue = issues.find((i) => i.id === selectedIssueId) ?? null
  if (freshIssue && freshIssue !== lastIssue) {
    setLastIssue(freshIssue)
  }
  const selectedIssue = selectedIssueId ? (freshIssue ?? lastIssue) : null
  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null
  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null

  return (
    <TooltipProvider>
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        projects={projects}
        machines={machines}
        issues={issues}
        selectedProjectId={selectedProjectId}
        selectedMachineId={selectedMachineId}
        onSelectProject={(id) => {
          if (id) void navigate(`/project/${id}/overview`)
          else void navigate('/')
        }}
        onSelectMachine={(id) => {
          if (id) void navigate(`/machine/${id}`)
          else void navigate('/')
        }}
        onDataChange={refresh}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {error && (
          <div className="px-6 py-2 bg-destructive/10 text-destructive text-sm">
            API error: {error}
          </div>
        )}

        {loading && !data && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
        )}

        {!loading || data ? (() => {
          switch (view) {
            case 'landing':
              return <DashboardLanding counts={{ projects: projects.length, machines: machines.length, issues: issues.length }} onRefresh={refresh} />
            case 'project-overview':
              return selectedProjectId ? <ProjectOverview projectId={selectedProjectId} onDataChange={refresh} /> : null
            case 'issue-list':
              return <IssueList issues={filteredIssues} runByIssue={runByIssue} statusFilter={statusFilter} onStatusFilter={setStatusFilter} onSelectIssue={(id) => navigate(`/project/${selectedProjectId}/issue/${id}`)} projectId={selectedProjectId!} onDataChange={refresh} />
            case 'issue-detail':
              return selectedIssue ? <IssueDetail issue={selectedIssue} runs={runs.filter(r => r.issue_id === selectedIssue.id)} onBack={() => navigate(`/project/${selectedProjectId}`)} onDataChange={refresh} /> : null
            case 'planner':
              return selectedProjectId ? <Planner projectId={selectedProjectId} conversationId={conversationId} /> : null
            case 'settings':
              return selectedProject ? <ProjectSettings project={selectedProject} onBack={() => navigate(`/project/${selectedProjectId}`)} onDataChange={refresh} /> : null
            case 'llm-logs':
              return selectedProjectId ? <LlmLogs projectId={selectedProjectId} /> : null
            case 'analysis':
              return selectedProjectId ? <AnalysisView projectId={selectedProjectId} /> : null
            case 'machine-detail':
              return selectedMachine ? <MachineDetail machine={selectedMachine} onBack={() => navigate('/')} onDataChange={refresh} /> : null
            case 'foreman-dashboard':
              return <ForemanDashboard />
            case 'foreman-task-detail':
              return taskId ? <ForemanTaskDetail taskId={taskId} onBack={() => navigate('/foreman')} /> : null
            case 'foreman-config':
              return <ForemanConfig />
            case 'director-dashboard':
              return <DirectorDashboard />
            case 'director-detail':
              // For now, director detail shows the dashboard with the directive selected
              // TODO: dedicated directive detail view with milestone timeline
              return <DirectorDashboard />
            case 'director-conversation':
              return directiveId ? <DirectorConversation directiveId={directiveId} onBack={() => navigate('/director')} /> : null
            case 'director-review':
              return reviewId ? <DirectorReview reviewId={reviewId} onBack={() => navigate('/director')} onNavigateReview={(id) => navigate(`/director/review/${id}`)} /> : null
            case 'manual-commits':
              return projectId ? <ManualCommits projectId={projectId} onBack={() => navigate('/director')} /> : null
            case 'terminal':
              return <TerminalView projectId={projectId ?? ''} onBack={() => navigate('/')} />
          }
        })() : null}
      </main>
    </div>
    </TooltipProvider>
  )
}

/** @deprecated Use DashboardLayout — kept for test compatibility */
export const Dashboard = DashboardLayout as unknown as React.FC
