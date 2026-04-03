import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Check, RefreshCw } from 'lucide-react'
import * as api from './api'
import type { UnattributedCommit, DirectorDirective, DirectorMilestone } from './api'

export function ManualCommits({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [commits, setCommits] = useState<UnattributedCommit[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [directives, setDirectives] = useState<DirectorDirective[]>([])
  const [milestones, setMilestones] = useState<DirectorMilestone[]>([])
  const [directiveId, setDirectiveId] = useState('')
  const [milestoneId, setMilestoneId] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [commitData, directiveData] = await Promise.all([
        api.getUnattributedCommits(projectId),
        api.getDirectorDirectives(projectId),
      ])
      setCommits(commitData.commits)
      setDirectives(directiveData)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [projectId])

  // Auto-select the active directive on first load
  useEffect(() => {
    if (directives.length > 0 && !directiveId) {
      const active = directives.find(d => d.status === 'active' || d.status === 'paused')
      if (active) setDirectiveId(active.id)
    }
  }, [directives, directiveId])

  useEffect(() => { void load() }, [load])

  // Load milestones when directive changes
  useEffect(() => {
    if (!directiveId) { setMilestones([]); return }
    api.getDirectorDirective(directiveId).then(data => {
      setMilestones(data.milestones ?? [])
    }).catch(() => setMilestones([]))
  }, [directiveId])

  const toggleCommit = (sha: string) => {
    const next = new Set(selected)
    if (next.has(sha)) next.delete(sha)
    else next.add(sha)
    setSelected(next)
  }

  const selectAll = () => {
    if (selected.size === commits.length) setSelected(new Set())
    else setSelected(new Set(commits.map(c => c.sha)))
  }

  const handleSubmit = async () => {
    if (!title.trim() || selected.size === 0) return
    setSubmitting(true)
    setMessage(null)
    try {
      await api.submitManualCommits({
        project_id: projectId,
        title: title.trim(),
        description: description.trim(),
        commit_shas: Array.from(selected),
        directive_id: directiveId || undefined,
        milestone_id: milestoneId || undefined,
      })
      setMessage(`Submitted ${selected.size} commit(s) as "${title.trim()}"`)
      setTitle('')
      setDescription('')
      setSelected(new Set())
      // Reload to remove the submitted commits
      await load()
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading commits...</div>
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h2 className="text-sm font-semibold">Manual Commits</h2>
          <p className="text-xs text-muted-foreground">
            {commits.length} unattributed commit{commits.length !== 1 ? 's' : ''} on main
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={load}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-2xl space-y-6">
          {commits.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">No unattributed commits found.</p>
              <p className="text-xs mt-1">All recent commits are linked to foreman tasks.</p>
            </div>
          ) : (
            <>
              {/* Commit list */}
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Select Commits
                  </h3>
                  <button onClick={selectAll} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {selected.size === commits.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                {commits.map(c => (
                  <button
                    key={c.sha}
                    onClick={() => toggleCommit(c.sha)}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-md border transition-colors flex items-start gap-3',
                      selected.has(c.sha)
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50',
                    )}
                  >
                    <div className={cn(
                      'size-4 rounded border flex items-center justify-center shrink-0 mt-0.5',
                      selected.has(c.sha) ? 'bg-primary border-primary' : 'border-muted-foreground/30',
                    )}>
                      {selected.has(c.sha) && <Check className="size-3 text-primary-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{c.message}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {c.sha.slice(0, 8)} by {c.author} on {new Date(c.date).toLocaleDateString()}
                      </p>
                    </div>
                  </button>
                ))}
              </div>

              {/* Submit form */}
              {selected.size > 0 && (
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Title</span>
                    <input
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="What did these commits accomplish?"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Description (optional)</span>
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Additional context about the changes..."
                      rows={3}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Directive (optional)</span>
                      <select
                        value={directiveId}
                        onChange={e => { setDirectiveId(e.target.value); setMilestoneId('') }}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      >
                        <option value="">None</option>
                        {directives.map(d => (
                          <option key={d.id} value={d.id}>
                            {d.directive.slice(0, 60)}{d.directive.length > 60 ? '...' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Milestone (optional)</span>
                      <select
                        value={milestoneId}
                        onChange={e => setMilestoneId(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        disabled={!directiveId}
                      >
                        <option value="">None</option>
                        {milestones.map(m => (
                          <option key={m.id} value={m.id}>{m.title}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button onClick={handleSubmit} disabled={!title.trim() || submitting}>
                      <Check className="size-3.5 mr-1.5" />
                      {submitting ? 'Submitting...' : `Submit ${selected.size} commit${selected.size !== 1 ? 's' : ''}`}
                    </Button>
                    {message && (
                      <span className={cn('text-xs', message.startsWith('Error') ? 'text-destructive' : 'text-emerald-500')}>
                        {message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
