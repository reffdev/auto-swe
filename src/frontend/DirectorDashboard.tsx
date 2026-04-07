import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { RefreshCw, Plus, AlertTriangle, Trash2, X } from 'lucide-react'
import * as api from './api'
import type { DirectorDirective, DirectorReview } from './api'

const STATUS_COLORS: Record<string, string> = {
  drafting: 'text-muted-foreground',
  conversing: 'text-blue-400',
  planning: 'text-yellow-400',
  active: 'text-emerald-400',
  paused: 'text-orange-400',
  completed: 'text-emerald-500',
  failed: 'text-destructive',
}

export function DirectorDashboard() {
  const navigate = useNavigate()
  const [directives, setDirectives] = useState<DirectorDirective[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const refresh = useCallback(async () => {
    try { setDirectives(await api.getDirectorDirectives()) } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  // Director model + preferred machine are configured under
  // Settings → Foreman → Models (post logical-models refactor).

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => clearInterval(interval)
  }, [refresh])

  // Pending reviews across all directives
  const [pendingReviews, setPendingReviews] = useState<DirectorReview[]>([])
  useEffect(() => {
    void api.getDirectorReviews('pending').then(setPendingReviews).catch(() => {})
    const interval = setInterval(() => {
      void api.getDirectorReviews('pending').then(setPendingReviews).catch(() => {})
    }, 10000)
    return () => clearInterval(interval)
  }, [])

  if (loading && directives.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Director</h2>
          <p className="text-xs text-muted-foreground">
            {directives.length} directive{directives.length !== 1 ? 's' : ''}
            {pendingReviews.length > 0 && <span className="text-orange-400 ml-2">{pendingReviews.length} review{pendingReviews.length !== 1 ? 's' : ''} pending</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="size-3.5 mr-1.5" /> New Directive
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Pending reviews banner */}
      {pendingReviews.length > 0 && (
        <div className="px-6 py-3 bg-orange-500/10 border-b border-orange-500/20">
          <div className="flex items-center gap-2 text-sm text-orange-400">
            <AlertTriangle className="size-4" />
            <span className="font-medium">{pendingReviews.length} review{pendingReviews.length !== 1 ? 's' : ''} need your attention</span>
          </div>
          <div className="mt-2 space-y-1">
            {pendingReviews.map(r => {
              let ctx: Record<string, unknown> = {}
              try { ctx = JSON.parse(r.context) } catch { /* ignore */ }
              const isCommitReview = ctx.type === 'unattributed_commits'
              const href = isCommitReview
                ? `/director/commits/${ctx.project_id as string}`
                : `/director/review/${r.id}`
              return <div key={r.id} className="flex items-center gap-1 group">
                <button onClick={() => navigate(href)}
                  className="flex-1 text-xs text-muted-foreground hover:text-foreground transition-colors truncate text-left">
                  [{r.review_type}] {r.question}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setPendingReviews(prev => prev.filter(p => p.id !== r.id)); void api.dismissReview(r.id).catch(() => refresh()) }}
                  className="shrink-0 p-0.5 text-muted-foreground/50 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                  title="Dismiss review"
                >
                  <X className="size-3" />
                </button>
              </div>
            })}
          </div>
        </div>
      )}

      {/* Directives list */}
      <div className="flex-1 overflow-y-auto">
        {directives.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            No directives yet. Create one to start autonomous work.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {directives.map(d => (
              <DirectiveCard key={d.id} directive={d} onClick={() => {
                void navigate(`/director/${d.id}`)
              }} onRefresh={refresh} />
            ))}
          </div>
        )}
      </div>

      <NewDirectiveDialog open={showNew} onClose={() => setShowNew(false)} onCreated={(id) => {
        setShowNew(false)
        void refresh()
        void navigate(`/director/${id}/conversation`)
      }} />
    </div>
  )
}

function DirectiveCard({ directive: d, onClick, onRefresh }: { directive: DirectorDirective; onClick: () => void; onRefresh: () => void }) {
  let progress: { milestones?: Array<{ title: string; status: string; tasks_completed: number; tasks_generated: number }> } = {}
  try { if (d.progress) progress = JSON.parse(d.progress) } catch { /* ignore */ }

  const milestones = progress.milestones ?? []
  const totalTasks = milestones.reduce((s, m) => s + (m.tasks_generated || 0), 0)
  const completedTasks = milestones.reduce((s, m) => s + (m.tasks_completed || 0), 0)
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()} className="px-6 py-4 hover:bg-accent/30 cursor-pointer transition-colors">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-medium text-sm truncate flex-1">{d.directive}</h3>
        <div className="flex items-center gap-2 ml-3">
          <span className={cn('text-xs font-medium', STATUS_COLORS[d.status] ?? 'text-muted-foreground')}>
            {d.status}
          </span>
          {!['active', 'planning'].includes(d.status) && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Delete directive "${d.directive.slice(0, 60)}"?`)) {
                  void api.deleteDirectorDirective(d.id).then(onRefresh)
                }
              }}
              className="text-muted-foreground hover:text-destructive transition-colors"
              title="Delete directive"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {milestones.length > 0 && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span>{completedTasks}/{totalTasks} tasks</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex gap-1 mt-2">
            {milestones.map((m, i) => (
              <div key={i} className={cn('h-1 flex-1 rounded-full', {
                'bg-emerald-500': m.status === 'completed',
                'bg-emerald-400/50 animate-pulse': m.status === 'active',
                'bg-muted': m.status === 'pending',
                'bg-destructive': m.status === 'failed',
              })} title={m.title} />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
        <span>{d.autonomy_level} autonomy</span>
        {d.created_at && <span>Created {new Date(d.created_at).toLocaleDateString()}</span>}
      </div>
    </div>
  )
}

function NewDirectiveDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [directive, setDirective] = useState('')
  const [projectId, setProjectId] = useState('')
  const [autonomy, setAutonomy] = useState('standard')
  const [projects, setProjects] = useState<api.Project[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) api.poll().then(d => setProjects(d.projects)).catch(() => {})
  }, [open])

  const handleSubmit = async () => {
    setError('')
    setSubmitting(true)
    try {
      const created = await api.createDirectorDirective({
        project_id: projectId,
        directive,
        autonomy_level: autonomy,
      })
      // Create conversation immediately
      await api.createDirectorConversation(created.id)
      onCreated(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Directive</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
            <option value="">Select project...</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Input placeholder="What should be built? (e.g., 'Make Clickonomicon — an occult-themed incremental clicker')" value={directive} onChange={(e) => setDirective(e.target.value)} />
          <div className="flex gap-2">
            {['conservative', 'standard', 'aggressive'].map(level => (
              <button key={level} onClick={() => setAutonomy(level)}
                className={cn('flex-1 px-3 py-1.5 rounded-md border text-xs', autonomy === level ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}>
                {level}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!directive || !projectId || submitting}>
            {submitting ? 'Creating...' : 'Start Planning'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
