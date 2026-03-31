import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Play, XCircle, CheckCircle, RotateCcw, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import * as api from './api'
import type { ForemanTask, ForemanRun, StepData } from './api'

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export function ForemanTaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [task, setTask] = useState<ForemanTask | null>(null)
  const [runs, setRuns] = useState<ForemanRun[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/foreman/tasks/${taskId}`)
      if (!res.ok) return
      const data = await res.json()
      setTask(data.task)
      setRuns(data.runs)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [taskId])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 3000)
    return () => clearInterval(interval)
  }, [refresh])

  if (loading && !task) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
  }

  if (!task) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Task not found</div>
  }

  const targetFiles: string[] = safeJsonParse(task.target_files, [])
  const acceptanceCriteria: string[] = safeJsonParse(task.acceptance_criteria, [])
  const latestRun = runs[runs.length - 1]
  const validationResults: Array<{ criterion: string; passed: boolean; output: string }> =
    safeJsonParse(latestRun?.validation_output, [])

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3 mb-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              {task.yaml_id && <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">#{task.yaml_id}</span>}
              <h2 className="text-lg font-semibold">{task.title}</h2>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              <span>Type: <span className="text-foreground font-mono">{task.type}</span></span>
              <span>Model: <span className="text-foreground font-mono">{task.resolved_model ?? task.model}</span></span>
              <span>Priority: <span className="text-foreground">P{task.priority}</span></span>
              <span>Status: <span className="text-foreground">{task.status.replace('_', ' ')}</span></span>
              {task.retry_count > 0 && <span>Retries: <span className="text-foreground">{task.retry_count}/{task.max_retries}</span></span>}
              {task.duration_ms && <span>Duration: <span className="text-foreground">{(task.duration_ms / 1000).toFixed(1)}s</span></span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(task.status === 'backlog' || task.status === 'failed') && (
              <Button size="sm" onClick={() => void api.queueForemanTask(task.id).then(refresh)}>
                <Play className="size-3.5 mr-1.5" /> Queue
              </Button>
            )}
            {task.status === 'running' && (
              <Button variant="destructive" size="sm" onClick={() => void api.cancelForemanTask(task.id).then(refresh)}>
                <XCircle className="size-3.5 mr-1.5" /> Cancel
              </Button>
            )}
            {task.status === 'awaiting_review' && (
              <Button size="sm" onClick={() => void api.completeForemanTask(task.id).then(refresh)}>
                <CheckCircle className="size-3.5 mr-1.5" /> Complete
              </Button>
            )}
            {task.status === 'failed' && (
              <Button variant="outline" size="sm" onClick={() => void api.retryForemanTask(task.id).then(refresh)}>
                <RotateCcw className="size-3.5 mr-1.5" /> Retry
              </Button>
            )}
          </div>
        </div>
        {task.git_pr_url && (
          <a href={task.git_pr_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1">
            <ExternalLink className="size-3" /> PR #{task.git_pr_number}
          </a>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-6">
          {/* Description */}
          <section>
            <h3 className="text-sm font-medium mb-2">Description</h3>
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded-md p-3 max-h-60 overflow-y-auto">{task.description || 'No description'}</pre>
          </section>

          {/* Target files */}
          {targetFiles.length > 0 && (
            <section>
              <h3 className="text-sm font-medium mb-2">Target Files</h3>
              <ul className="space-y-0.5">
                {targetFiles.map((f, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded">{f}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Acceptance criteria */}
          {acceptanceCriteria.length > 0 && (
            <section>
              <h3 className="text-sm font-medium mb-2">Acceptance Criteria</h3>
              <ul className="space-y-1">
                {acceptanceCriteria.map((c, i) => {
                  const vResult = validationResults.find(r => r.criterion === c)
                  return (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      {vResult ? (
                        vResult.passed
                          ? <CheckCircle className="size-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          : <XCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
                      ) : (
                        <span className="size-3.5 rounded-full border border-border shrink-0 mt-0.5" />
                      )}
                      <div>
                        <span className="text-foreground">{c}</span>
                        {vResult && !vResult.passed && (
                          <p className="text-destructive mt-0.5">{vResult.output}</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* Error message */}
          {task.error_message && (
            <section>
              <h3 className="text-sm font-medium mb-2 text-destructive">Error</h3>
              <pre className="text-xs text-destructive whitespace-pre-wrap bg-destructive/10 rounded-md p-3 max-h-40 overflow-y-auto">{task.error_message}</pre>
            </section>
          )}

          {/* Execution history */}
          {runs.length > 0 && (
            <section>
              <h3 className="text-sm font-medium mb-2">Execution History</h3>
              <div className="space-y-2">
                {runs.map(run => (
                  <RunCard key={run.id} run={run} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function RunCard({ run }: { run: ForemanRun }) {
  const [expanded, setExpanded] = useState(false)
  const steps: StepData[] = safeJsonParse(run.output, [])

  return (
    <div className="border border-border rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-medium">Attempt #{run.attempt}</span>
          <span className={cn(
            'px-1.5 py-0.5 rounded-full text-[10px] font-medium',
            run.status === 'pass' ? 'bg-emerald-500/10 text-emerald-500' :
            run.status === 'fail' ? 'bg-destructive/10 text-destructive' :
            run.status === 'running' ? 'bg-emerald-400/10 text-emerald-400' :
            'bg-muted text-muted-foreground'
          )}>
            {run.status}
          </span>
          {run.model_id && <span className="text-muted-foreground font-mono">{run.model_id}</span>}
        </div>
        <div className="flex items-center gap-3 text-muted-foreground">
          {run.duration_ms && <span>{(run.duration_ms / 1000).toFixed(1)}s</span>}
          {(run.prompt_tokens || run.completion_tokens) && (
            <span className="font-mono">{run.prompt_tokens ?? 0}+{run.completion_tokens ?? 0} tok</span>
          )}
        </div>
      </button>

      {expanded && steps.length > 0 && (
        <div className="border-t border-border px-3 py-2 max-h-96 overflow-y-auto">
          {steps.map((step, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div className="text-[10px] text-muted-foreground mb-0.5">Step {step.step}</div>
              {step.text && (
                <pre className="text-xs whitespace-pre-wrap text-foreground bg-muted/30 rounded p-2 max-h-40 overflow-y-auto">{step.text.slice(0, 2000)}</pre>
              )}
              {step.toolCalls?.map((tc, j) => (
                <div key={j} className="text-xs mt-1">
                  <span className="font-mono text-blue-400">{tc.tool}</span>
                  <pre className="text-muted-foreground mt-0.5 text-[10px] max-h-20 overflow-hidden">{tc.args.slice(0, 500)}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {run.error_message && (
        <div className="border-t border-border px-3 py-2">
          <pre className="text-xs text-destructive whitespace-pre-wrap">{run.error_message}</pre>
        </div>
      )}
    </div>
  )
}
