import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Save, RefreshCw } from 'lucide-react'
import * as api from './api'
import type { ForemanConfig as ForemanConfigType, Project } from './api'

export function ForemanConfig() {
  const [config, setConfig] = useState<ForemanConfigType | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
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

  const load = useCallback(async () => {
    try {
      const [c, pollData] = await Promise.all([
        api.getForemanConfig(),
        api.poll(),
      ])
      setConfig(c)
      setProjects(pollData.projects)
      if (c) {
        setEnabled(!!c.enabled)
        setProjectId(c.project_id ?? '')
        setTasksDir(c.tasks_dir ?? '')
        setPriorityMode(c.priority_mode)
        setContinuousExploration(!!c.continuous_exploration)
        setExplorationPreset(c.exploration_preset ?? 'concept')
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

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
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
