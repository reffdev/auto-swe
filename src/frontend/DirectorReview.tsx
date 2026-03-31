import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Send, X, CheckCircle } from 'lucide-react'
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
  let context: { issues?: string[]; reasoning?: string; error?: string; [key: string]: unknown } = {}
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
              {context.issues && Array.isArray(context.issues) && (
                <ul className="space-y-1 mb-3">
                  {(context.issues as string[]).map((issue, i) => {
                    const text = String(issue)
                    return <li key={i} className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">- {text}</li>
                  })}
                </ul>
              )}
              {context.reasoning != null && (() => {
                const text = String(context.reasoning)
                return <p className="text-xs text-muted-foreground bg-muted p-2 rounded">{text}</p>
              })()}
              {context.error != null && (() => {
                const text = String(context.error).slice(0, 2000)
                return <pre className="text-xs text-destructive bg-destructive/10 p-2 rounded whitespace-pre-wrap">{text}</pre>
              })()}
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

          {/* Free-text response */}
          <div className="space-y-2">
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
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}
