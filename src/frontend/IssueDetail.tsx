import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, ExternalLink, Check, X, RotateCcw, Play, Wrench, ChevronRight, Search, Code, TestTube, ClipboardCheck, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import { StatusBadge } from './IssueList'
import * as api from './api'
import type { Issue, Run, StepData } from './api'

// ─── Types ────────────────────────────────────────────────────────────────────

interface IssueDetailProps {
  issue: Issue
  runs: Run[]  // all runs from poll data
  onBack: () => void
  onDataChange: () => void
}

const STAGE_ORDER = ['scout', 'implement', 'test_write', 'review'] as const
const STAGE_LABELS: Record<string, string> = {
  scout: 'Scout',
  implement: 'Implement',
  test_write: 'Test-Write',
  review: 'Review',
}
const STAGE_ICONS: Record<string, typeof Search> = {
  scout: Search,
  implement: Code,
  test_write: TestTube,
  review: ClipboardCheck,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

function parseSteps(output: string | null): StepData[] | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0].step === 'number') {
      return parsed as StepData[]
    }
  } catch { /* plain text */ }
  return null
}

// ─── Stage Stepper ────────────────────────────────────────────────────────────

function StageStepper({ runs, activeRunId, onSelectRun }: {
  runs: Run[]
  activeRunId: string | null
  onSelectRun: (runId: string) => void
}) {
  // Group runs by stage, pick latest per stage
  const stageRuns = new Map<string, Run>()
  for (const r of runs) {
    if (r.stage) stageRuns.set(r.stage, r)
  }

  return (
    <div className="px-6 py-3 border-b border-border flex items-center gap-1 overflow-x-auto">
      {STAGE_ORDER.map((stage, i) => {
        const run = stageRuns.get(stage)
        const Icon = STAGE_ICONS[stage]
        const isActive = run?.id === activeRunId
        const isDone = run?.status === 'pass'
        const isFail = run?.status === 'fail'
        const isRunning = run?.status === 'running' || run?.status === 'pending'

        return (
          <div key={stage} className="flex items-center gap-1">
            {i > 0 && <div className="w-4 h-px bg-border mx-0.5" />}
            <button
              onClick={() => run && onSelectRun(run.id)}
              disabled={!run}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                isActive && 'bg-accent ring-1 ring-primary/30',
                !isActive && run && 'hover:bg-accent/50 cursor-pointer',
                !run && 'opacity-40 cursor-default',
              )}
            >
              {isDone && <Check className="size-3 text-emerald-400" />}
              {isFail && <X className="size-3 text-destructive" />}
              {isRunning && <Spinner className="size-3" />}
              {!run && <Icon className="size-3 text-muted-foreground" />}
              <span className={cn(
                isDone && 'text-emerald-400',
                isFail && 'text-destructive',
                isRunning && 'text-foreground',
                !run && 'text-muted-foreground',
              )}>
                {STAGE_LABELS[stage]}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── Tool Call Detail (collapsible) ───────────────────────────────────────────

function ToolCallDetail({ call, result, duration }: {
  call: { tool: string; args: string }
  result?: { tool: string; result: string }
  duration: number
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{call.tool}</span>
        <span className="ml-auto text-muted-foreground opacity-60">{formatDuration(duration)}</span>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-2 border-t border-border">
          <div>
            <span className="text-muted-foreground font-medium">Args:</span>
            <pre className="mt-1 bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">{call.args}</pre>
          </div>
          {result && (
            <div>
              <span className="text-muted-foreground font-medium">Result:</span>
              <pre className="mt-1 bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">{result.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StepMessage({ step }: { step: StepData }) {
  const toolCalls = step.toolCalls ?? []
  const toolResults = step.toolResults ?? []

  return (
    <>
      {step.text && (
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>{step.text}</MessageResponse>
          </MessageContent>
        </Message>
      )}
      {toolCalls.length > 0 && (
        <div className="flex flex-col gap-1 max-w-[95%]">
          {toolCalls.map((tc, i) => (
            <ToolCallDetail
              key={`${step.step}-tc-${i}`}
              call={tc}
              result={toolResults[i]}
              duration={step.durationMs}
            />
          ))}
        </div>
      )}
    </>
  )
}

// ─── Live output hook ─────────────────────────────────────────────────────────

/** Uses runs from poll data (no extra API call), only fetches output for the active run */
function useLiveOutput(runs: Run[]) {
  const [activeRunOutput, setActiveRunOutput] = useState<{ steps: StepData[] | null; raw: string | null }>({ steps: null, raw: null })

  // Sort by creation time — runs from poll may be in any order
  const sortedRuns = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))

  // Active run = latest running/pending, or the last run overall
  const activeRun = sortedRuns.find(r => r.status === 'running' || r.status === 'pending')
    ?? sortedRuns[sortedRuns.length - 1]
    ?? null

  const fetchOutput = useCallback(() => {
    if (!activeRun) return
    api.getRunOutput(activeRun.id).then(({ output }) => {
      const parsed = parseSteps(output)
      if (parsed) setActiveRunOutput({ steps: parsed, raw: null })
      else if (output) setActiveRunOutput({ steps: null, raw: output })
    }).catch(() => {})
  }, [activeRun?.id])

  useEffect(() => {
    if (!activeRun) return
    fetchOutput()
    if (activeRun.status === 'running' || activeRun.status === 'pending') {
      const id = setInterval(fetchOutput, 2000)
      return () => clearInterval(id)
    }
  }, [activeRun?.id, activeRun?.status, fetchOutput])

  return { allRuns: sortedRuns, activeRun, activeRunOutput }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function IssueDetail({ issue, runs: pollRuns, onBack, onDataChange }: IssueDetailProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [viewingRunId, setViewingRunId] = useState<string | null>(null)
  const { allRuns, activeRun, activeRunOutput } = useLiveOutput(pollRuns)

  // Which run's output to show
  const displayRun = viewingRunId
    ? allRuns.find(r => r.id === viewingRunId) ?? activeRun
    : activeRun

  // Get output for the displayed run
  const [viewedOutput, setViewedOutput] = useState<{ steps: StepData[] | null; raw: string | null }>({ steps: null, raw: null })

  useEffect(() => {
    if (!displayRun || displayRun.id === activeRun?.id) {
      setViewedOutput(activeRunOutput)
      return
    }
    // Fetch output for a non-active run (completed stage)
    api.getRunOutput(displayRun.id).then(({ output }) => {
      const parsed = parseSteps(output)
      if (parsed) setViewedOutput({ steps: parsed, raw: null })
      else setViewedOutput({ steps: null, raw: output })
    }).catch(() => {})
  }, [displayRun?.id, activeRun?.id, activeRunOutput])

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

  const { steps, raw } = displayRun?.id === activeRun?.id ? activeRunOutput : viewedOutput

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
          {issue.retry_count > 0 && (
            <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full font-medium">
              Attempt {issue.retry_count + 1}/{4}
            </span>
          )}
        </div>
        {issue.description && (
          <p className="text-sm text-muted-foreground ml-9">{issue.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        {issue.status === 'pending' && (
          <Button size="sm" onClick={() => doAction('approve', () => api.approveIssue(issue.id))} disabled={!!actionLoading}>
            <Play className="size-3.5 mr-1" />
            {actionLoading === 'approve' ? 'Approving...' : 'Approve & Run'}
          </Button>
        )}
        {issue.status === 'awaiting_review' && (
          <>
            <Button size="sm" variant="default" onClick={() => doAction('approve-pr', () => api.approvePr(issue.id))} disabled={!!actionLoading}>
              <Check className="size-3.5 mr-1" />
              {actionLoading === 'approve-pr' ? 'Merging...' : 'Approve PR'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => doAction('reject-pr', () => api.rejectPr(issue.id))} disabled={!!actionLoading}>
              <X className="size-3.5 mr-1" />
              Reject PR
            </Button>
          </>
        )}
        {issue.status === 'failed' && (
          <Button size="sm" onClick={() => doAction('retry', () => api.retryIssue(issue.id))} disabled={!!actionLoading}>
            <RotateCcw className="size-3.5 mr-1" />
            {actionLoading === 'retry' ? 'Retrying...' : 'Retry'}
          </Button>
        )}
        {issue.git_pr_url && (
          <a href={issue.git_pr_url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-400 hover:underline ml-auto">
            PR #{issue.git_pr_number} <ExternalLink className="size-3" />
          </a>
        )}
        {actionError && <p className="text-sm text-destructive w-full mt-1">{actionError}</p>}
      </div>

      {/* Stage stepper */}
      {allRuns.some(r => r.stage) && (
        <StageStepper
          runs={allRuns}
          activeRunId={displayRun?.id ?? null}
          onSelectRun={(id) => setViewingRunId(id === activeRun?.id ? null : id)}
        />
      )}

      {/* Run metadata */}
      {displayRun && (
        <div className="px-6 py-2 border-b border-border flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {displayRun.stage && <span>Stage: <strong className="text-foreground">{STAGE_LABELS[displayRun.stage] ?? displayRun.stage}</strong></span>}
          <span>Status: <strong className="text-foreground">{displayRun.status}</strong></span>
          {displayRun.duration_ms != null && <span>Duration: {formatDuration(displayRun.duration_ms)}</span>}
          {displayRun.prompt_tokens != null && (
            <span>Tokens: {(displayRun.prompt_tokens + (displayRun.completion_tokens ?? 0)).toLocaleString()}</span>
          )}
          {issue.git_branch && <span>Branch: <code className="text-foreground">{issue.git_branch}</code></span>}
        </div>
      )}

      {/* Output */}
      {allRuns.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No run data yet.
        </div>
      )}
      {allRuns.length > 0 && (
        <Conversation className="flex-1 px-4">
          <ConversationContent>
            {/* Structured steps */}
            {steps?.map((step) => (
              <StepMessage key={step.step} step={step} />
            ))}

            {/* Plain text fallback */}
            {!steps && raw && (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse>{raw}</MessageResponse>
                </MessageContent>
              </Message>
            )}

            {/* Running indicator */}
            {displayRun && (displayRun.status === 'running' || displayRun.status === 'pending') && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Spinner className="size-4" />
                {displayRun.stage ? `${STAGE_LABELS[displayRun.stage]} is working` : 'Agent is working'}
                {steps?.length ? ` (step ${steps.length})` : ''}...
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
    </div>
  )
}
