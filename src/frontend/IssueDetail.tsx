import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, ExternalLink, Check, X, RotateCcw, Play, Wrench, ChevronRight, Search, Code, TestTube, ClipboardCheck, GitBranch, Square, Shield, Monitor, Zap, FlaskConical, ShieldAlert, Layers, Scissors, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
import { PrDiffView } from './PrDiffView'
import * as api from './api'
import type { Issue, Run, StepData } from './api'

// ─── Types ────────────────────────────────────────────────────────────────────

interface IssueDetailProps {
  issue: Issue
  runs: Run[]  // all runs from poll data
  onBack: () => void
  onDataChange: () => void
}

const FIXED_STAGES = ['scout', 'implement', 'build_gate', 'test_write', 'test_gate'] as const
const STAGE_LABELS: Record<string, string> = {
  scout: 'Scout',
  implement: 'Implement',
  build_gate: 'Build',
  test_write: 'Test-Write',
  test_gate: 'Tests',
}

function getStageLabel(stage: string): string {
  if (stage.startsWith("review:")) {
    const lens = stage.slice(7)
    const lensInfo = LENS_STEPPER_CONFIG[lens]
    return lensInfo?.label ?? `Review (${lens})`
  }
  return STAGE_LABELS[stage] ?? stage
}
const STAGE_ICONS: Record<string, typeof Search> = {
  scout: Search,
  implement: Code,
  build_gate: ClipboardCheck,
  test_write: TestTube,
  test_gate: FlaskConical,
}

const LENS_STEPPER_CONFIG: Record<string, { label: string; color: string; icon: typeof Search }> = {
  general: { label: 'General', color: 'text-foreground', icon: ClipboardCheck },
  security: { label: 'Security', color: 'text-orange-400', icon: Shield },
  ui: { label: 'UI', color: 'text-purple-400', icon: Monitor },
  performance: { label: 'Perf', color: 'text-cyan-400', icon: Zap },
  testing: { label: 'Testing', color: 'text-green-400', icon: FlaskConical },
  error_handling: { label: 'Errors', color: 'text-red-400', icon: ShieldAlert },
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
  // Only show runs from the current pipeline execution.
  const latestScout = [...runs].reverse().find(r => r.stage === 'scout')
  const currentRuns = latestScout
    ? runs.filter(r => r.created_at >= latestScout.created_at)
    : runs

  // Group by exact stage — fixed stages + individual review lenses
  const stageRuns = new Map<string, Run>()
  for (const r of currentRuns) {
    if (r.stage) stageRuns.set(r.stage, r)
  }

  // Collect review lens runs in order
  const reviewRuns: Array<{ lensKey: string; run: Run }> = []
  for (const r of currentRuns) {
    if (r.stage?.startsWith("review:")) {
      const lensKey = r.stage.slice(7)
      // Only keep latest per lens
      const existing = reviewRuns.findIndex(rr => rr.lensKey === lensKey)
      if (existing >= 0) reviewRuns[existing] = { lensKey, run: r }
      else reviewRuns.push({ lensKey, run: r })
    }
  }

  // Build step list: fixed stages + review lenses
  type StepInfo = { key: string; label: string; icon: typeof Search; color?: string; run?: Run }
  const steps: StepInfo[] = FIXED_STAGES.map(stage => ({
    key: stage,
    label: STAGE_LABELS[stage],
    icon: STAGE_ICONS[stage],
    run: stageRuns.get(stage),
  }))

  for (const { lensKey, run } of reviewRuns) {
    const config = LENS_STEPPER_CONFIG[lensKey]
    steps.push({
      key: `review:${lensKey}`,
      label: config?.label ?? lensKey,
      icon: config?.icon ?? ClipboardCheck,
      color: config?.color,
      run,
    })
  }

  return (
    <div className="px-6 py-3 border-b border-border flex items-center gap-1 overflow-x-auto">
      {steps.map((step, i) => {
        const { run, icon: Icon, label, color } = step
        const isActive = run?.id === activeRunId
        const isDone = run?.status === 'pass'
        const isFail = run?.status === 'fail'
        const isRunning = run?.status === 'running' || run?.status === 'pending'

        return (
          <div key={step.key} className="flex items-center gap-1">
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
                isRunning && (color ?? 'text-foreground'),
                !run && 'text-muted-foreground',
                !isDone && !isFail && !isRunning && run && (color ?? 'text-foreground'),
              )}>
                {label}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── Tool Call Detail (collapsible) ───────────────────────────────────────────

function toolPreview(tool: string, args: string, result?: string): string {
  try {
    const parsed = JSON.parse(args)
    switch (tool) {
      case 'readFile':
      case 'writeFile':
      case 'replaceInFile':
      case 'appendToFile':
      case 'deleteFile':
      case 'getFileInfo':
        return parsed.path ?? ''
      case 'listDirectory':
        return parsed.path ?? '.'
      case 'moveFile':
        return `${parsed.source ?? '?'} → ${parsed.destination ?? '?'}`
      case 'searchFiles':
        return parsed.pattern ? `/${parsed.pattern}/${parsed.glob ? ` in ${parsed.glob}` : ''}` : ''
      case 'runCommand':
        return parsed.command ? parsed.command.slice(0, 80) : ''
      case 'readRelevantFiles':
        if (result) {
          const count = (result.match(/^### /gm) ?? []).length
          return count > 0 ? `${count} files` : ''
        }
        return ''
      case 'saveCheckpoint': {
        const files = parsed.files
        return Array.isArray(files) ? `${files.length} files` : ''
      }
      case 'gitStatus':
      case 'gitDiff':
        return ''
      default:
        return ''
    }
  } catch {
    return ''
  }
}

function resultPreview(tool: string, result?: string): string | null {
  if (!result) return null
  switch (tool) {
    case 'readFile':
    case 'readRelevantFiles': {
      const lines = result.split('\n').length
      return `${lines} lines`
    }
    case 'searchFiles': {
      const matches = (result.match(/\n/g) ?? []).length
      return matches > 0 ? `${matches} matches` : 'no matches'
    }
    case 'runCommand': {
      const exitMatch = result.match(/^Exit (\d+)/)
      if (exitMatch) return `exit ${exitMatch[1]}`
      const lines = result.split('\n').length
      return lines > 1 ? `${lines} lines output` : result.slice(0, 60)
    }
    case 'replaceInFile':
      return result.includes('Replaced') ? '✓' : result.slice(0, 40)
    case 'writeFile':
      return result.includes('Wrote') ? '✓' : result.slice(0, 40)
    default:
      return null
  }
}

function ToolCallDetail({ call, result, duration }: {
  call: { tool: string; args: string }
  result?: { tool: string; result: string }
  duration: number
}) {
  const [open, setOpen] = useState(false)
  const preview = toolPreview(call.tool, call.args, result?.result)
  const resPreview = resultPreview(call.tool, result?.result)

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{call.tool}</span>
        {preview && <span className="text-muted-foreground font-mono truncate max-w-[50%]">{preview}</span>}
        {resPreview && <span className="text-muted-foreground opacity-70">→ {resPreview}</span>}
        <span className="ml-auto text-muted-foreground opacity-60 shrink-0">{formatDuration(duration)}</span>
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

function PromptSection({ label, content, tokenEst }: { label: string; content: string; tokenEst: number }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Code className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{label}</span>
        <span className="ml-auto text-muted-foreground opacity-60">~{tokenEst.toLocaleString()} tokens</span>
      </button>
      {open && (
        <div className="border-t border-border">
          <pre className="p-3 overflow-x-auto whitespace-pre-wrap overflow-y-auto max-h-[70vh] text-[11px]">{content}</pre>
        </div>
      )}
    </div>
  )
}

function PromptsDetail({ prompts }: { prompts: { system: string; user: string } }) {
  return (
    <div className="flex flex-col gap-1 max-w-[95%]">
      <PromptSection label="System Prompt" content={prompts.system} tokenEst={Math.round(prompts.system.length / 4)} />
      <PromptSection label="User Prompt (includes checkpoint)" content={prompts.user} tokenEst={Math.round(prompts.user.length / 4)} />
    </div>
  )
}

function StepMessage({ step }: { step: StepData }) {
  const toolCalls = step.toolCalls ?? []
  const toolResults = step.toolResults ?? []

  return (
    <>
      {step.prompts && (
        <PromptsDetail prompts={step.prompts} />
      )}
      {step.text && !step.prompts && (
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
  const prevRunId = useRef<string | null>(null)

  // Sort by creation time — runs from poll may be in any order
  const sortedRuns = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))

  // Active run = latest running/pending, or the last run overall
  const activeRun = sortedRuns.find(r => r.status === 'running' || r.status === 'pending')
    ?? sortedRuns[sortedRuns.length - 1]
    ?? null

  // Clear output when the active run changes (new stage started)
  useEffect(() => {
    if (activeRun?.id !== prevRunId.current) {
      prevRunId.current = activeRun?.id ?? null
      setActiveRunOutput({ steps: null, raw: null })
    }
  }, [activeRun?.id])

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

// ─── Lens chips ──────────────────────────────────────────────────────────────

// ─── Editable description ─────────────────────────────────────────────────────

function EditableDescription({ issue, onDataChange }: { issue: Issue; onDataChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(issue.description)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.updateIssue(issue.id, { description: draft })
      onDataChange()
      setEditing(false)
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const handleCancel = () => {
    setDraft(issue.description)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="ml-9 mt-1">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={Math.max(4, draft.split('\n').length + 1)}
          className="text-sm font-mono"
          autoFocus
        />
        <div className="flex items-center gap-2 mt-2">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            <Check className="size-3 mr-1" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/desc flex items-start gap-1 ml-9 mt-1">
      {issue.description
        ? <p className="text-sm text-muted-foreground flex-1 whitespace-pre-wrap">{issue.description}</p>
        : <p className="text-sm text-muted-foreground/50 italic flex-1">No description</p>
      }
      <button
        onClick={() => { setDraft(issue.description); setEditing(true) }}
        className="opacity-0 group-hover/desc:opacity-100 transition-opacity shrink-0 p-1 rounded hover:bg-accent"
      >
        <Pencil className="size-3 text-muted-foreground" />
      </button>
    </div>
  )
}

// ─── Lens chips ──────────────────────────────────────────────────────────────

const ALL_LENSES = [
  { key: 'general', label: 'General', icon: ClipboardCheck, color: 'text-foreground bg-accent' },
  { key: 'security', label: 'Security', icon: Shield, color: 'text-orange-400 bg-orange-500/20' },
  { key: 'ui', label: 'UI', icon: Monitor, color: 'text-purple-400 bg-purple-500/20' },
  { key: 'performance', label: 'Performance', icon: Zap, color: 'text-cyan-400 bg-cyan-500/20' },
  { key: 'testing', label: 'Testing', icon: FlaskConical, color: 'text-green-400 bg-green-500/20' },
  { key: 'error_handling', label: 'Errors', icon: ShieldAlert, color: 'text-red-400 bg-red-500/20' },
] as const

function LensChips({ issue, editable, onDataChange }: { issue: Issue; editable: boolean; onDataChange: () => void }) {
  const currentLenses: string[] = issue.review_lenses ? JSON.parse(issue.review_lenses) : ['general']

  const toggleLens = async (key: string) => {
    if (key === 'general') return // Can't remove general
    const updated = currentLenses.includes(key)
      ? currentLenses.filter(l => l !== key)
      : [...currentLenses, key]
    try {
      await api.updateIssueLenses(issue.id, updated)
      onDataChange()
    } catch { /* ignore */ }
  }

  return (
    <div className="flex items-center gap-1.5 ml-9 mt-2">
      <span className="text-xs text-muted-foreground mr-1">Review:</span>
      {ALL_LENSES.map(lens => {
        const active = currentLenses.includes(lens.key)
        const Icon = lens.icon
        return (
          <button
            key={lens.key}
            onClick={() => editable && toggleLens(lens.key)}
            disabled={!editable || lens.key === 'general'}
            className={cn(
              'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full transition-colors',
              active ? lens.color : 'text-muted-foreground/50 bg-muted/30',
              editable && lens.key !== 'general' && 'cursor-pointer hover:opacity-80',
              (!editable || lens.key === 'general') && 'cursor-default',
            )}
          >
            <Icon className="size-3" />
            {lens.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Epic story list ──────────────────────────────────────────────────────────

function EpicStoryList({ epicId, projectId, onSelectIssue }: { epicId: string; projectId: string; onSelectIssue: (id: string) => void }) {
  const [children, setChildren] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getChildIssues(epicId).then(setChildren).finally(() => setLoading(false))
  }, [epicId])

  if (loading) return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading stories...</div>
  if (children.length === 0) return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">No stories</div>

  return (
    <div className="flex-1 overflow-y-auto">
      {children.map(child => (
        <button
          key={child.id}
          onClick={() => onSelectIssue(child.id)}
          className="w-full text-left px-6 py-3 border-b border-border hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground font-mono w-6 shrink-0">{child.sequence ?? '—'}.</span>
            <span className="font-medium text-sm truncate flex-1">{child.title}</span>
            <StatusBadge status={child.status} />
          </div>
          {child.description && (
            <p className="text-xs text-muted-foreground mt-1 ml-9 line-clamp-1">{child.description}</p>
          )}
        </button>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function IssueDetail({ issue, runs: pollRuns, onBack, onDataChange }: IssueDetailProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [viewingRunId, setViewingRunId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'pipeline' | 'diff'>('pipeline')
  const [diffEverOpened, setDiffEverOpened] = useState(false)
  const { allRuns, activeRun, activeRunOutput } = useLiveOutput(pollRuns)

  // Auto-switch to diff tab when PR is ready for review
  const hasBranch = !!issue.git_branch
  useEffect(() => {
    if (issue.status === 'awaiting_review' && hasBranch) {
      setActiveTab('diff')
      setDiffEverOpened(true)
    }
  }, [issue.status, hasBranch])

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
        <EditableDescription issue={issue} onDataChange={onDataChange} />
        <LensChips issue={issue} editable={issue.status === 'pending'} onDataChange={onDataChange} />
        {issue.parent_id && (
          <button
            onClick={() => onBack()}
            className="flex items-center gap-1.5 ml-9 mt-2 text-xs text-blue-400 hover:underline"
          >
            <Layers className="size-3" />
            Part of epic
          </button>
        )}
      </div>

      {/* Epic view — show stories instead of pipeline output */}
      {issue.status === 'epic' && (
        <EpicStoryList
          epicId={issue.id}
          projectId={issue.project_id}
          onSelectIssue={(id) => {
            const nav = `/project/${issue.project_id}/issue/${id}`
            window.location.hash = nav
          }}
        />
      )}

      {/* Actions + pipeline view (only for non-epic issues) */}
      {issue.status !== 'epic' && <>
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        {issue.status === 'pending' && (
          <Button size="sm" onClick={() => doAction('approve', () => api.approveIssue(issue.id))} disabled={!!actionLoading}>
            <Play className="size-3.5 mr-1" />
            {actionLoading === 'approve' ? 'Approving...' : 'Approve & Run'}
          </Button>
        )}
        {(issue.status === 'pending' || issue.status === 'failed') && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setActionLoading('decompose')
              setActionError(null)
              try {
                await api.decomposeIssue(issue.id)
                // Navigate away and back to force fresh data load with new epic status
                onDataChange()
                onBack()
              } catch (e: unknown) {
                setActionError(e instanceof Error ? e.message : String(e))
                setActionLoading(null)
              }
            }}
            disabled={!!actionLoading}
          >
            {actionLoading === 'decompose'
              ? <><Spinner className="size-3.5 mr-1" /> Analyzing — this may take a minute...</>
              : <><Scissors className="size-3.5 mr-1" /> Break into Stories</>
            }
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
        {(issue.status === 'running' || issue.status === 'approved') && (
          <Button size="sm" variant="outline" onClick={() => doAction('cancel', () => api.cancelIssue(issue.id))} disabled={!!actionLoading}>
            <Square className="size-3.5 mr-1" />
            {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel'}
          </Button>
        )}
        {issue.status === 'failed' && (
          <>
            <Button size="sm" onClick={() => doAction('retry', () => api.retryIssue(issue.id))} disabled={!!actionLoading}>
              <RotateCcw className="size-3.5 mr-1" />
              {actionLoading === 'retry' ? 'Retrying...' : 'Retry All'}
            </Button>
            {allRuns.some(r => r.stage) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => doAction('retry-stage', () => api.retryStage(issue.id))}
                disabled={!!actionLoading}
              >
                <RotateCcw className="size-3.5 mr-1" />
                {actionLoading === 'retry-stage' ? 'Resuming...' : 'Resume from Checkpoint'}
              </Button>
            )}
          </>
        )}
        {issue.git_pr_url && (
          <a href={issue.git_pr_url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-400 hover:underline ml-auto">
            PR #{issue.git_pr_number} <ExternalLink className="size-3" />
          </a>
        )}
        {actionError && <p className="text-sm text-destructive w-full mt-1">{actionError}</p>}
      </div>

      {/* View tabs */}
      {hasBranch && (
        <div className="px-6 py-2 border-b border-border flex items-center gap-1">
          <button
            onClick={() => setActiveTab('pipeline')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
              activeTab === 'pipeline' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Pipeline
          </button>
          <button
            onClick={() => { setActiveTab('diff'); setDiffEverOpened(true) }}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
              activeTab === 'diff' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Diff
          </button>
        </div>
      )}

      {/* Diff view — keep mounted once opened to avoid re-fetching on tab switch */}
      {diffEverOpened && hasBranch && (
        <div className={activeTab === 'diff' ? 'flex-1 flex flex-col overflow-hidden' : 'hidden'}>
          <PrDiffView issueId={issue.id} />
        </div>
      )}

      {/* Pipeline view */}
      {activeTab === 'pipeline' && <>
      {/* Stage stepper */}
      {allRuns.some(r => r.stage) && (
        <StageStepper
          runs={allRuns}
          activeRunId={displayRun?.id ?? null}
          onSelectRun={(id) => setViewingRunId(id === activeRun?.id ? null : id)}
        />
      )}

      {/* Run metadata + live stats */}
      {displayRun && (() => {
        const liveSteps = steps?.filter(s => s.durationMs > 0) ?? []
        const liveCompletion = liveSteps.reduce((sum, s) => sum + (s.tokens?.completion ?? 0), 0)
        const livePrompt = liveSteps.reduce((sum, s) => sum + (s.tokens?.prompt ?? 0), 0)
        const liveDuration = liveSteps.reduce((sum, s) => sum + s.durationMs, 0)

        // If the model doesn't report token usage, estimate from output text length (~4 chars/token)
        const estimatedCompletion = liveCompletion > 0 ? liveCompletion
          : liveSteps.reduce((sum, s) => {
              let chars = 0
              if (s.text) chars += s.text.length
              if (s.toolCalls) chars += s.toolCalls.reduce((c, tc) => c + tc.args.length, 0)
              return sum + Math.round(chars / 4)
            }, 0)

        const tokPerSec = liveDuration > 0 && estimatedCompletion > 0
          ? (estimatedCompletion / (liveDuration / 1000)).toFixed(1)
          : null
        const isEstimated = liveCompletion === 0 && estimatedCompletion > 0
        const totalTokens = displayRun.prompt_tokens != null
          ? (displayRun.prompt_tokens + (displayRun.completion_tokens ?? 0))
          : (livePrompt + estimatedCompletion) || null

        return (
          <div className="px-6 py-2 border-b border-border flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {displayRun.stage && <span>Stage: <strong className="text-foreground">{getStageLabel(displayRun.stage)}</strong></span>}
            <span>Status: <strong className="text-foreground">{displayRun.status}</strong></span>
            {displayRun.duration_ms != null && <span>Duration: {formatDuration(displayRun.duration_ms)}</span>}
            {totalTokens != null && <span>Tokens{isEstimated ? '~' : ''}: {totalTokens.toLocaleString()}</span>}
            {tokPerSec && Number(tokPerSec) > 0 && <span>Speed{isEstimated ? '~' : ''}: <strong className="text-foreground">{tokPerSec} tok/s</strong></span>}
            {liveSteps.length > 0 && <span>Steps: {liveSteps.length}</span>}
            {issue.git_branch && <span>Branch: <code className="text-foreground">{issue.git_branch}</code></span>}
          </div>
        )
      })()}

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
                {displayRun.stage ? `${getStageLabel(displayRun.stage)} is working` : 'Agent is working'}
                {steps?.length ? ` (step ${steps.length})` : ''}...
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
      </>}
      </>}
    </div>
  )
}
