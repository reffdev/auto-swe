import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Save, Shield, Bug, AlertTriangle, BarChart3, Trash2, Layers, TestTube, Zap, Accessibility, FileText, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Project, AnalysisConfig } from './api'

const ANALYSIS_LENS_INFO: Record<string, { label: string; description: string; icon: typeof Shield }> = {
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

interface ProjectSettingsProps {
  project: Project
  onBack: () => void
  onDataChange: () => void
}

export function ProjectSettings({ project, onBack, onDataChange }: ProjectSettingsProps) {
  const [buildCommand, setBuildCommand] = useState(project.build_command ?? '')
  const [testCommand, setTestCommand] = useState(project.test_command ?? '')
  const [lintCommand, setLintCommand] = useState(project.lint_command ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasChanges =
    (buildCommand || null) !== (project.build_command ?? null) ||
    (testCommand || null) !== (project.test_command ?? null) ||
    (lintCommand || null) !== (project.lint_command ?? null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.updateProject(project.id, {
        build_command: buildCommand || null,
        test_command: testCommand || null,
        lint_command: lintCommand || null,
      } as Partial<Project>)
      onDataChange()
      setSaved(true)
      setTimeout(() => { setSaved(false); }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-lg font-semibold">{project.name} — Settings</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8 max-w-2xl">
        {/* Read-only info */}
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Project Info</h3>
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Name</span>
              <span className="font-mono">{project.name}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Working Directory</span>
              <span className="font-mono text-xs">{project.workdir}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Git Remote</span>
              <span className="font-mono text-xs">{project.git_remote || '—'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Default Branch</span>
              <span className="font-mono">{project.git_default_branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Model</span>
              <span className="font-mono">{project.model_id || 'Machine default'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(project.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        </section>

        {/* Editable commands */}
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Build, Lint & Test Commands</h3>
          <div className="space-y-4">
            <div>
              <label htmlFor="project-build-command" className="block text-sm text-muted-foreground mb-1">Build Command</label>
              <Input
                id="project-build-command"
                value={buildCommand}
                onChange={e => { setBuildCommand(e.target.value); }}
                placeholder="npx tsc --noEmit"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used by <code className="bg-muted px-1 rounded">checkBuild</code> tool. Leave empty for default: <code className="bg-muted px-1 rounded">npx tsc --noEmit</code>
              </p>
            </div>
            <div>
              <label htmlFor="project-lint-command" className="block text-sm text-muted-foreground mb-1">Lint Command</label>
              <Input
                id="project-lint-command"
                value={lintCommand}
                onChange={e => { setLintCommand(e.target.value); }}
                placeholder="e.g. npx eslint . --max-warnings 0"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Runs after both build and test gates. Used by <code className="bg-muted px-1 rounded">checkLint</code> tool. Leave empty to skip lint checking.
              </p>
            </div>
            <div>
              <label htmlFor="project-test-command" className="block text-sm text-muted-foreground mb-1">Test Command</label>
              <Input
                id="project-test-command"
                value={testCommand}
                onChange={e => { setTestCommand(e.target.value); }}
                placeholder="npx jest --passWithNoTests --no-colors"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used by <code className="bg-muted px-1 rounded">checkTests</code> tool. Leave empty for default: <code className="bg-muted px-1 rounded">npx jest --passWithNoTests --no-colors</code>
              </p>
            </div>
          </div>
        </section>



        {/* Save */}
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!hasChanges || saving}>
            <Save className="size-3.5 mr-1" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
          {saved && <span className="text-sm text-emerald-400">Saved</span>}
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>

        {/* Automated Analysis */}
        <AnalysisSettings projectId={project.id} />
      </div>
    </div>
  )
}

// ─── Analysis Settings ───────────────────────────────────────────────────────

function AnalysisSettings({ projectId }: { projectId: string }) {
  const [configs, setConfigs] = useState<AnalysisConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState<string | null>(null)

  const fetchConfigs = useCallback(() => {
    api.getAnalysisConfigs(projectId).then(setConfigs).catch(() => {}).finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => { fetchConfigs() }, [fetchConfigs])

  const toggleLens = async (lensKey: string, currentlyEnabled: boolean) => {
    await api.updateAnalysisConfig(projectId, lensKey, { enabled: !currentlyEnabled })
    fetchConfigs()
  }

  const setFrequency = async (lensKey: string, frequency: string) => {
    await api.updateAnalysisConfig(projectId, lensKey, { frequency })
    fetchConfigs()
  }

  const triggerNow = async (lensKey: string) => {
    setTriggering(lensKey)
    try {
      await api.triggerAnalysis(projectId, lensKey)
    } catch { /* ignore */ }
    finally { setTriggering(null) }
  }

  const getConfig = (lensKey: string) => configs.find(c => c.lens_key === lensKey)

  return (
    <section>
      <h3 className="text-sm font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Automated Analysis</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Runs when machines are idle. Each category analyzes the codebase with a specific focus and produces actionable findings.
      </p>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <div className="space-y-2">
          {Object.entries(ANALYSIS_LENS_INFO).map(([key, info]) => {
            const config = getConfig(key)
            const enabled = config?.enabled === 1
            const frequency = config?.frequency ?? 'weekly'
            const lastRun = config?.last_run_at
            const Icon = info.icon

            return (
              <div
                key={key}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                  enabled ? "border-border bg-card" : "border-transparent bg-muted/30 opacity-60"
                )}
              >
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
                    disabled={triggering === key}
                    title="Run now"
                  >
                    <Play className={cn("size-3", triggering === key && "animate-pulse")} />
                  </Button>
                )}

                {lastRun && (
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">
                    {new Date(lastRun).toLocaleDateString()}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
