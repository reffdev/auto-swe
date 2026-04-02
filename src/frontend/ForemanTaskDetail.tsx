import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArrowLeft, Play, XCircle, CheckCircle, RotateCcw, ExternalLink, ChevronDown, ChevronRight, Image, Volume2, MessageSquare, Trash2 } from 'lucide-react'
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
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [preserveAssets, setPreserveAssets] = useState(false)

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
            {task.status === 'awaiting_review' && task.type !== 'style_exploration' && (
              <>
                <Button size="sm" onClick={() => void api.completeForemanTask(task.id).then(refresh)}>
                  <CheckCircle className="size-3.5 mr-1.5" /> Approve
                </Button>
                {isAssetTask(task) && (
                  <Button variant="outline" size="sm" onClick={() => setShowFeedback(!showFeedback)}>
                    <MessageSquare className="size-3.5 mr-1.5" /> Reject
                  </Button>
                )}
              </>
            )}
            {task.status === 'awaiting_review' && task.type === 'style_exploration' && (
              <span className="text-xs text-muted-foreground">Select a style from the Director review panel</span>
            )}
            {task.status === 'failed' && (
              <Button variant="outline" size="sm" onClick={() => void api.retryForemanTask(task.id).then(refresh)}>
                <RotateCcw className="size-3.5 mr-1.5" /> Retry
              </Button>
            )}
            {task.status !== 'running' && (
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm(`Delete task "${task.title}"?`)) {
                    void api.deleteForemanTask(task.id).then(() => onBack())
                  }
                }}
              >
                <Trash2 className="size-3.5 mr-1.5" /> Delete
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

      {/* Feedback bar for rejecting art tasks */}
      {showFeedback && task.status === 'awaiting_review' && (
        <div className="px-6 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Input
              placeholder="What should be different? (e.g. 'too dark', 'wrong style', 'needs transparency')"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && feedback.trim()) {
                  void api.rejectForemanTask(task.id, feedback.trim(), preserveAssets)
                    .then(() => { setFeedback(''); setShowFeedback(false); setPreserveAssets(false); void refresh() })
                    .catch(err => alert(`Reject failed: ${err instanceof Error ? err.message : err}`))
                }
              }}
              className="flex-1"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={!feedback.trim()}
              onClick={() => void api.rejectForemanTask(task.id, feedback.trim(), preserveAssets)
                .then(() => { setFeedback(''); setShowFeedback(false); setPreserveAssets(false); void refresh() })
                .catch(err => alert(`Reject failed: ${err instanceof Error ? err.message : err}`))
              }
            >
              Reject &amp; Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowFeedback(false); setFeedback(''); setPreserveAssets(false) }}>
              Cancel
            </Button>
          </div>
          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={preserveAssets}
              onChange={(e) => setPreserveAssets(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-xs text-muted-foreground">Keep existing assets for comparison</span>
          </label>
          <p className="text-xs text-muted-foreground mt-1">Your feedback will be injected into the generation prompt for the next attempt.</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-6">
          {/* Description */}
          <section>
            <h3 className="text-sm font-medium mb-2">Description</h3>
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded-md p-3 max-h-60 overflow-y-auto">{task.description || 'No description'}</pre>
          </section>

          {/* Asset preview for art/music/sfx tasks */}
          {isAssetTask(task) && (task.status === 'awaiting_review' || task.status === 'completed') && (
            <AssetPreview taskId={task.id} taskType={task.type} />
          )}

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

const ASSET_TYPES = new Set(['art', 'music', 'sfx', 'style_exploration'])

function isAssetTask(task: ForemanTask): boolean {
  return ASSET_TYPES.has(task.type)
}

function AssetPreview({ taskId, taskType }: { taskId: string; taskType: string }) {
  const [error, setError] = useState(false)
  const [cacheKey] = useState(() => Date.now())
  const isAudio = taskType === 'music' || taskType === 'sfx'
  const isStyleExploration = taskType === 'style_exploration'

  // For style exploration, show multi-image grid
  if (isStyleExploration) {
    return <StyleExplorationGrid taskId={taskId} />
  }

  const assetUrl = `/api/foreman/tasks/${taskId}/asset?t=${cacheKey}`

  if (error) {
    return (
      <section>
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          {isAudio ? <Volume2 className="size-3.5" /> : <Image className="size-3.5" />}
          Generated Asset
        </h3>
        <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-4 text-center">
          Asset not yet available
        </div>
      </section>
    )
  }

  return (
    <section>
      <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
        {isAudio ? <Volume2 className="size-3.5" /> : <Image className="size-3.5" />}
        Generated Asset
      </h3>
      <div className="bg-muted/50 rounded-md p-3">
        {isAudio ? (
          <audio
            controls
            src={assetUrl}
            onError={() => setError(true)}
            className="w-full"
          />
        ) : (
          <img
            src={assetUrl}
            alt="Generated asset"
            onError={() => setError(true)}
            className="max-w-full max-h-96 rounded border border-border mx-auto block"
            style={{ imageRendering: 'pixelated' }}
          />
        )}
      </div>
    </section>
  )
}

interface RunInfo { attempt: number; fileCount: number }

function RunTabs({ runs, activeRun, onSelect }: {
  runs: RunInfo[]
  activeRun: number | null
  onSelect: (run: number | null) => void
}) {
  if (runs.length === 0) return null
  return (
    <div className="flex gap-1 mb-2 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'px-2 py-0.5 text-[10px] rounded-full border transition-colors',
          activeRun === null
            ? 'bg-primary text-primary-foreground border-primary'
            : 'border-border text-muted-foreground hover:border-primary/50',
        )}
      >
        Current
      </button>
      {[...runs].reverse().map(r => (
        <button
          key={r.attempt}
          onClick={() => onSelect(r.attempt)}
          className={cn(
            'px-2 py-0.5 text-[10px] rounded-full border transition-colors',
            activeRun === r.attempt
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground hover:border-primary/50',
          )}
        >
          Run {r.attempt} ({r.fileCount})
        </button>
      ))}
    </div>
  )
}

function StyleExplorationGrid({ taskId }: { taskId: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [availableRuns, setAvailableRuns] = useState<RunInfo[]>([])
  const [activeRun, setActiveRun] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [cacheKey] = useState(() => Date.now())

  useEffect(() => {
    setLoading(true)
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

  if (loading && files.length === 0) {
    return <section><h3 className="text-sm font-medium mb-2">Style Variations</h3><p className="text-xs text-muted-foreground">Loading...</p></section>
  }

  if (files.length === 0 && availableRuns.length === 0) {
    return <section><h3 className="text-sm font-medium mb-2">Style Variations</h3><p className="text-xs text-muted-foreground">No variations generated yet</p></section>
  }

  const runSuffix = activeRun !== null ? `&run=${activeRun}` : ''

  return (
    <section>
      <h3 className="text-sm font-medium mb-2">Style Variations ({files.length})</h3>
      <RunTabs runs={availableRuns} activeRun={activeRun} onSelect={setActiveRun} />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {files.map((_, i) => (
          <div key={i} className="relative bg-muted/50 rounded border border-border overflow-hidden">
            <img
              src={`/api/foreman/tasks/${taskId}/asset/${i}?t=${cacheKey}${runSuffix}`}
              alt={`Variation ${i + 1}`}
              className="w-full aspect-square object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
            <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
              #{i + 1}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Use the Director review to select a style and lock it, or reject to generate new variations.
      </p>
    </section>
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
