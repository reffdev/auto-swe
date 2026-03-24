import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, ExternalLink, Check, X, RotateCcw, Play, Wrench, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
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

/** Parse the run output — either structured JSON steps or plain text */
function parseSteps(output: string | null): StepData[] | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0].step === 'number') {
      return parsed as StepData[]
    }
  } catch {
    // Plain text output (error messages, old format)
  }
  return null
}

function StepMessage({ step }: { step: StepData }) {
  return (
    <>
      {/* Tool calls — shown as assistant messages */}
      {step.toolCalls?.map((tc, i) => (
        <Message key={`${step.step}-tc-${i}`} from="assistant">
          <MessageContent>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Wrench className="size-3" />
              <span className="font-medium">{tc.tool}</span>
              <span className="ml-auto opacity-60">{formatDuration(step.durationMs)}</span>
            </div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">{tc.args}</pre>
          </MessageContent>
        </Message>
      ))}

      {/* Tool results — shown as "user" (system) messages */}
      {step.toolResults?.map((tr, i) => (
        <Message key={`${step.step}-tr-${i}`} from="user">
          <MessageContent>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Wrench className="size-3" />
              <span className="font-medium">{tr.tool} result</span>
            </div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">{tr.result}</pre>
          </MessageContent>
        </Message>
      ))}

      {/* Text output */}
      {step.text && (
        <Message from="assistant">
          <MessageContent>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <MessageSquare className="size-3" />
              <span className="font-medium">Agent</span>
            </div>
            <MessageResponse>{step.text}</MessageResponse>
          </MessageContent>
        </Message>
      )}
    </>
  )
}

/** Hook to poll live output while the run is active */
function useLiveOutput(run: Run | null) {
  const [steps, setSteps] = useState<StepData[] | null>(null)
  const [rawOutput, setRawOutput] = useState<string | null>(null)
  const currentRunId = useRef<string | null>(null)

  const poll = useCallback(() => {
    if (!run) return
    api.getRunOutput(run.id).then(({ output }) => {
      const parsed = parseSteps(output)
      if (parsed) {
        setSteps(parsed)
        setRawOutput(null)
      } else if (output) {
        setSteps(null)
        setRawOutput(output)
      }
      // If output is null (new run, no data yet), keep showing previous state
    }).catch(() => { /* ignore polling errors */ })
  }, [run?.id])

  useEffect(() => {
    if (!run) return

    // Only reset state when switching to a genuinely different run
    if (run.id !== currentRunId.current) {
      currentRunId.current = run.id
      // Don't clear steps/rawOutput — keep showing previous run's output
      // until new run produces something. Only clear for brand new issues.
      if (!run.output) {
        setSteps(null)
        setRawOutput(null)
      }
    }

    // Load from run prop
    const parsed = parseSteps(run.output)
    if (parsed) { setSteps(parsed); setRawOutput(null) }
    else if (run.output) { setSteps(null); setRawOutput(run.output) }

    // Poll while running or pending
    if (run.status === 'running' || run.status === 'pending') {
      poll() // immediate first poll
      const id = setInterval(poll, 2000)
      return () => clearInterval(id)
    }
  }, [run?.id, run?.status, run?.output, poll])

  return { steps, rawOutput }
}

export function IssueDetail({ issue, run, onBack, onDataChange }: IssueDetailProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { steps, rawOutput } = useLiveOutput(run)

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

      {/* Run metadata bar */}
      {run && (
        <div className="px-6 py-2 border-b border-border flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>Run: <strong className="text-foreground">{run.status}</strong></span>
          {run.duration_ms != null && <span>Duration: {formatDuration(run.duration_ms)}</span>}
          {run.prompt_tokens != null && (
            <span>Tokens: {(run.prompt_tokens + (run.completion_tokens ?? 0)).toLocaleString()}</span>
          )}
          {steps && <span>Steps: {steps.length}</span>}
          {issue.git_branch && <span>Branch: <code className="text-foreground">{issue.git_branch}</code></span>}
        </div>
      )}

      {/* Agent output as conversation */}
      {!run && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No run data yet.
        </div>
      )}
      {run && (
        <Conversation className="flex-1 px-4">
          <ConversationContent>
            {/* The user's issue as the first message */}
            <Message from="user">
              <MessageContent>
                <MessageResponse>{`**${issue.title}**\n\n${issue.description || ''}`}</MessageResponse>
              </MessageContent>
            </Message>

            {/* Structured steps */}
            {steps?.map((step) => (
              <StepMessage key={step.step} step={step} />
            ))}

            {/* Fallback: plain text output (errors, old runs) */}
            {!steps && rawOutput && (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse>{rawOutput}</MessageResponse>
                </MessageContent>
              </Message>
            )}

            {/* Running indicator */}
            {(run.status === 'running' || run.status === 'pending') && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Spinner className="size-4" />
                Agent is working{steps?.length ? ` (step ${steps.length})` : ''}...
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
    </div>
  )
}
