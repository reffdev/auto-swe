import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { ArrowLeft, Shield, Bug, AlertTriangle, BarChart3, Trash2, Layers, TestTube, Zap, Accessibility, FileText, ChevronRight, Clock, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import * as api from './api'
import type { AnalysisRun, AnalysisConfig, AnalysisFinding } from './api'

const LENS_INFO: Record<string, { label: string; description: string; icon: typeof Shield }> = {
  security: { label: "Security", description: "Injection, secrets, auth gaps, dependencies", icon: Shield },
  bugs: { label: "Bug & Correctness", description: "Null access, race conditions, resource leaks", icon: Bug },
  error_handling: { label: "Error Handling", description: "Silent catches, missing boundaries, resilience", icon: AlertTriangle },
  complexity: { label: "Complexity", description: "Long functions, deep nesting, god objects", icon: BarChart3 },
  dead_code: { label: "Dead Code & Debt", description: "Unused exports, TODOs, duplication", icon: Trash2 },
  architecture: { label: "Architecture", description: "Layer violations, circular deps, inconsistencies", icon: Layers },
  testing: { label: "Testing Quality", description: "Coverage gaps, mock fidelity, anti-patterns", icon: TestTube },
  performance: { label: "Performance", description: "N+1 queries, unbounded fetches, missing cache", icon: Zap },
  accessibility: { label: "Accessibility", description: "ARIA, keyboard nav, semantic HTML, contrast", icon: Accessibility },
  documentation: { label: "Documentation", description: "Missing docs, stale comments, any usage", icon: FileText },
}

const FREQUENCY_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
]

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-500 bg-red-500/10",
  high: "text-orange-400 bg-orange-400/10",
  medium: "text-yellow-400 bg-yellow-400/10",
  low: "text-blue-400 bg-blue-400/10",
}

interface AnalysisViewProps {
  projectId: string
}

export function AnalysisView({ projectId }: AnalysisViewProps) {
  const navigate = useNavigate()
  const [configs, setConfigs] = useState<AnalysisConfig[]>([])
  const [runs, setRuns] = useState<AnalysisRun[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRun, setSelectedRun] = useState<AnalysisRun | null>(null)
  const [triggering, setTriggering] = useState<string | null>(null)

  const fetchData = useCallback(() => {
    Promise.all([
      api.getAnalysisConfigs(projectId),
      api.getAnalysisRuns(projectId),
    ]).then(([c, r]) => { setConfigs(c); setRuns(r); }).catch(() => {}).finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const getConfig = (lensKey: string) => configs.find(c => c.lens_key === lensKey)
  const getLatestRun = (lensKey: string) => runs.find(r => r.lens_key === lensKey)

  const toggleLens = async (lensKey: string, currentlyEnabled: boolean) => {
    await api.updateAnalysisConfig(projectId, lensKey, { enabled: !currentlyEnabled })
    fetchData()
  }

  const setFrequency = async (lensKey: string, frequency: string) => {
    await api.updateAnalysisConfig(projectId, lensKey, { frequency })
    fetchData()
  }

  const triggerNow = async (lensKey: string) => {
    setTriggering(lensKey)
    try { await api.triggerAnalysis(projectId, lensKey) }
    catch { /* ignore */ }
    finally { setTriggering(null) }
  }

  if (selectedRun) {
    return <RunDetail run={selectedRun} onBack={() => setSelectedRun(null)} />
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/project/${projectId}`)}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-lg font-semibold">Analysis</h2>
        <span className="text-xs text-muted-foreground">Runs automatically when machines are idle</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="space-y-2 max-w-3xl">
            {Object.entries(LENS_INFO).map(([key, info]) => {
              const config = getConfig(key)
              const enabled = config?.enabled === 1
              const frequency = config?.frequency ?? 'weekly'
              const lastRun = config?.last_run_at
              const latestRun = getLatestRun(key)
              const summary = latestRun?.summary ? JSON.parse(latestRun.summary) as { total: number; critical: number; high: number; medium: number; low: number } : null
              const isRunning = latestRun?.status === 'running' || latestRun?.status === 'pending'
              const Icon = info.icon

              return (
                <div
                  key={key}
                  className={cn(
                    "rounded-lg border transition-colors",
                    enabled ? "border-border bg-card" : "border-transparent bg-muted/30 opacity-60"
                  )}
                >
                  {/* Config row */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      onClick={() => toggleLens(key, enabled)}
                      className={cn(
                        'relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                        enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                      )}
                      role="switch"
                      aria-checked={enabled}
                    >
                      <span className={cn(
                        'pointer-events-none block h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
                        enabled ? 'translate-x-3' : 'translate-x-0'
                      )} />
                    </button>

                    <Icon className="size-4 text-muted-foreground shrink-0" />

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{info.label}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{info.description}</div>
                    </div>

                    {enabled && (
                      <select
                        value={frequency}
                        onChange={(e) => setFrequency(key, e.target.value)}
                        className="text-xs bg-muted border-none rounded px-2 py-1 text-muted-foreground cursor-pointer"
                      >
                        {FREQUENCY_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    )}

                    {enabled && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => triggerNow(key)}
                        disabled={triggering === key || isRunning}
                        title="Run now"
                      >
                        <Play className={cn("size-3", (triggering === key || isRunning) && "animate-pulse")} />
                      </Button>
                    )}

                    {lastRun && (
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">
                        {new Date(lastRun).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* Results row — show if there's a completed run */}
                  {enabled && latestRun && latestRun.status !== 'pending' && (
                    <button
                      onClick={() => setSelectedRun(latestRun)}
                      className="w-full text-left px-4 py-2 border-t border-border/50 hover:bg-accent/30 transition-colors flex items-center gap-2"
                    >
                      {isRunning && <span className="text-xs text-yellow-400 animate-pulse">Running...</span>}
                      {summary && (
                        <div className="flex gap-1.5 flex-1">
                          {summary.critical > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full text-red-500 bg-red-500/10 font-medium">{summary.critical} critical</span>}
                          {summary.high > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full text-orange-400 bg-orange-400/10 font-medium">{summary.high} high</span>}
                          {summary.medium > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full text-yellow-400 bg-yellow-400/10 font-medium">{summary.medium} med</span>}
                          {summary.low > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full text-blue-400 bg-blue-400/10 font-medium">{summary.low} low</span>}
                          {summary.total === 0 && <span className="text-[10px] text-emerald-400">No issues found</span>}
                        </div>
                      )}
                      {latestRun.status === 'fail' && !summary && <span className="text-xs text-destructive flex-1">Analysis failed</span>}
                      <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Run Detail ──────────────────────────────────────────────────────────────

function RunDetail({ run, onBack }: { run: AnalysisRun; onBack: () => void }) {
  const label = LENS_INFO[run.lens_key]?.label ?? run.lens_key
  const findings: AnalysisFinding[] = run.findings ? JSON.parse(run.findings) : []
  const summary = run.summary ? JSON.parse(run.summary) as { total: number; critical: number; high: number; medium: number; low: number } : null

  const grouped = {
    critical: findings.filter(f => f.severity === 'critical'),
    high: findings.filter(f => f.severity === 'high'),
    medium: findings.filter(f => f.severity === 'medium'),
    low: findings.filter(f => f.severity === 'low'),
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-lg font-semibold">{label}</h2>
        {summary && (
          <span className="text-xs text-muted-foreground ml-auto">
            {summary.total} finding{summary.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 max-w-3xl">
        {summary && summary.total > 0 && (
          <div className="flex gap-2 mb-6">
            {summary.critical > 0 && <span className="text-sm px-2.5 py-1 rounded-full text-red-500 bg-red-500/10 font-medium">{summary.critical} Critical</span>}
            {summary.high > 0 && <span className="text-sm px-2.5 py-1 rounded-full text-orange-400 bg-orange-400/10 font-medium">{summary.high} High</span>}
            {summary.medium > 0 && <span className="text-sm px-2.5 py-1 rounded-full text-yellow-400 bg-yellow-400/10 font-medium">{summary.medium} Medium</span>}
            {summary.low > 0 && <span className="text-sm px-2.5 py-1 rounded-full text-blue-400 bg-blue-400/10 font-medium">{summary.low} Low</span>}
          </div>
        )}

        {summary?.total === 0 && (
          <div className="text-center py-8 text-emerald-400">
            <p className="text-sm font-medium">No issues found</p>
          </div>
        )}

        {run.status === 'fail' && findings.length === 0 && (
          <div className="text-center py-8 text-destructive">
            <p className="text-sm font-medium">Analysis failed</p>
          </div>
        )}

        {(['critical', 'high', 'medium', 'low'] as const).map(severity => {
          const items = grouped[severity]
          if (items.length === 0) return null
          return (
            <div key={severity} className="mb-6">
              <h3 className={cn("text-xs font-semibold uppercase tracking-wide mb-3", SEVERITY_COLORS[severity]?.split(' ')[0])}>
                {severity} ({items.length})
              </h3>
              <div className="space-y-3">
                {items.map((finding, i) => (
                  <FindingCard key={i} finding={finding} />
                ))}
              </div>
            </div>
          )
        })}

        <div className="mt-8 pt-4 border-t border-border text-xs text-muted-foreground space-y-1">
          {run.started_at && <div>Started: {new Date(run.started_at).toLocaleString()}</div>}
          {run.completed_at && <div>Completed: {new Date(run.completed_at).toLocaleString()}</div>}
          {run.duration_ms && <div>Duration: {Math.round(run.duration_ms / 1000)}s</div>}
          {run.prompt_tokens && <div>Tokens: {run.prompt_tokens.toLocaleString()} prompt, {(run.completion_tokens ?? 0).toLocaleString()} completion</div>}
        </div>
      </div>
    </div>
  )
}

// ─── Finding Card ────────────────────────────────────────────────────────────

function FindingCard({ finding }: { finding: AnalysisFinding }) {
  const [expanded, setExpanded] = useState(finding.severity === 'critical' || finding.severity === 'high')

  return (
    <div className={cn("rounded-lg border", SEVERITY_COLORS[finding.severity]?.split(' ')[1] ?? 'border-border')}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2"
      >
        <ChevronRight className={cn("size-3.5 mt-0.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{finding.title}</div>
          <div className="text-[11px] text-muted-foreground font-mono">{finding.file}:{finding.line}</div>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pl-8 space-y-2">
          <p className="text-xs text-muted-foreground">{finding.description}</p>
          <div className="text-xs">
            <span className="text-muted-foreground font-medium">Fix: </span>
            <span className="text-foreground">{finding.recommendation}</span>
          </div>
        </div>
      )}
    </div>
  )
}
