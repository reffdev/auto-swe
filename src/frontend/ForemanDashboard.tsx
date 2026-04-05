import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RefreshCw, Play, Upload, CheckCircle, XCircle, Clock, Loader2, AlertTriangle, Pause, List } from 'lucide-react'
import * as api from './api'
import type { ForemanTask, ForemanPollResponse } from './api'

const STATUS_COLORS: Record<string, string> = {
  backlog: 'text-muted-foreground bg-muted',
  queued: 'text-blue-400 bg-blue-400/10',
  running: 'text-emerald-400 bg-emerald-400/10',
  validating: 'text-yellow-400 bg-yellow-400/10',
  awaiting_review: 'text-purple-400 bg-purple-400/10',
  completed: 'text-emerald-500 bg-emerald-500/10',
  failed: 'text-destructive bg-destructive/10',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  backlog: <List className="size-3" />,
  queued: <Clock className="size-3" />,
  running: <Loader2 className="size-3 animate-spin" />,
  validating: <Loader2 className="size-3 animate-spin" />,
  awaiting_review: <Pause className="size-3" />,
  completed: <CheckCircle className="size-3" />,
  failed: <XCircle className="size-3" />,
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'P1', color: 'text-red-400' },
  2: { label: 'P2', color: 'text-orange-400' },
  3: { label: 'P3', color: 'text-muted-foreground' },
  4: { label: 'P4', color: 'text-muted-foreground/60' },
  5: { label: 'P5', color: 'text-muted-foreground/40' },
}

export function ForemanDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<ForemanPollResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await api.foremanPoll()
      setData(result)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const tasks = data?.tasks ?? []
  const activeIds = new Set(data?.activeIds ?? [])
  const config = data?.config

  const sortedTasks = [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const filteredTasks = statusFilter === 'all'
    ? sortedTasks
    : sortedTasks.filter(t => t.status === statusFilter)

  // Status counts
  const counts: Record<string, number> = {}
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await api.syncForemanYaml()
      setSyncResult(`Imported: ${result.imported}, Updated: ${result.updated}${result.errors.length ? `, Errors: ${result.errors.length}` : ''}`)
      void refresh()
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleQueueAll = async () => {
    try {
      const result = await api.queueAllForemanTasks()
      setSyncResult(`Queued ${result.queued} task(s)`)
      void refresh()
    } catch (e) {
      setSyncResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (loading && !data) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
  }

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-muted-foreground">Foreman is not configured yet.</p>
          <Button onClick={() => navigate('/foreman/config')}>Configure Foreman</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Foreman Task Queue</h2>
          <p className="text-xs text-muted-foreground">
            {config.enabled ? 'Scheduler active' : 'Scheduler paused'}
            {config.priority_mode !== 'parallel' && ` (${config.priority_mode} mode)`}
            {' '}&middot; {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <Upload className={cn("size-3.5 mr-1.5", syncing && "animate-spin")} />
            Sync YAML
          </Button>
          <Button variant="outline" size="sm" onClick={handleQueueAll}>
            <Play className="size-3.5 mr-1.5" />
            Queue All
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {syncResult && (
        <div className="px-6 py-2 bg-muted text-xs text-muted-foreground flex items-center justify-between">
          <span>{syncResult}</span>
          <button onClick={() => setSyncResult(null)} className="text-muted-foreground hover:text-foreground">&times;</button>
        </div>
      )}

      {/* Status filter tabs */}
      <div className="px-6 py-2 border-b border-border flex items-center gap-1 overflow-x-auto">
        {['all', 'backlog', 'queued', 'running', 'validating', 'awaiting_review', 'completed', 'failed'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
              statusFilter === s ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            {s === 'all' ? 'All' : s.replace('_', ' ')}
            {s === 'all' ? ` (${tasks.length})` : counts[s] ? ` (${counts[s]})` : ''}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {filteredTasks.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            {tasks.length === 0 ? 'No tasks. Sync from YAML or create manually.' : 'No tasks matching filter.'}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-6 py-2 text-left font-medium w-12">P</th>
                <th className="px-2 py-2 text-left font-medium">Title</th>
                <th className="px-2 py-2 text-left font-medium w-20">Type</th>
                <th className="px-2 py-2 text-left font-medium w-36">Model</th>
                <th className="px-2 py-2 text-left font-medium w-32">Status</th>
                <th className="px-2 py-2 text-right font-medium w-20">Retries</th>
                <th className="px-6 py-2 text-right font-medium w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map(task => (
                <TaskRow key={task.id} task={task} isActive={activeIds.has(task.id)} onNavigate={() => navigate(`/foreman/task/${task.id}`)} onRefresh={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TaskRow({ task, isActive: _isActive, onNavigate, onRefresh }: {
  task: ForemanTask; isActive: boolean; onNavigate: () => void; onRefresh: () => void
}) {
  const prio = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS[3]

  const handleAction = async (e: React.MouseEvent, action: () => Promise<unknown>) => {
    e.stopPropagation()
    try { await action(); onRefresh() } catch { /* ignore */ }
  }

  return (
    <tr
      onClick={onNavigate}
      className="border-b border-border/50 hover:bg-accent/30 cursor-pointer transition-colors text-sm"
    >
      <td className="px-6 py-2.5">
        <span className={cn('text-xs font-mono font-medium', prio.color)}>{prio.label}</span>
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center gap-2">
          {task.yaml_id && <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1 rounded">#{task.yaml_id}</span>}
          <span className="truncate">{task.title}</span>
        </div>
      </td>
      <td className="px-2 py-2.5">
        <span className="text-xs text-muted-foreground font-mono">{task.type}</span>
      </td>
      <td className="px-2 py-2.5">
        <span className="text-xs text-muted-foreground font-mono truncate block max-w-[140px]">
          {task.resolved_model ?? task.model}
        </span>
      </td>
      <td className="px-2 py-2.5">
        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', STATUS_COLORS[task.status] ?? STATUS_COLORS.backlog)}>
          {STATUS_ICONS[task.status]}
          {task.status.replace('_', ' ')}
        </span>
      </td>
      <td className="px-2 py-2.5 text-right">
        {task.retry_count > 0 && (
          <span className="text-xs text-muted-foreground">{task.retry_count}/{task.max_retries}</span>
        )}
      </td>
      <td className="px-6 py-2.5 text-right">
        <div className="flex items-center gap-1 justify-end">
          {(task.status === 'backlog' || task.status === 'failed') && (
            <Button variant="ghost" size="icon-sm" onClick={(e) => handleAction(e, () => api.queueForemanTask(task.id))} title="Queue">
              <Play className="size-3" />
            </Button>
          )}
          {task.status === 'running' && (
            <Button variant="ghost" size="icon-sm" onClick={(e) => handleAction(e, () => api.cancelForemanTask(task.id))} title="Cancel">
              <XCircle className="size-3" />
            </Button>
          )}
          {task.status === 'awaiting_review' && (
            <Button variant="ghost" size="icon-sm" onClick={(e) => handleAction(e, () => api.completeForemanTask(task.id))} title="Complete">
              <CheckCircle className="size-3" />
            </Button>
          )}
          {task.error_message && (
            <span title={task.error_message}>
              <AlertTriangle className="size-3 text-destructive" />
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}
