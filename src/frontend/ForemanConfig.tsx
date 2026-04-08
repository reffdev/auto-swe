import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Save, RefreshCw, AlertTriangle } from 'lucide-react'
import * as api from './api'
import type { ForemanConfig as ForemanConfigType, Machine, MachineBinding, Model, Project } from './api'

export function ForemanConfig() {
  const [config, setConfig] = useState<ForemanConfigType | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [bindings, setBindings] = useState<MachineBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Local form state
  const [enabled, setEnabled] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [tasksDir, setTasksDir] = useState('')
  const [priorityMode, setPriorityMode] = useState('parallel')
  const [continuousExploration, setContinuousExploration] = useState(false)
  const [explorationPreset, setExplorationPreset] = useState('concept')
  const [sandboxEnabled, setSandboxEnabled] = useState(false)
  const [directorInitiatedVerification, setDirectorInitiatedVerification] = useState(true)
  const [directorModelId, setDirectorModelId] = useState('')
  const [directorMachineId, setDirectorMachineId] = useState('')
  const [foremanCodeModelId, setForemanCodeModelId] = useState('')
  const [slotTestResult, setSlotTestResult] = useState<{ slot: string; result: api.SlotTestResult } | null>(null)
  const [testingSlot, setTestingSlot] = useState<string | null>(null)

  const handleTestSlot = async (slot: "director" | "foreman_code") => {
    setTestingSlot(slot)
    setSlotTestResult(null)
    try {
      const result = await api.testForemanSlot(slot)
      setSlotTestResult({ slot, result })
    } catch (e) {
      setSlotTestResult({ slot, result: { ok: false, error: e instanceof Error ? e.message : String(e) } })
    } finally {
      setTestingSlot(null)
    }
  }

  const load = useCallback(async () => {
    try {
      const [c, pollData, m, b] = await Promise.all([
        api.getForemanConfig(),
        api.poll(),
        api.getModels(),
        // Fetch all bindings up front so we can compute "models hosted on inference machines"
        api.getMachines().then(machines => Promise.all(machines.map(machine => api.getMachineBindings(machine.id))).then(arr => arr.flat())),
      ])
      setConfig(c)
      setProjects(pollData.projects)
      setMachines(pollData.machines)
      setModels(m)
      setBindings(b)
      if (c) {
        setEnabled(!!c.enabled)
        setProjectId(c.project_id ?? '')
        setTasksDir(c.tasks_dir ?? '')
        setPriorityMode(c.priority_mode)
        setContinuousExploration(!!c.continuous_exploration)
        setExplorationPreset(c.exploration_preset ?? 'concept')
        setSandboxEnabled(!!c.sandbox_enabled)
        setDirectorInitiatedVerification(c.director_initiated_verification == null ? true : !!c.director_initiated_verification)
        setDirectorModelId(c.director_model_id ?? '')
        setDirectorMachineId(c.director_machine_id ?? '')
        setForemanCodeModelId(c.foreman_code_model_id ?? '')
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  // Compute the set of logical models that are actually dispatchable: must
  // have at least one enabled binding on an enabled inference machine.
  // Truthy checks (instead of strict `=== 1`) so the picker stays consistent
  // with how MachineDetail displays bindings — a model that's visibly bound
  // on the machine page must also be selectable here.
  const inferenceModels = useMemo(() => {
    const inferenceMachineIds = new Set(machines.filter(m => !!m.enabled && m.machine_type === 'inference').map(m => m.id))
    const liveModelIds = new Set<string>()
    for (const b of bindings) {
      if (!!b.enabled && inferenceMachineIds.has(b.machine_id)) liveModelIds.add(b.model_id)
    }
    return models.filter(m => !m.archived_at && liveModelIds.has(m.id))
  }, [machines, bindings, models])

  // Machines that host the currently-selected Director model — used to populate the preferred-machine dropdown
  const directorHostMachines = useMemo(() => {
    if (!directorModelId) return [] as Machine[]
    const machineIds = new Set(bindings.filter(b => !!b.enabled && b.model_id === directorModelId).map(b => b.machine_id))
    return machines.filter(m => !!m.enabled && m.machine_type === 'inference' && machineIds.has(m.id))
  }, [bindings, machines, directorModelId])

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const updated = await api.updateForemanConfig({
        enabled: enabled ? 1 : 0,
        project_id: projectId || null,
        tasks_dir: tasksDir || null,
        priority_mode: priorityMode,
        continuous_exploration: continuousExploration ? 1 : 0,
        exploration_preset: explorationPreset,
        sandbox_enabled: sandboxEnabled ? 1 : 0,
        director_initiated_verification: directorInitiatedVerification ? 1 : 0,
        director_model_id: directorModelId || null,
        director_machine_id: directorMachineId || null,
        foreman_code_model_id: foremanCodeModelId || null,
      })
      setConfig(updated)
      setMessage('Configuration saved')
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Foreman Configuration</h2>
          <p className="text-xs text-muted-foreground">Configure the autonomous task scheduler</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={load}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-xl space-y-6">
          {/* Enable/disable */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Scheduler</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setEnabled(!enabled)}
                className={cn(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  enabled ? 'bg-emerald-500' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'inline-block size-4 rounded-full bg-white transition-transform',
                    enabled ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
              <span className="text-sm text-muted-foreground">
                {enabled ? 'Enabled — scheduler runs automatically' : 'Disabled — scheduler paused'}
              </span>
            </div>
          </div>

          {/* Project */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Target Project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select a project...</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">The project Foreman tasks will execute against</p>
          </div>

          {/* Tasks directory */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Tasks Directory</span>
            <Input
              placeholder="/path/to/tasks/backlog"
              value={tasksDir}
              onChange={(e) => setTasksDir(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Absolute path to the directory containing YAML task files</p>
          </div>

          {/* Priority mode */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Priority Mode</span>
            <div className="flex gap-2">
              {[
                { value: 'parallel', label: 'Parallel', desc: 'Run alongside issue pipelines' },
                { value: 'yield', label: 'Yield', desc: 'Pause when issues are running' },
                { value: 'exclusive', label: 'Exclusive', desc: 'Only run foreman tasks' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPriorityMode(opt.value)}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-md border text-sm transition-colors',
                    priorityMode === opt.value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/50',
                  )}
                >
                  <div className="font-medium text-xs">{opt.label}</div>
                  <div className="text-[10px] mt-0.5 text-muted-foreground">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Model slots — post logical-models refactor */}
          <div className="space-y-3 pt-2 border-t border-border">
            <div>
              <h3 className="text-sm font-semibold">Model Slots</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Director and Foreman code workloads are dispatched to whichever inference machine hosts the configured logical model. Models and bindings are managed on the Models page and per-machine.
              </p>
            </div>

            {(!directorModelId || !foremanCodeModelId) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="size-4 shrink-0 text-amber-400 mt-0.5" />
                <div className="text-xs text-amber-300">
                  {!directorModelId && <div>Director model is not configured — Director runs will fail until set.</div>}
                  {!foremanCodeModelId && <div>Foreman code model is not configured — Foreman code tasks and pipeline runs will fail until set.</div>}
                </div>
              </div>
            )}

            {inferenceModels.length === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No logical models are bound to any enabled inference machine yet. Create a model on the Models page, then bind it to a machine on the machine detail page.
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium block">Director model</label>
              <div className="flex items-center gap-2">
                <select
                  value={directorModelId}
                  onChange={e => {
                    setDirectorModelId(e.target.value)
                    // If the previously-preferred director machine no longer hosts the new model, clear it
                    if (e.target.value) {
                      const stillHosts = bindings.some(b => b.enabled === 1 && b.model_id === e.target.value && b.machine_id === directorMachineId)
                      if (!stillHosts) setDirectorMachineId('')
                    }
                  }}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Select a model —</option>
                  {inferenceModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name} — {m.slug}{m.family ? ` · ${m.family}` : ''}</option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleTestSlot("director")}
                  disabled={!directorModelId || testingSlot !== null}
                  title="Resolve the Director slot, acquire a lease, warm up the model, and report which machine answered."
                >
                  {testingSlot === "director" ? "Testing..." : "Test"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Used for Director conversation, planner, verifier, issue decomposition, and analysis runs.</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium block">Director preferred machine <span className="text-xs font-normal text-muted-foreground">(optional)</span></label>
              <select
                value={directorMachineId}
                onChange={e => setDirectorMachineId(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                disabled={!directorModelId || directorHostMachines.length === 0}
              >
                <option value="">Auto — pick least-loaded host</option>
                {directorHostMachines.map(m => (
                  <option key={m.id} value={m.id}>{m.name || m.base_url}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">When the Director model is hosted on multiple machines, pin a preferred one. Falls back to least-loaded if the preferred is busy.</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium block">Foreman code model</label>
              <div className="flex items-center gap-2">
                <select
                  value={foremanCodeModelId}
                  onChange={e => setForemanCodeModelId(e.target.value)}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Select a model —</option>
                  {inferenceModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name} — {m.slug}{m.family ? ` · ${m.family}` : ''}</option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleTestSlot("foreman_code")}
                  disabled={!foremanCodeModelId || testingSlot !== null}
                  title="Resolve the Foreman code slot, acquire a lease, warm up the model, and report which machine answered."
                >
                  {testingSlot === "foreman_code" ? "Testing..." : "Test"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Used for Foreman code tasks (and pipeline runs). Tasks may also set their own per-task <code className="text-[10px] bg-muted px-1 rounded">model_id</code> override.</p>
            </div>

            {slotTestResult && (
              <div className={cn(
                "rounded-md border px-3 py-2 text-xs",
                slotTestResult.result.ok
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                  : "border-destructive/40 bg-destructive/5 text-destructive",
              )}>
                <div className="font-medium mb-1">
                  {slotTestResult.result.ok ? "✓" : "✗"} {slotTestResult.slot === "director" ? "Director" : "Foreman code"} slot test
                </div>
                {slotTestResult.result.ok ? (
                  <div className="space-y-0.5 font-mono text-[11px]">
                    <div>model: {slotTestResult.result.model?.name} ({slotTestResult.result.model?.slug})</div>
                    <div>machine: {slotTestResult.result.machine}</div>
                    <div>provider_model_id: {slotTestResult.result.providerModelId}</div>
                    {slotTestResult.result.effectiveContextLimit && (
                      <div>effective context: {slotTestResult.result.effectiveContextLimit.toLocaleString()} tokens</div>
                    )}
                  </div>
                ) : (
                  <div>{slotTestResult.result.error}</div>
                )}
              </div>
            )}
          </div>

          {/* Continuous Art Exploration */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Continuous Art Exploration</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setContinuousExploration(!continuousExploration)}
                className={cn(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  continuousExploration ? 'bg-emerald-500' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'inline-block size-4 rounded-full bg-white transition-transform',
                    continuousExploration ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
              <span className="text-sm text-muted-foreground">
                {continuousExploration ? 'On — generates art batches continuously' : 'Off'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              When enabled, style exploration runs in a loop — each batch generates fresh prompts via LLM,
              renders them, and immediately starts the next batch. Leave on overnight to build a gallery.
            </p>
            {continuousExploration && (
              <div className="mt-3 space-y-2">
                <span className="text-xs font-medium block text-muted-foreground">Preset</span>
                <div className="flex gap-2">
                  {[
                    { value: 'concept', label: 'FLUX.2 (concept)', desc: 'High quality, slower' },
                    { value: 'fast_draft', label: 'SDXL (fast)', desc: 'Fast drafts, lower quality' },
                    { value: 'pixel_sprite', label: 'Pixel Art', desc: 'SDXL + pixel LoRA' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setExplorationPreset(opt.value)}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-md border text-sm transition-colors',
                        explorationPreset === opt.value
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:border-primary/50',
                      )}
                    >
                      <div className="font-medium text-xs">{opt.label}</div>
                      <div className="text-[10px] mt-0.5 text-muted-foreground">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sandbox isolation */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Agent Subprocess Sandbox</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSandboxEnabled(!sandboxEnabled)}
                className={cn(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  sandboxEnabled ? 'bg-emerald-500' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'inline-block size-4 rounded-full bg-white transition-transform',
                    sandboxEnabled ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
              <span className="text-sm text-muted-foreground">
                {sandboxEnabled ? 'On — agent subprocesses run inside bwrap' : 'Off — direct host execution'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Wraps every subprocess spawned from agent execution paths (Foreman tasks, pipeline stages, verifier,
              analysis) in a <a href="https://github.com/containers/bubblewrap" target="_blank" rel="noopener noreferrer" className="underline">bubblewrap</a> sandbox: read-only system,
              isolated <code className="text-[10px] bg-muted px-1 rounded">$HOME</code>, and the worktree as the only
              writable mount. Per-stage policy disables network for read-only stages
              (scout / review / verifier / analysis). Linux only — silently falls through to direct spawn on other
              hosts or when <code className="text-[10px] bg-muted px-1 rounded">bwrap</code> isn't installed.
              Per-project caches live under <code className="text-[10px] bg-muted px-1 rounded">~/.swe-cache/&lt;project_id&gt;/</code> so
              builds stay warm.
            </p>
          </div>

          {/* Director-initiated verification */}
          <div className="space-y-2">
            <span className="text-sm font-medium block">Director-Initiated Verification</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDirectorInitiatedVerification(!directorInitiatedVerification)}
                className={cn(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  directorInitiatedVerification ? 'bg-emerald-500' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'inline-block size-4 rounded-full bg-white transition-transform',
                    directorInitiatedVerification ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
              <span className="text-sm text-muted-foreground">
                {directorInitiatedVerification ? 'On — Director calls verifier as a tool' : 'Off — scheduler fires verifier at milestone boundaries'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              When on, the Director itself decides when to verify a milestone (via the
              <code className="text-[10px] bg-muted px-1 rounded">checkMilestoneReadyToAdvance</code> /
              <code className="text-[10px] bg-muted px-1 rounded">advanceMilestone</code> tools) instead of the
              scheduler firing the verifier automatically when all tasks complete. A backstop kicks in if the
              Director hasn't advanced after 3 ticks — falls back to scheduler-driven verification with a loud
              warning. Default: on.
            </p>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={saving}>
              <Save className="size-3.5 mr-1.5" />
              {saving ? 'Saving...' : 'Save Configuration'}
            </Button>
            {message && (
              <span className={cn('text-xs', message.startsWith('Error') ? 'text-destructive' : 'text-emerald-500')}>
                {message}
              </span>
            )}
          </div>

          {/* Status summary */}
          {config && (
            <div className="pt-4 border-t border-border">
              <h3 className="text-sm font-medium mb-2">Current State</h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">Scheduler:</span>
                <span className={config.enabled ? 'text-emerald-500' : 'text-muted-foreground'}>
                  {config.enabled ? 'Running' : 'Stopped'}
                </span>
                <span className="text-muted-foreground">Project:</span>
                <span>{projects.find(p => p.id === config.project_id)?.name ?? 'None'}</span>
                <span className="text-muted-foreground">Mode:</span>
                <span>{config.priority_mode}</span>
                <span className="text-muted-foreground">Scheduler:</span>
                <span>Event-driven</span>
                <span className="text-muted-foreground">Sandbox:</span>
                <span className={config.sandbox_enabled ? 'text-emerald-500' : 'text-muted-foreground'}>
                  {config.sandbox_enabled ? 'Enabled (bwrap, Linux)' : 'Disabled'}
                </span>
                <span className="text-muted-foreground">Verification:</span>
                <span className={config.director_initiated_verification ? 'text-emerald-500' : 'text-muted-foreground'}>
                  {config.director_initiated_verification ? 'Director-initiated (tool)' : 'Scheduler-driven (legacy)'}
                </span>
                <span className="text-muted-foreground">Lightweight pathway:</span>
                {(() => {
                  const npuMachines = machines.filter(m => !!m.enabled && m.machine_type === 'npu')
                  if (npuMachines.length > 0) {
                    const names = npuMachines.map(m => m.name || m.base_url).join(', ')
                    return (
                      <span className="text-emerald-500" title="Used by episodic-extractor, task-knowledge-extractor, art prompt revision">
                        On — {npuMachines.length} NPU machine{npuMachines.length === 1 ? '' : 's'} ({names})
                      </span>
                    )
                  }
                  return (
                    <span className="text-muted-foreground" title="Lightweight extractor / feedback work falls back to the Director model when no NPU is configured.">
                      Off — falls back to Director model
                    </span>
                  )
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
