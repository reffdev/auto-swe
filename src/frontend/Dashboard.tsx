import { useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePoll } from './usePoll'
import { Sidebar } from './Sidebar'
import { IssueList } from './IssueList'
import { IssueDetail } from './IssueDetail'
import { MachineDetail } from './MachineDetail'
import type { Issue, Run } from './api'

export function Dashboard() {
  const { projectId, issueId, machineId } = useParams<{
    projectId?: string
    issueId?: string
    machineId?: string
  }>()
  const navigate = useNavigate()

  const selectedProjectId = projectId ?? null
  const selectedIssueId = issueId ?? null
  const selectedMachineId = machineId ?? null

  const [statusFilter, setStatusFilter] = useState<string>('all')
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
    : issues.filter((i) => i.status === statusFilter)

  // Keep a ref to the last known issue so the detail view doesn't flicker
  const lastIssueRef = useRef<Issue | null>(null)
  const freshIssue = issues.find((i) => i.id === selectedIssueId) ?? null
  if (freshIssue) lastIssueRef.current = freshIssue
  const selectedIssue = selectedIssueId ? (freshIssue ?? lastIssueRef.current) : null

  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null

  // Determine what to show in the main panel
  const showMachineDetail = selectedMachine && !selectedIssue
  const showIssueDetail = selectedIssue
  const showIssueList = data && selectedProjectId && !selectedIssue && !showMachineDetail
  const showEmpty = data && !selectedProjectId && !showMachineDetail

  return (
    <TooltipProvider>
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        projects={projects}
        machines={machines}
        selectedProjectId={selectedProjectId}
        selectedMachineId={selectedMachineId}
        onSelectProject={(id) => {
          if (id) navigate(`/project/${id}`)
          else navigate('/')
        }}
        onSelectMachine={(id) => {
          if (id) navigate(`/machine/${id}`)
          else navigate('/')
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
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Loading...
          </div>
        )}
        {showEmpty && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a project to get started
          </div>
        )}
        {showMachineDetail && selectedMachine && (
          <MachineDetail
            machine={selectedMachine}
            onBack={() => navigate('/')}
            onDataChange={refresh}
          />
        )}
        {showIssueList && (
          <IssueList
            issues={filteredIssues}
            runByIssue={runByIssue}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            onSelectIssue={(id) => navigate(`/project/${selectedProjectId}/issue/${id}`)}
            projectId={selectedProjectId!}
            onDataChange={refresh}
          />
        )}
        {showIssueDetail && selectedIssue && (
          <IssueDetail
            issue={selectedIssue}
            runs={runs.filter(r => r.issue_id === selectedIssue.id)}
            onBack={() => navigate(`/project/${selectedProjectId}`)}
            onDataChange={refresh}
          />
        )}
      </main>
    </div>
    </TooltipProvider>
  )
}
