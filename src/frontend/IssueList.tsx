import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Plus, MessageSquarePlus, Shield, Monitor, Zap, ClipboardCheck, FlaskConical, ShieldAlert, ChevronRight, Layers, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import * as api from './api'
import type { Issue, Run } from './api'

// ─── Status badge ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<Issue['status'], string> = {
  pending: 'bg-muted-foreground/20 text-muted-foreground',
  approved: 'bg-blue-500/20 text-blue-400',
  running: 'bg-green-500/20 text-green-400',
  awaiting_review: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-destructive/20 text-destructive',
  epic: 'bg-indigo-500/20 text-indigo-400',
}

function StatusBadge({ status }: { status: Issue['status'] }) {
  return (
    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', STATUS_COLORS[status])}>
      {status.replace('_', ' ')}
    </span>
  )
}

// ─── Issue summary modal ─────────────────────────────────────────────────────

export function IssueSummaryModal({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleString()
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue Summary</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-muted-foreground block mb-1">Issue ID</span>
              <span className="font-mono text-sm">{issue.id}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block mb-1">Status</span>
              <StatusBadge status={issue.status} />
            </div>
          </div>
          
          <div>
            <span className="text-xs text-muted-foreground block mb-1">Title</span>
            <p className="text-sm font-medium">{issue.title}</p>
          </div>
          
          {issue.description && (
            <div>
              <span className="text-xs text-muted-foreground block mb-1">Description</span>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{issue.description}</p>
            </div>
          )}
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-muted-foreground block mb-1">Created</span>
              <span className="text-sm">{formatDate(issue.created_at)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block mb-1">Completed</span>
              <span className="text-sm">{formatDate(issue.completed_at)}</span>
            </div>
          </div>
          
          {(issue.git_branch || issue.git_pr_url) && (
            <div className="border-t border-border pt-4">
              {issue.git_branch && (
                <div className="mb-2">
                  <span className="text-xs text-muted-foreground block mb-1">Branch</span>
                  <span className="text-sm font-mono">{issue.git_branch}</span>
                </div>
              )}
              {issue.git_pr_url && (
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">Pull Request</span>
                  <a 
                    href={issue.git_pr_url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:underline"
                  >
                    {issue.git_pr_url}
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Status tabs ─────────────────────────────────────────────────────────────

const STATUS_TABS = ['all', 'pending', 'running', 'awaiting_review', 'completed', 'failed'] as const

// ─── New Issue Dialog ────────────────────────────────────────────────────────

function NewIssueDialog({ open, onClose, projectId, onCreated }: {
  open: boolean
  onClose: () => void
  projectId: string
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [lenses, setLenses] = useState<string[]>(['general'])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const resetForm = () => { setTitle(''); setDescription(''); setLenses(['general']); setError('') }
  const handleClose = () => { resetForm(); onClose() }

  const toggleLens = (key: string) => {
    if (key === 'general') return
    setLenses(prev => prev.includes(key) ? prev.filter(l => l !== key) : [...prev, key])
  }

  const handleSubmit = async () => {
    setError('')
    setSubmitting(true)
    try {
      await api.createIssue({
        project_id: projectId,
        title,
        description: description || undefined,
        review_lenses: lenses,
      })
      onCreated()
      handleClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Issue</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea
            placeholder="Description — what should the agent do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
          />
          <div>
            <span className="text-xs text-muted-foreground mb-1 block">Review lenses:</span>
            <div className="flex items-center gap-1.5">
              {([
                { key: 'general', label: 'General', icon: ClipboardCheck, color: 'text-foreground bg-accent' },
                { key: 'security', label: 'Security', icon: Shield, color: 'text-orange-400 bg-orange-500/20' },
                { key: 'ui', label: 'UI', icon: Monitor, color: 'text-purple-400 bg-purple-500/20' },
                { key: 'performance', label: 'Performance', icon: Zap, color: 'text-cyan-400 bg-cyan-500/20' },
                { key: 'testing', label: 'Testing', icon: FlaskConical, color: 'text-green-400 bg-green-500/20' },
                { key: 'error_handling', label: 'Errors', icon: ShieldAlert, color: 'text-red-400 bg-red-500/20' },
              ] as const).map(lens => {
                const active = lenses.includes(lens.key)
                const Icon = lens.icon
                return (
                  <button
                    key={lens.key}
                    type="button"
                    onClick={() => toggleLens(lens.key)}
                    disabled={lens.key === 'general'}
                    className={cn(
                      'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors',
                      active ? lens.color : 'text-muted-foreground/50 bg-muted/30',
                      lens.key !== 'general' && 'cursor-pointer hover:opacity-80',
                      lens.key === 'general' && 'cursor-default',
                    )}
                  >
                    <Icon className="size-3" />
                    {lens.label}
                  </button>
                )
              })}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!title || submitting}>
            {submitting ? 'Creating...' : 'Create Issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Issue list ──────────────────────────────────────────────────────────────

interface IssueListProps {
  issues: Issue[]
  runByIssue: Map<string, Run>
  statusFilter: string
  onStatusFilter: (s: string) => void
  onSelectIssue: (id: string) => void
  projectId: string
  onDataChange: () => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

function IssueRow({ issue, run, indent, onSelect, onSummary }: { issue: Issue; run?: Run; indent?: boolean; onSelect: (id: string) => void; onSummary: (issue: Issue) => void }) {
  return (
    <button
      onClick={() => onSelect(issue.id)}
      className={cn(
        "w-full text-left py-3 border-b border-border hover:bg-accent/50 transition-colors",
        indent ? "pl-12 pr-6" : "px-6 py-4"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {indent && issue.sequence != null && (
              <span className="text-xs text-muted-foreground font-mono w-4 shrink-0">{issue.sequence}.</span>
            )}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onSummary(issue) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onSummary(issue) } }}
              className={cn("font-medium truncate text-left hover:text-primary hover:underline transition-colors cursor-pointer", indent ? "text-xs" : "text-sm")}
            >
              {issue.title}
            </span>
            <StatusBadge status={issue.status} />
            {run?.stage && (issue.status === 'running' || issue.status === 'approved') && (
              <span className="text-xs text-muted-foreground capitalize">{run.stage.replace('_', '-')}</span>
            )}
          </div>
          {!indent && issue.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{issue.description}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          {run?.duration_ms != null && (
            <span className="text-xs text-muted-foreground">{formatDuration(run.duration_ms)}</span>
          )}
          {issue.git_pr_url && (
            <span className="text-xs text-blue-400 block">PR #{issue.git_pr_number}</span>
          )}
        </div>
      </div>
    </button>
  )
}

function EpicOrIssueRow({ issue, children, isEpic, runByIssue, onSelectIssue, onSummary }: {
  issue: Issue; children: Issue[]; isEpic: boolean;
  runByIssue: Map<string, Run>; onSelectIssue: (id: string) => void; onSummary: (issue: Issue) => void;
}) {
  const [expanded, setExpanded] = useState(true)

  if (!isEpic) {
    return <IssueRow issue={issue} run={runByIssue.get(issue.id)} onSelect={onSelectIssue} onSummary={onSummary} />
  }

  // Derive epic status from children
  const childStatuses = children.map(c => c.status)
  const derivedStatus = childStatuses.every(s => s === 'completed') ? 'completed'
    : childStatuses.some(s => s === 'failed') ? 'failed'
    : childStatuses.some(s => s === 'running' || s === 'approved') ? 'running'
    : 'pending'

  const completedCount = childStatuses.filter(s => s === 'completed').length

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-6 py-4 border-b border-border hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <ChevronRight className={cn('size-3.5 shrink-0 transition-transform text-muted-foreground', expanded && 'rotate-90')} />
              <Layers className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium text-sm truncate">{issue.title}</span>
              <StatusBadge status={derivedStatus} />
              <span className="text-xs text-muted-foreground">{completedCount}/{children.length} stories</span>
            </div>
            {issue.description && (
              <p className="text-xs text-muted-foreground mt-1 ml-9 line-clamp-1">{issue.description}</p>
            )}
          </div>
        </div>
      </button>
      {expanded && children.map(child => (
        <IssueRow
          key={child.id}
          issue={child}
          run={runByIssue.get(child.id)}
          indent
          onSelect={onSelectIssue}
          onSummary={onSummary}
        />
      ))}
    </div>
  )
}

export function IssueList({ issues, runByIssue, statusFilter, onStatusFilter, onSelectIssue, projectId, onDataChange }: IssueListProps) {
  const [showNewIssue, setShowNewIssue] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const navigate = useNavigate()

  const handleSummary = (issue: Issue) => {
    setSelectedIssue(issue)
  }

  const handleCloseSummary = () => {
    setSelectedIssue(null)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with tabs */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => onStatusFilter(tab)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize',
                statusFilter === tab ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={() => navigate(`/project/${projectId}/settings`)}>
            <Settings className="size-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate(`/project/${projectId}/planner`)}>
            <MessageSquarePlus className="size-3.5 mr-1" />
            Plan with AI
          </Button>
          <Button size="sm" onClick={() => setShowNewIssue(true)}>
            <Plus className="size-3.5 mr-1" />
            New Issue
          </Button>
        </div>
      </div>

      {/* Issue rows */}
      <div className="flex-1 overflow-y-auto">
        {issues.length === 0 && (
          <p className="px-6 py-8 text-center text-muted-foreground text-sm">
            {statusFilter === 'all' ? 'No issues yet. Create one to get started.' : `No ${statusFilter.replace('_', ' ')} issues.`}
          </p>
        )}
        {(() => {
          // Group: show top-level issues and epics, children nested under their parent
          const topLevel = issues.filter(i => !i.parent_id)
          const childrenByParent = new Map<string, Issue[]>()
          for (const issue of issues) {
            if (issue.parent_id) {
              const list = childrenByParent.get(issue.parent_id) ?? []
              list.push(issue)
              childrenByParent.set(issue.parent_id, list)
            }
          }

          return topLevel.map((issue) => {
            const children = (childrenByParent.get(issue.id) ?? []).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
            const isEpic = issue.status === 'epic' || children.length > 0
            return (
              <EpicOrIssueRow
                key={issue.id}
                issue={issue}
                children={children}
                isEpic={isEpic}
                runByIssue={runByIssue}
                onSelectIssue={onSelectIssue}
                onSummary={handleSummary}
              />
            )
          })
        })()}
      </div>

      <NewIssueDialog
        open={showNewIssue}
        onClose={() => setShowNewIssue(false)}
        projectId={projectId}
        onCreated={onDataChange}
      />

      {selectedIssue && (
        <IssueSummaryModal
          issue={selectedIssue}
          onClose={handleCloseSummary}
        />
      )}
    </div>
  )
}

export { StatusBadge }
