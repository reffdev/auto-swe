import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Send, X, CheckCircle, Lock } from 'lucide-react'
import * as api from './api'
import type { DirectorReview as DirectorReviewType } from './api'

export function DirectorReview({ reviewId, onBack }: { reviewId: string; onBack: () => void }) {
  const [review, setReview] = useState<DirectorReviewType | null>(null)
  const [response, setResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getDirectorReviews().then(reviews => {
      const r = reviews.find(rev => rev.id === reviewId)
      if (r) setReview(r)
    }).catch(() => {})
  }, [reviewId])

  if (!review) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading review...</div>
  }

  const options: string[] = review.options ? JSON.parse(review.options) : []
  let context: Record<string, unknown> & { issues?: string[]; reasoning?: string; error?: string; task_id?: string } = {}
  try { context = JSON.parse(review.context) } catch { /* ignore */ }

  const handleRespond = async (text: string) => {
    setSubmitting(true)
    setError('')
    try {
      await api.respondToReview(review.id, text)
      onBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
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
        <div className="px-6 py-6 max-w-2xl space-y-6">
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
          {review.review_type === 'style_selection' && context.task_id && (
            <StyleSelectionPanel
              taskId={context.task_id ?? ""}
              onLock={(selectedIndex, feedback) => handleRespond(JSON.stringify({ action: 'lock', selected: [selectedIndex], feedback }))}
              onRefine={(feedback) => handleRespond(JSON.stringify({ action: 'refine', feedback }))}
              submitting={submitting}
            />
          )}

          {/* Free-text response */}
          {review.review_type !== 'style_selection' && <div className="space-y-2">
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

function StyleSelectionPanel({ taskId, onLock, onRefine, submitting }: {
  taskId: string
  onLock: (selectedIndex: number, feedback: string) => void
  onRefine: (feedback: string) => void
  submitting: boolean
}) {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading] = useState(true)
  const [cacheKey] = useState(() => Date.now())

  useEffect(() => {
    fetch(`/api/foreman/tasks/${taskId}/assets`)
      .then(r => r.json())
      .then(data => { setFiles(data.files ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [taskId])

  if (loading) return <p className="text-xs text-muted-foreground">Loading style variations...</p>
  if (files.length === 0) return <p className="text-xs text-muted-foreground">No variations available</p>

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Select a Style</h3>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {files.map((_, i) => (
          <button
            key={i}
            onClick={() => setSelected(selected === i ? null : i)}
            className={cn(
              'relative rounded-lg border-2 overflow-hidden transition-colors',
              selected === i ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50',
            )}
          >
            <img
              src={`/api/foreman/tasks/${taskId}/asset/${i}?t=${cacheKey}`}
              alt={`Variation ${i + 1}`}
              className="w-full aspect-square object-contain bg-muted/30"
              style={{ imageRendering: 'pixelated' }}
            />
            <span className={cn(
              'absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded font-medium',
              selected === i ? 'bg-primary text-primary-foreground' : 'bg-black/60 text-white',
            )}>
              #{i + 1}
            </span>
          </button>
        ))}
      </div>

      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional feedback (e.g., 'I like the palette of #2 but the line weight of #4')"
        rows={2}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
      />

      <div className="flex gap-2">
        <Button
          onClick={() => selected !== null && onLock(selected, feedback)}
          disabled={selected === null || submitting}
        >
          <Lock className="size-3.5 mr-1.5" />
          Lock Style #{selected !== null ? selected + 1 : '?'}
        </Button>
        <Button
          variant="outline"
          onClick={() => onRefine(feedback || 'Generate new variations')}
          disabled={submitting}
        >
          Refine & Try Again
        </Button>
      </div>
    </div>
  )
}
