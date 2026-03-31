import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { ArrowLeft, Shield, Bug, AlertTriangle, BarChart3, Trash2, Layers, TestTube, Zap, Accessibility, FileText, ChevronRight, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import * as api from './api'
import type { AnalysisRun, AnalysisFinding } from './api'

const LENS_ICONS: Record<string, typeof Shield> = {
  security: Shield, bugs: Bug, error_handling: AlertTriangle,
  complexity: BarChart3, dead_code: Trash2, architecture: Layers,
  testing: TestTube, performance: Zap, accessibility: Accessibility,
  documentation: FileText,
}

const LENS_LABELS: Record<string, string> = {
  security: "Security", bugs: "Bug & Correctness", error_handling: "Error Handling",
  complexity: "Complexity", dead_code: "Dead Code & Debt", architecture: "Architecture",
  testing: "Testing Quality", performance: "Performance", accessibility: "Accessibility",
  documentation: "Documentation",
}

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
  const [runs, setRuns] = useState<AnalysisRun[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRun, setSelectedRun] = useState<AnalysisRun | null>(null)

  useEffect(() => {
    api.getAnalysisRuns(projectId).then(setRuns).catch(() => {}).finally(() => setLoading(false))
    const interval = setInterval(() => {
      api.getAnalysisRuns(projectId).then(setRuns).catch(() => {})
    }, 10_000)
    return () => clearInterval(interval)
  }, [projectId])

  // Group by lens_key, show latest per lens
  const latestByLens = new Map<string, AnalysisRun>()
  for (const run of runs) {
    if (!latestByLens.has(run.lens_key) || (run.started_at && run.started_at > (latestByLens.get(run.lens_key)!.started_at ?? ''))) {
      latestByLens.set(run.lens_key, run)
    }
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
        <h2 className="text-lg font-semibold">Analysis Results</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : latestByLens.size === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-sm">No analysis results yet.</p>
            <p className="text-xs mt-1">Enable analyses in Project Settings and they&apos;ll run automatically when machines are idle.</p>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl">
            {[...latestByLens.entries()].map(([lensKey, run]) => {
              const Icon = LENS_ICONS[lensKey] ?? Shield
              const label = LENS_LABELS[lensKey] ?? lensKey
              const summary = run.summary ? JSON.parse(run.summary) as { total: number; critical: number; high: number; medium: number; low: number } : null
              const isRunning = run.status === 'running' || run.status === 'pending'

              return (
                <button
                  key={lensKey}
                  onClick={() => setSelectedRun(run)}
                  className="w-full text-left px-4 py-3 rounded-lg border border-border bg-card hover:bg-accent/30 transition-colors flex items-center gap-3"
                >
                  <Icon className="size-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{label}</div>
                    {isRunning && <span className="text-xs text-yellow-400 animate-pulse">Running...</span>}
                    {summary && (
                      <div className="flex gap-2 mt-1">
                        {summary.critical > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded-full text-red-500 bg-red-500/10 font-medium">{summary.critical} critical</span>}
                        {summary.high > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded-full text-orange-400 bg-orange-400/10 font-medium">{summary.high} high</span>}
                        {summary.medium > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded-full text-yellow-400 bg-yellow-400/10 font-medium">{summary.medium} med</span>}
                        {summary.low > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded-full text-blue-400 bg-blue-400/10 font-medium">{summary.low} low</span>}
                        {summary.total === 0 && <span className="text-[11px] text-emerald-400">No issues found</span>}
                      </div>
                    )}
                    {run.status === 'fail' && !summary && <span className="text-xs text-destructive">Analysis failed</span>}
                  </div>
                  {run.completed_at && (
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 flex items-center gap-1">
                      <Clock className="size-3" />
                      {new Date(run.completed_at).toLocaleDateString()}
                    </span>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                </button>
              )
            })}
          </div>
        )}

        {/* History */}
        {runs.length > latestByLens.size && (
          <div className="mt-8 max-w-3xl">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">History</h3>
            <div className="space-y-1">
              {runs.filter(r => r.status !== 'pending').map(run => {
                const label = LENS_LABELS[run.lens_key] ?? run.lens_key
                const summary = run.summary ? JSON.parse(run.summary) as { total: number } : null
                return (
                  <button
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-accent/30 transition-colors flex items-center gap-2 text-xs"
                  >
                    <span className="text-muted-foreground w-20 shrink-0">{run.started_at ? new Date(run.started_at).toLocaleDateString() : '—'}</span>
                    <span className="font-medium flex-1">{label}</span>
                    {summary && <span className="text-muted-foreground">{summary.total} findings</span>}
                    {run.status === 'fail' && <span className="text-destructive">failed</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Run Detail ──────────────────────────────────────────────────────────────

function RunDetail({ run, onBack }: { run: AnalysisRun; onBack: () => void }) {
  const label = LENS_LABELS[run.lens_key] ?? run.lens_key
  const findings: AnalysisFinding[] = run.findings ? JSON.parse(run.findings) : []
  const summary = run.summary ? JSON.parse(run.summary) as { total: number; critical: number; high: number; medium: number; low: number } : null

  // Group findings by severity
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
        {/* Summary badges */}
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
            <p className="text-xs text-muted-foreground mt-1">The codebase looks clean for this analysis category.</p>
          </div>
        )}

        {run.status === 'fail' && findings.length === 0 && (
          <div className="text-center py-8 text-destructive">
            <p className="text-sm font-medium">Analysis failed</p>
            <p className="text-xs text-muted-foreground mt-1">The analysis could not be completed.</p>
          </div>
        )}

        {/* Findings by severity */}
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

        {/* Metadata */}
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
