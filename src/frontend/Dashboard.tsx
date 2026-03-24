import { useState } from 'react'
import { usePoll } from './usePoll'
import { Sidebar } from './Sidebar'
import { IssueList } from './IssueList'
import { IssueDetail } from './IssueDetail'
import { MachineDetail } from './MachineDetail'
import type { Run } from './api'

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

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null
  const selectedRun = selectedIssue ? runByIssue.get(selectedIssue.id) ?? null : null
  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null

  // Determine what to show in the main panel
  const showMachineDetail = selectedMachine && !selectedIssue
  const showIssueDetail = selectedIssue
  const showIssueList = data && selectedProjectId && !selectedIssue && !showMachineDetail
  const showEmpty = data && !selectedProjectId && !showMachineDetail

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
            run={selectedRun}
            onBack={() => setSelectedIssueId(null)}
            onDataChange={refresh}
          />
        )}
      </main>
    </div>
  )
}
