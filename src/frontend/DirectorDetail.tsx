import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, RefreshCw, Play, Pause, MessageSquare, Check, Clock, Loader2, X, AlertTriangle, ExternalLink, Activity } from 'lucide-react'
import * as api from './api'
import type { DirectorDirective, DirectorMilestone, ForemanTask, DirectorReview, DirectorActivityRow } from './api'

function formatActivityAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Pull a one-line summary out of the planner step's output_text. Each row's
// output is the LLM's text + any [tool_call: ...] markers — we want to show
// "tool: args (excerpt)" as a compact line. If there's no tool call, fall
// back to the leading text.
function summarizeActivity(row: DirectorActivityRow): string {
  const out = row.output ?? ''
  const m = out.match(/\[tool_call: ([^\]]+)\] ?({[^\n]*})?/)
  if (m) {
    const tool = m[1]
    const args = m[2] ?? ''
    return `${tool}${args ? ' ' + args.slice(0, 120) : ''}`
  }
  const text = out.replace(/\s+/g, ' ').trim()
  return text.slice(0, 160) || '(no output)'
}

function DirectorActivityPanel({ directiveId }: { directiveId: string }) {
  const [rows, setRows] = useState<DirectorActivityRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchActivity = async () => {
      try {
        const result = await api.getDirectorActivity(directiveId, 50)
        if (!cancelled) { setRows(result.activity); setError(null) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void fetchActivity()
    const interval = setInterval(() => { void fetchActivity() }, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [directiveId])

  if (error) {
    return (
      <div className="border-b border-border px-6 py-2 text-xs text-destructive">
        Director activity error: {error}
      </div>
    )
  }
  if (!rows) {
    return (
      <div className="border-b border-border px-6 py-2 text-xs text-muted-foreground">
        Loading Director activity...
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="border-b border-border px-6 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <Activity className="size-3" />
        No Director planner activity yet for this directive.
      </div>
    )
  }

  const visible = expanded ? rows : rows.slice(0, 8)

  return (
    <div className="border-b border-border bg-muted/5">
      <div className="px-6 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="size-3 text-emerald-400" />
          <span className="font-medium text-foreground">Director Activity</span>
          <span>· {rows.length} step{rows.length === 1 ? '' : 's'}</span>
        </div>
        {rows.length > 8 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? 'Show recent only' : `Show all ${rows.length}`}
          </button>
        )}
      </div>
      <div className="px-6 pb-2 space-y-0.5 max-h-64 overflow-y-auto">
        {visible.map(row => {
          const kindStyle =
            row.kind === 'plan' ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' :
            row.kind === 'verify-task' ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' :
            row.kind === 'verify-milestone' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' :
            'border-muted bg-muted text-muted-foreground'
          const kindLabel =
            row.kind === 'plan' ? 'plan' :
            row.kind === 'verify-task' ? 'verify' :
            row.kind === 'verify-milestone' ? 'verify-ms' :
            row.kind
          return (
            <div key={row.id} className="flex items-start gap-2 text-[11px] font-mono">
              <span className="text-muted-foreground/60 shrink-0 w-16 truncate" title={new Date(row.createdAt).toLocaleString()}>
                {formatActivityAge(row.createdAt)}
              </span>
              <span className={cn('inline-flex items-center px-1 py-0 rounded text-[9px] font-medium border shrink-0', kindStyle)}>
                {kindLabel}
              </span>
              {row.label && (
                <span className="text-foreground/70 shrink-0 max-w-[25%] truncate" title={row.label}>
                  {row.label}
                </span>
              )}
              <span className="flex-1 truncate text-foreground/90" title={row.output ?? ''}>
                {summarizeActivity(row)}
              </span>
              {row.durationMs != null && row.durationMs > 0 && (
                <span className="text-muted-foreground/60 shrink-0">{Math.round(row.durationMs / 1000)}s</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const MILESTONE_STATUS_COLORS: Record<string, string> = {
  pending: 'border-muted-foreground/30 text-muted-foreground',
  active: 'border-emerald-400 text-emerald-400',
  completed: 'border-emerald-500 text-emerald-500 bg-emerald-500/10',
  failed: 'border-destructive text-destructive',
}

const TASK_STATUS_ICONS: Record<string, React.ReactNode> = {
  queued: <Clock className="size-3 text-blue-400" />,
  running: <Loader2 className="size-3 text-emerald-400 animate-spin" />,
  awaiting_review: <AlertTriangle className="size-3 text-orange-400" />,
  completed: <Check className="size-3 text-emerald-500" />,
  failed: <X className="size-3 text-destructive" />,
  backlog: <Clock className="size-3 text-muted-foreground" />,
}

const TASK_STATUS_COLORS: Record<string, string> = {
  queued: 'text-blue-400',
  running: 'text-emerald-400',
  awaiting_review: 'text-orange-400',
  completed: 'text-emerald-500',
  failed: 'text-destructive',
  backlog: 'text-muted-foreground',
}

export function DirectorDetail({ directiveId, onBack }: { directiveId: string; onBack: () => void }) {
  const navigate = useNavigate()
  const [directive, setDirective] = useState<DirectorDirective | null>(null)
  const [milestones, setMilestones] = useState<DirectorMilestone[]>([])
  const [tasks, setTasks] = useState<ForemanTask[]>([])
  const [reviews, setReviews] = useState<DirectorReview[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.directorPoll(directiveId)
      setDirective(data.directive)
      setMilestones(data.milestones)
      setTasks(data.tasks)
      setReviews(data.reviews)

      // Auto-expand the active milestone
      const active = data.milestones.find(m => m.status === 'active')
      if (active && !expandedMilestone) setExpandedMilestone(active.id)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [directiveId, expandedMilestone])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => clearInterval(interval)
  }, [load])

  if (loading && !directive) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
  }

  if (!directive) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Directive not found</div>
  }

  const pendingReviews = reviews.filter(r => r.status === 'pending')
  const totalTasks = tasks.length
  const completedTasks = tasks.filter(t => t.status === 'completed').length
  const runningTasks = tasks.filter(t => t.status === 'running').length
  const failedTasks = tasks.filter(t => t.status === 'failed').length

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border">
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold truncate">{directive.directive}</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
              <span className={cn('font-medium', {
                'text-emerald-400': directive.status === 'active',
                'text-orange-400': directive.status === 'paused',
                'text-blue-400': directive.status === 'planning' || directive.status === 'conversing',
                'text-emerald-500': directive.status === 'completed',
                'text-destructive': directive.status === 'failed',
              })}>{directive.status}</span>
              <span>{directive.autonomy_level} autonomy</span>
              <span>Created {new Date(directive.created_at).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/director/${directiveId}/conversation`)} title="Conversation">
              <MessageSquare className="size-3.5" />
            </Button>
            {directive.status === 'active' && (
              <Button variant="ghost" size="icon-sm" onClick={() => { void api.pauseDirective(directiveId).then(load) }} title="Pause">
                <Pause className="size-3.5" />
              </Button>
            )}
            {directive.status === 'paused' && (
              <Button variant="ghost" size="icon-sm" onClick={() => { void api.resumeDirective(directiveId).then(load) }} title="Resume">
                <Play className="size-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={load}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Summary bar */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{milestones.length} milestone{milestones.length !== 1 ? 's' : ''}</span>
          <span>{completedTasks}/{totalTasks} tasks done</span>
          {runningTasks > 0 && <span className="text-emerald-400">{runningTasks} running</span>}
          {failedTasks > 0 && <span className="text-destructive">{failedTasks} failed</span>}
          {pendingReviews.length > 0 && <span className="text-orange-400">{pendingReviews.length} review{pendingReviews.length !== 1 ? 's' : ''}</span>}
          {totalTasks > 0 && (
            <div className="flex-1 max-w-xs">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((completedTasks / totalTasks) * 100)}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live Director activity (planner steps) */}
      <DirectorActivityPanel directiveId={directiveId} />

      {/* Pending reviews */}
      {pendingReviews.length > 0 && (
        <div className="px-6 py-2 bg-orange-500/10 border-b border-orange-500/20">
          <div className="flex items-center gap-2 text-xs text-orange-400 mb-1">
            <AlertTriangle className="size-3" />
            <span className="font-medium">{pendingReviews.length} review{pendingReviews.length !== 1 ? 's' : ''} pending</span>
          </div>
          {pendingReviews.map(r => (
            <button key={r.id} onClick={() => navigate(`/director/review/${r.id}`)}
              className="block text-xs text-muted-foreground hover:text-foreground transition-colors truncate w-full text-left py-0.5">
              {r.question}
            </button>
          ))}
        </div>
      )}

      {/* Milestones + tasks */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-3">
          {milestones.map((m, i) => {
            const milestoneTasks = tasks.filter(t => t.milestone_id === m.id)
            const mCompleted = milestoneTasks.filter(t => t.status === 'completed').length
            const mTotal = milestoneTasks.length
            const isExpanded = expandedMilestone === m.id

            return (
              <div key={m.id} className={cn('rounded-lg border', MILESTONE_STATUS_COLORS[m.status] ?? 'border-border')}>
                {/* Milestone header */}
                <button
                  onClick={() => setExpandedMilestone(isExpanded ? null : m.id)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3"
                >
                  <span className={cn(
                    'size-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold shrink-0',
                    m.status === 'completed' ? 'bg-emerald-500 border-emerald-500 text-white' :
                    m.status === 'active' ? 'border-emerald-400 text-emerald-400' :
                    m.status === 'failed' ? 'border-destructive text-destructive' :
                    'border-muted-foreground/30 text-muted-foreground',
                  )}>
                    {m.status === 'completed' ? <Check className="size-3" /> : i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{m.title}</p>
                    {m.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{m.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                    {mTotal > 0 && <span>{mCompleted}/{mTotal}</span>}
                    <span className="text-[10px]">{isExpanded ? '▾' : '▸'}</span>
                  </div>
                </button>

                {/* Expanded task list */}
                {isExpanded && milestoneTasks.length > 0 && (
                  <div className="border-t border-border/50 px-4 py-2 space-y-1">
                    {milestoneTasks.map(t => (
                      <div
                        key={t.id}
                        className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-accent/30 cursor-pointer transition-colors"
                        onClick={() => navigate(`/foreman/task/${t.id}`)}
                      >
                        {TASK_STATUS_ICONS[t.status] ?? TASK_STATUS_ICONS.backlog}
                        <span className="text-xs flex-1 truncate">{t.title}</span>
                        <span className={cn('text-[10px] font-medium', TASK_STATUS_COLORS[t.status] ?? 'text-muted-foreground')}>
                          {t.status.replace('_', ' ')}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{t.type}</span>
                        {t.git_pr_url && (
                          <a href={t.git_pr_url} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-muted-foreground hover:text-primary transition-colors">
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Expanded but no tasks yet */}
                {isExpanded && milestoneTasks.length === 0 && (
                  <div className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
                    No tasks generated yet for this milestone.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
