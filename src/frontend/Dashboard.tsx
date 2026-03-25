import { useState, useRef, useEffect } from 'react'
import { usePoll } from './usePoll'
import { Sidebar } from './Sidebar'
import { IssueList } from './IssueList'
import { IssueDetail } from './IssueDetail'
import { MachineDetail } from './MachineDetail'
import { useHashRouting, navigateToProject, navigateToIssue, navigateToMachine, navigateToEmpty } from './router'
import type { Issue, Run } from './api'

export function Dashboard() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)
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
  // when the issue temporarily disappears during status transitions
  const lastIssueRef = useRef<Issue | null>(null)
  const freshIssue = issues.find((i) => i.id === selectedIssueId) ?? null
  if (freshIssue) lastIssueRef.current = freshIssue
  const selectedIssue = selectedIssueId ? (freshIssue ?? lastIssueRef.current) : null

  const selectedRun = selectedIssue ? runByIssue.get(selectedIssue.id) ?? null : null
  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null

  // Determine what to show in the main panel
  const showMachineDetail = selectedMachine && !selectedIssue
  const showIssueDetail = selectedIssue
  const showIssueList = data && selectedProjectId && !selectedIssue && !showMachineDetail
  const showEmpty = data && !selectedProjectId && !showMachineDetail

  // Hash routing handler
  const handleHashNavigation = (viewState: any) => {
    switch (viewState.type) {
      case 'empty':
        setSelectedProjectId(null)
        setSelectedIssueId(null)
        setSelectedMachineId(null)
        break
      case 'project':
        setSelectedProjectId(viewState.projectId)
        setSelectedIssueId(null)
        setSelectedMachineId(null)
        break
      case 'project-issue':
        setSelectedProjectId(viewState.projectId)
        setSelectedIssueId(viewState.issueId)
        setSelectedMachineId(null)
        break
      case 'machine':
        setSelectedProjectId(null)
        setSelectedIssueId(null)
        setSelectedMachineId(viewState.machineId)
        break
    }
  }

  useHashRouting(handleHashNavigation)

  // Sync URL when selection changes
  useEffect(() => {
    if (selectedMachineId && !selectedIssueId) {
      navigateToMachine(selectedMachineId)
    } else if (selectedIssueId && selectedProjectId) {
      navigateToIssue(selectedProjectId, selectedIssueId)
    } else if (selectedProjectId) {
      navigateToProject(selectedProjectId)
    } else {
      navigateToEmpty()
    }
  }, [selectedProjectId, selectedIssueId, selectedMachineId])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        projects={projects}
        machines={machines}
        selectedProjectId={selectedProjectId}
        selectedMachineId={selectedMachineId}
        onSelectProject={(id) => {
          setSelectedProjectId(id)
          setSelectedIssueId(null)
          setSelectedMachineId(null)
        }}
        onSelectMachine={(id) => {
          setSelectedMachineId(id)
          setSelectedIssueId(null)
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
            onBack={() => setSelectedMachineId(null)}
            onDataChange={refresh}
          />
        )}
        {showIssueList && (
          <IssueList
            issues={filteredIssues}
            runByIssue={runByIssue}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            onSelectIssue={setSelectedIssueId}
            projectId={selectedProjectId!}
            onDataChange={refresh}
          />
        )}
        {showIssueDetail && selectedIssue && (
          <IssueDetail
            issue={selectedIssue}
            runs={runs.filter(r => r.issue_id === selectedIssue.id)}
            onBack={() => setSelectedIssueId(null)}
            onDataChange={refresh}
          />
        )}
      </main>
    </div>
  )
}
