import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  CheckCircle2, XCircle, Clock, Play, AlertCircle, Loader2,
  GitBranch, Cpu, ArrowRight, Plus, Terminal, Settings, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from './api'

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: typeof CheckCircle2 }> = {
  completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', icon: CheckCircle2 },
  pass: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', icon: CheckCircle2 },
  running: { bg: 'bg-blue-500/10', text: 'text-blue-500', icon: Play },
  pending: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', icon: Clock },
  approved: { bg: 'bg-amber-500/10', text: 'text-amber-500', icon: Clock },
  failed: { bg: 'bg-red-500/10', text: 'text-red-500', icon: XCircle },
  fail: { bg: 'bg-red-500/10', text: 'text-red-500', icon: XCircle },
  cancelled: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', icon: XCircle },
  awaiting_review: { bg: 'bg-amber-500/10', text: 'text-amber-500', icon: AlertCircle },
  epic: { bg: 'bg-purple-500/10', text: 'text-purple-500', icon: GitBranch },
}

function StatusBadge({ status, count }: { status: string; count: number }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending
  const Icon = style.icon
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg', style.bg)}>
      <Icon className={cn('size-4', style.text)} />
      <div>
        <div className="text-lg font-semibold">{count}</div>
        <div className="text-xs text-muted-foreground capitalize">{status.replace(/_/g, ' ')}</div>
      </div>
    </div>
  )
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = secs / 60
  return `${mins.toFixed(1)}m`
}

export function ProjectOverview({ projectId, onDataChange }: { projectId: string; onDataChange?: () => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<api.ProjectOverviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api.getProjectOverview(projectId)
        .then(d => { if (!cancelled) { setData(d); setError(null); } })
        .catch(e => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setLoading(false); })
    }
    load()
    const interval = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(interval); }
  }, [projectId])

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin mr-2" /> Loading overview...
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive">
        Failed to load overview: {error}
      </div>
    )
  }

  if (!data) return null

  const { project, issueCounts, activeRuns, activeForemanTasks, recentActivity, tokenStats, activeDirectives } = data
  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0)
  const completedIssues = (issueCounts.completed ?? 0)
  const failedIssues = (issueCounts.failed ?? 0)
  const runningIssues = (issueCounts.running ?? 0)

  // Order statuses for display
  const statusOrder = ['running', 'approved', 'pending', 'awaiting_review', 'completed', 'failed', 'cancelled', 'epic']
  const displayStatuses = statusOrder.filter(s => (issueCounts[s] ?? 0) > 0)

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8">
      <div className="max-w-5xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {project.git_remote ? project.git_remote.replace(/\.git$/, '').replace(/^https?:\/\//, '') : project.workdir}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => navigate(`/project/${projectId}`)}>
              <AlertCircle className="size-3.5 mr-1.5" />
              Issues
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/terminal/${projectId}`)}>
              <Terminal className="size-3.5 mr-1.5" />
              Terminal
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/project/${projectId}/settings`)}>
              <Settings className="size-3.5 mr-1.5" />
              Settings
            </Button>
          </div>
        </div>

        {/* Issue status summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Issues</CardTitle>
          </CardHeader>
          <CardContent>
            {totalIssues === 0 ? (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">No issues yet.</p>
                <Button size="sm" onClick={() => navigate(`/project/${projectId}`)}>
                  <Plus className="size-3.5 mr-1.5" />
                  Create Issue
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                {displayStatuses.map(status => (
                  <StatusBadge key={status} status={status} count={issueCounts[status]} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active work */}
        {(activeRuns.length > 0 || activeForemanTasks.length > 0 || activeDirectives.length > 0) && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                <CardTitle className="text-sm font-medium">Active Work</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Active directives */}
              {activeDirectives.map(d => (
                <button
                  key={d.id}
                  onClick={() => navigate(`/director/${d.id}`)}
                  className="w-full text-left px-3 py-2 rounded-md bg-accent/30 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Zap className="size-3.5 text-amber-500 shrink-0" />
                      <span className="text-sm truncate">{d.directive.slice(0, 80)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground capitalize shrink-0 ml-2">{d.status}</span>
                  </div>
                  {d.total_milestones > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-accent overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all"
                          style={{ width: `${(d.completed_milestones / d.total_milestones) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{d.completed_milestones}/{d.total_milestones}</span>
                    </div>
                  )}
                </button>
              ))}

              {/* Active pipeline runs */}
              {activeRuns.map(r => (
                <button
                  key={r.run_id}
                  onClick={() => navigate(`/project/${projectId}/issue/${r.issue_id}`)}
                  className="w-full text-left px-3 py-2 rounded-md bg-accent/30 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Loader2 className="size-3.5 animate-spin text-blue-500 shrink-0" />
                      <span className="text-sm truncate">{r.issue_title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {r.stage && <span className="text-xs bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded">{r.stage}</span>}
                      {r.started_at && <span className="text-xs text-muted-foreground">{timeAgo(r.started_at)}</span>}
                    </div>
                  </div>
                </button>
              ))}

              {/* Active foreman tasks */}
              {activeForemanTasks.map(t => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/foreman/task/${t.id}`)}
                  className="w-full text-left px-3 py-2 rounded-md bg-accent/30 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {t.status === 'running' || t.status === 'validating'
                        ? <Loader2 className="size-3.5 animate-spin text-blue-500 shrink-0" />
                        : <Clock className="size-3.5 text-zinc-400 shrink-0" />
                      }
                      <span className="text-sm truncate">{t.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-xs bg-zinc-500/10 text-zinc-400 px-1.5 py-0.5 rounded">{t.type}</span>
                      <span className="text-xs text-muted-foreground capitalize">{t.status}</span>
                    </div>
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Stats + Recent activity side by side */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Stats */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Stats</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total runs</span>
                <span className="text-sm font-medium">{tokenStats.total_runs}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Success rate</span>
                <span className="text-sm font-medium">
                  {tokenStats.total_runs > 0
                    ? `${Math.round(((tokenStats.total_runs - failedIssues) / tokenStats.total_runs) * 100)}%`
                    : '-'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Avg duration</span>
                <span className="text-sm font-medium">
                  {tokenStats.avg_duration_ms > 0 ? formatDuration(tokenStats.avg_duration_ms) : '-'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Input tokens</span>
                <span className="text-sm font-medium">{formatTokens(tokenStats.total_prompt_tokens)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Output tokens</span>
                <span className="text-sm font-medium">{formatTokens(tokenStats.total_completion_tokens)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No completed work yet.</p>
              ) : (
                <div className="space-y-1">
                  {recentActivity.map((item, i) => {
                    const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.pending
                    const Icon = style.icon
                    const isIssueRun = item.source === 'issue_run'
                    return (
                      <div
                        key={`${item.source}-${item.id}-${i}`}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/30 transition-colors text-sm"
                      >
                        <Icon className={cn('size-3.5 shrink-0', style.text)} />
                        <span className="truncate flex-1">{item.title}</span>
                        {item.detail && (
                          <span className="text-xs bg-accent px-1.5 py-0.5 rounded text-muted-foreground shrink-0">
                            {item.detail}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(item.timestamp)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Project config summary */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Configuration</CardTitle>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/project/${projectId}/settings`)}>
                <Settings className="size-3.5 mr-1" /> Edit
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Branch</span>
                <span className="font-mono text-xs">{project.git_default_branch}</span>
              </div>
              {project.model_id && (
                <div>
                  <span className="text-xs text-muted-foreground block">Model</span>
                  <span className="font-mono text-xs">{project.model_id}</span>
                </div>
              )}
              {project.build_command && (
                <div>
                  <span className="text-xs text-muted-foreground block">Build</span>
                  <span className="font-mono text-xs">{project.build_command}</span>
                </div>
              )}
              {project.test_command && (
                <div>
                  <span className="text-xs text-muted-foreground block">Test</span>
                  <span className="font-mono text-xs">{project.test_command}</span>
                </div>
              )}
              {project.lint_command && (
                <div>
                  <span className="text-xs text-muted-foreground block">Lint</span>
                  <span className="font-mono text-xs">{project.lint_command}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
