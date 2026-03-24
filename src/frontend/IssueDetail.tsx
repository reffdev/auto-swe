import { useState } from 'react'
import { ArrowLeft, ExternalLink, Check, X, RotateCcw, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusBadge } from './IssueList'
import * as api from './api'
import type { Issue, Run } from './api'

interface IssueDetailProps {
  issue: Issue
  run: Run | null
  onBack: () => void
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

export function IssueDetail({ issue, run, onBack, onDataChange }: IssueDetailProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const doAction = async (name: string, fn: () => Promise<unknown>) => {
    setActionLoading(name)
    setActionError(null)
    try {
      await fn()
      onDataChange()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <h2 className="text-base font-semibold flex-1 truncate">{issue.title}</h2>
          <StatusBadge status={issue.status} />
        </div>
        {issue.description && (
          <p className="text-sm text-muted-foreground ml-9">{issue.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        {issue.status === 'pending' && (
          <Button
            size="sm"
            onClick={() => doAction('approve', () => api.approveIssue(issue.id))}
            disabled={!!actionLoading}
          >
            <Play className="size-3.5 mr-1" />
            {actionLoading === 'approve' ? 'Approving...' : 'Approve & Run'}
          </Button>
        )}
        {issue.status === 'awaiting_review' && (
          <>
            <Button
              size="sm"
              variant="default"
              onClick={() => doAction('approve-pr', () => api.approvePr(issue.id))}
              disabled={!!actionLoading}
            >
              <Check className="size-3.5 mr-1" />
              {actionLoading === 'approve-pr' ? 'Merging...' : 'Approve PR'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => doAction('reject-pr', () => api.rejectPr(issue.id))}
              disabled={!!actionLoading}
            >
              <X className="size-3.5 mr-1" />
              Reject PR
            </Button>
          </>
        )}
        {issue.status === 'failed' && (
          <Button
            size="sm"
            onClick={() => doAction('retry', () => api.retryIssue(issue.id))}
            disabled={!!actionLoading}
          >
            <RotateCcw className="size-3.5 mr-1" />
            {actionLoading === 'retry' ? 'Retrying...' : 'Retry'}
          </Button>
        )}
        {issue.git_pr_url && (
          <a
            href={issue.git_pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-400 hover:underline ml-auto"
          >
            PR #{issue.git_pr_number} <ExternalLink className="size-3" />
          </a>
        )}
        {actionError && (
          <p className="text-sm text-destructive w-full mt-1">{actionError}</p>
        )}
      </div>

      {/* Run details */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!run && (
          <p className="text-muted-foreground text-sm">No run data yet.</p>
        )}
        {run && (
          <div className="space-y-4">
            {/* Run metadata */}
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span>Status: <strong className="text-foreground">{run.status}</strong></span>
              {run.duration_ms != null && <span>Duration: {formatDuration(run.duration_ms)}</span>}
              {run.prompt_tokens != null && (
                <span>Tokens: {(run.prompt_tokens + (run.completion_tokens ?? 0)).toLocaleString()}</span>
              )}
              {issue.git_branch && <span>Branch: <code className="text-foreground">{issue.git_branch}</code></span>}
            </div>

            {/* Running indicator */}
            {run.status === 'running' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Spinner className="size-4" />
                Agent is working...
              </div>
            )}

            {/* Output */}
            {run.output && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Agent Output</h3>
                <pre className="text-sm bg-muted/50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[60vh] overflow-y-auto">
                  {run.output}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
