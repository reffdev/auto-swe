import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Send, X, CheckCircle, Lock, Check, ExternalLink, FileText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import * as api from './api'
import type { DirectorReview as DirectorReviewType, ForemanTask } from './api'

export function DirectorReview({ reviewId, onBack, onNavigateReview }: {
  reviewId: string
  onBack: () => void
  onNavigateReview?: (reviewId: string) => void
}) {
  const navigate = useNavigate()
  const [review, setReview] = useState<DirectorReviewType | null>(null)
  const [task, setTask] = useState<ForemanTask | null>(null)
  const [response, setResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [waitingForRegeneration, setWaitingForRegeneration] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getDirectorReviews().then(reviews => {
      const r = reviews.find(rev => rev.id === reviewId)
      if (r) {
        setReview(r)
        // Fetch the associated task for detail display
        try {
          const ctx = JSON.parse(r.context)
          if (ctx.task_id) {
            api.getForemanTask(ctx.task_id).then(setTask).catch(() => {})
          }
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [reviewId])

  // Poll for new review gate after regenerate/refine
  useEffect(() => {
    if (!waitingForRegeneration || !review) return
    const taskId = (() => { try { return JSON.parse(review.context)?.task_id } catch { return null } })()
    if (!taskId) return

    const interval = setInterval(() => {
      api.getDirectorReviews().then(reviews => {
        const newReview = reviews.find(r =>
          r.id !== review.id && r.task_id === taskId && r.status === 'pending'
        )
        if (newReview) {
          setWaitingForRegeneration(false)
          if (onNavigateReview) {
            onNavigateReview(newReview.id)
          } else {
            // Reload into the new review
            setReview(newReview)
          }
        }
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [waitingForRegeneration, review, onNavigateReview])

  if (!review) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading review...</div>
  }

  const options: string[] = review.options ? JSON.parse(review.options) : []
  let context: Record<string, unknown> & { issues?: string[]; reasoning?: string; error?: string; task_id?: string } = {}
  try { context = JSON.parse(review.context) } catch { /* ignore */ }

  const handleRespond = async (text: string, awaitRegeneration = false) => {
    setSubmitting(true)
    setError('')
    try {
      await api.respondToReview(review.id, text)
      if (awaitRegeneration) {
        setSubmitting(false)
        setWaitingForRegeneration(true)
      } else {
        onBack()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!awaitRegeneration) setSubmitting(false)
    }
  }

  const handleDismiss = async () => {
    try {
      await api.dismissReview(review.id)
      onBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (review.status !== 'pending') {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="px-6 py-3 border-b border-border flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack}><ArrowLeft className="size-4" /></Button>
          <h2 className="text-sm font-semibold">Review (Resolved)</h2>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <CheckCircle className="size-8 mx-auto mb-2 text-emerald-500" />
            <p>This review has been {review.status}.</p>
            {review.response && <p className="text-sm mt-2">Response: {review.response}</p>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h2 className="text-sm font-semibold">Review Required</h2>
          <p className="text-xs text-muted-foreground">{review.review_type.replace('_', ' ')}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 space-y-6">
          {/* Question */}
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4">
            <p className="text-sm font-medium">{review.question}</p>
          </div>

          {/* Context */}
          {Object.keys(context).length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Context</h3>
              {context.issues && context.issues.length > 0 && (
                <ul className="space-y-1 mb-3">
                  {context.issues.map((issue, i) => (
                    <li key={i} className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">- {issue}</li>
                  ))}
                </ul>
              )}
              {context.reasoning && (
                <p className="text-xs text-muted-foreground bg-muted p-2 rounded">{context.reasoning}</p>
              )}
              {context.error && (
                <pre className="text-xs text-destructive bg-destructive/10 p-2 rounded whitespace-pre-wrap">{context.error.slice(0, 2000)}</pre>
              )}
            </div>
          )}

          {/* Options (if multiple choice) */}
          {options.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Options</h3>
              {options.map((opt, i) => (
                <button key={i} onClick={() => handleRespond(opt)} disabled={submitting}
                  className="w-full text-left px-4 py-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors text-sm">
                  {opt}
                </button>
              ))}
            </div>
          )}

          {/* Style selection UI */}
          {review.review_type === 'style_selection' && context.task_id && !waitingForRegeneration && (
            <StyleSelectionPanel
              taskId={context.task_id ?? ""}
              onLock={(selectedIndex, feedback, run) => handleRespond(JSON.stringify({ action: 'lock', selected: [selectedIndex], feedback, run }))}
              onRefine={(feedback) => handleRespond(JSON.stringify({ action: 'refine', feedback }), true)}
              onRegenerate={() => handleRespond(JSON.stringify({ action: 'regenerate' }), true)}
              onEnhance={(selectedIndex, run) => handleRespond(JSON.stringify({ action: 'enhance', selected: [selectedIndex], run }))}
              submitting={submitting}
            />
          )}

          {/* Waiting for regeneration */}
          {waitingForRegeneration && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <div className="size-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-sm font-medium">Regenerating style variations...</p>
              <p className="text-xs mt-1">New images will appear here automatically.</p>
            </div>
          )}

          {/* Code task review UI */}
          {review.review_type === 'task_verify' && (
            <div className="space-y-4">
              {/* Task details */}
              {task && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <button onClick={() => navigate(`/foreman/task/${task.id}`)}
                      className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                      <FileText className="size-3" />
                      View full task detail
                    </button>
                    <span className="text-[10px] text-muted-foreground">{task.type} | {task.status}</span>
                  </div>
                  <div className="bg-muted/50 rounded-md p-3 text-xs space-y-2">
                    <p className="font-medium">{task.title}</p>
                    <p className="text-muted-foreground whitespace-pre-wrap">{task.description}</p>
                    {task.target_files && (() => {
                      try {
                        const files = JSON.parse(task.target_files) as string[]
                        return files.length > 0 ? (
                          <div>
                            <span className="text-muted-foreground font-medium">Target files:</span>
                            <ul className="mt-1 space-y-0.5">
                              {files.map((f, i) => <li key={i} className="text-muted-foreground font-mono">{f}</li>)}
                            </ul>
                          </div>
                        ) : null
                      } catch { return null }
                    })()}
                    {task.acceptance_criteria && (() => {
                      try {
                        const criteria = JSON.parse(task.acceptance_criteria) as string[]
                        return criteria.length > 0 ? (
                          <div>
                            <span className="text-muted-foreground font-medium">Acceptance criteria:</span>
                            <ul className="mt-1 space-y-0.5">
                              {criteria.map((c, i) => <li key={i} className="text-muted-foreground">- {c}</li>)}
                            </ul>
                          </div>
                        ) : null
                      } catch { return null }
                    })()}
                  </div>
                </div>
              )}

              {/* PR link */}
              {!!context.git_pr_url && (
                <a href={context.git_pr_url as string} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors text-sm">
                  <ExternalLink className="size-4 text-primary" />
                  <span>Review PR #{String(context.git_pr_number)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">on {String(context.git_branch)}</span>
                </a>
              )}

              {/* No PR available */}
              {!context.git_pr_url && task?.git_branch && (
                <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
                  No PR created (branch: {task.git_branch}). The task may have had no changes to commit.
                </div>
              )}

              {/* Reject feedback */}
              <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="Rejection feedback — explain what needs to change (required to reject)"
                rows={3}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />

              <div className="flex gap-2">
                <Button onClick={() => handleRespond('approve')} disabled={submitting}>
                  <Check className="size-3.5 mr-1.5" />
                  {submitting ? 'Approving...' : 'Approve & Merge'}
                </Button>
                <Button variant="outline"
                  onClick={() => {
                    if (!response.trim()) return
                    handleRespond(response)
                  }}
                  disabled={!response.trim() || submitting}>
                  <X className="size-3.5 mr-1.5" />
                  Reject with Feedback
                </Button>
              </div>
            </div>
          )}

          {/* Generic free-text response (non-task-verify, non-style-selection) */}
          {review.review_type !== 'style_selection' && review.review_type !== 'task_verify' && <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {options.length > 0 ? 'Or provide custom response' : 'Your response'}
            </h3>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="Type your response..."
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
            <div className="flex gap-2">
              <Button onClick={() => handleRespond(response)} disabled={!response.trim() || submitting}>
                <Send className="size-3.5 mr-1.5" />
                {submitting ? 'Sending...' : 'Respond'}
              </Button>
              <Button variant="outline" onClick={handleDismiss}>
                <X className="size-3.5 mr-1.5" /> Dismiss
              </Button>
            </div>
          </div>}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Style Selection Panel ──────────────────────────────────────────────────

interface RunInfo { attempt: number; fileCount: number }

function StyleSelectionPanel({ taskId, onLock, onRefine, onRegenerate, onEnhance, submitting }: {
  taskId: string
  onLock: (selectedIndex: number, feedback: string, run?: number) => void
  onRefine: (feedback: string) => void
  onRegenerate: () => void
  onEnhance?: (selectedIndex: number, run?: number) => void
  submitting: boolean
}) {
  const [files, setFiles] = useState<string[]>([])
  const [availableRuns, setAvailableRuns] = useState<RunInfo[]>([])
  const [activeRun, setActiveRun] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackNeeded, setFeedbackNeeded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [cacheKey] = useState(() => Date.now())

  useEffect(() => {
    setLoading(true)
    setSelected(null) // reset selection when switching runs
    const runParam = activeRun !== null ? `?run=${activeRun}` : ''
    fetch(`/api/foreman/tasks/${taskId}/assets${runParam}`)
      .then(r => r.json())
      .then(data => {
        setFiles(data.files ?? [])
        if (data.availableRuns) setAvailableRuns(data.availableRuns)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [taskId, activeRun])

  if (loading && files.length === 0) return <p className="text-xs text-muted-foreground">Loading style variations...</p>
  if (files.length === 0 && availableRuns.length === 0) return <p className="text-xs text-muted-foreground">No variations available</p>

  const runSuffix = activeRun !== null ? `&run=${activeRun}` : ''

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Select a Style</h3>

      {availableRuns.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setActiveRun(null)}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full border transition-colors',
              activeRun === null
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-primary/50',
            )}
          >
            Current
          </button>
          {[...availableRuns].reverse().map(r => (
            <button
              key={r.attempt}
              onClick={() => setActiveRun(r.attempt)}
              className={cn(
                'px-2.5 py-1 text-xs rounded-full border transition-colors',
                activeRun === r.attempt
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50',
              )}
            >
              Run {r.attempt} ({r.fileCount})
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {files.map((_, i) => (
          <button
            key={`${activeRun}-${i}`}
            onClick={() => setSelected(selected === i ? null : i)}
            className={cn(
              'relative rounded-lg border-2 overflow-hidden transition-colors',
              selected === i ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50',
            )}
          >
            <img
              src={`/api/foreman/tasks/${taskId}/asset/${i}?t=${cacheKey}${runSuffix}`}
              alt={`Variation ${i + 1}`}
              className="w-full aspect-square object-contain bg-muted/30"
              style={{ imageRendering: 'pixelated' }}
            />
            <span className={cn(
              'absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded font-medium',
              selected === i ? 'bg-primary text-primary-foreground' : 'bg-black/60 text-white',
            )}>
              {activeRun !== null ? `R${activeRun}` : ''}#{i + 1}
            </span>
          </button>
        ))}
      </div>

      <textarea
        value={feedback}
        onChange={(e) => { setFeedback(e.target.value); if (e.target.value.trim()) setFeedbackNeeded(false) }}
        placeholder={feedbackNeeded
          ? "Please describe what to change (e.g., 'more saturated colors, thicker outlines')"
          : "Optional feedback (e.g., 'I like the palette of #2 but the line weight of #4')"}
        rows={2}
        className={cn(
          'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none',
          feedbackNeeded ? 'border-orange-500 ring-1 ring-orange-500/30' : 'border-border',
        )}
      />
      {feedbackNeeded && (
        <p className="text-xs text-orange-400">Describe what you'd like changed before refining.</p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() => selected !== null && onLock(selected, feedback, activeRun ?? undefined)}
          disabled={selected === null || submitting}
        >
          <Lock className="size-3.5 mr-1.5" />
          Lock Style {activeRun !== null ? `R${activeRun}` : ''}#{selected !== null ? selected + 1 : '?'}
        </Button>
        <Button
          variant="outline"
          onClick={onRegenerate}
          disabled={submitting}
        >
          Regenerate (Same Prompts)
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (!feedback.trim()) {
              setFeedbackNeeded(true)
              return
            }
            onRefine(feedback)
          }}
          disabled={submitting}
        >
          Refine Prompts
        </Button>
        {onEnhance && (
          <Button
            variant="outline"
            onClick={() => selected !== null && onEnhance(selected, activeRun ?? undefined)}
            disabled={selected === null || submitting}
          >
            Enhance with FLUX.2
          </Button>
        )}
      </div>
    </div>
  )
}
