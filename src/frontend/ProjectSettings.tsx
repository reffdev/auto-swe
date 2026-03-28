import { useState } from 'react'
import { ArrowLeft, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from './api'
import type { Project } from './api'

interface ProjectSettingsProps {
  project: Project
  onBack: () => void
  onDataChange: () => void
}

export function ProjectSettings({ project, onBack, onDataChange }: ProjectSettingsProps) {
  const [buildCommand, setBuildCommand] = useState(project.build_command ?? '')
  const [testCommand, setTestCommand] = useState(project.test_command ?? '')
  const [contextLimit, setContextLimit] = useState(project.context_limit?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedContextLimit = contextLimit ? parseInt(contextLimit) || null : null

  const hasChanges =
    (buildCommand || null) !== (project.build_command ?? null) ||
    (testCommand || null) !== (project.test_command ?? null) ||
    parsedContextLimit !== (project.context_limit ?? null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.updateProject(project.id, {
        build_command: buildCommand || null,
        test_command: testCommand || null,
        context_limit: parsedContextLimit,
      } as Partial<Project>)
      onDataChange()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
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
          <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Build & Test Commands</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Build Command</label>
              <Input
                value={buildCommand}
                onChange={e => setBuildCommand(e.target.value)}
                placeholder="npx tsc --noEmit"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used by <code className="bg-muted px-1 rounded">checkBuild</code> tool. Leave empty for default: <code className="bg-muted px-1 rounded">npx tsc --noEmit</code>
              </p>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Test Command</label>
              <Input
                value={testCommand}
                onChange={e => setTestCommand(e.target.value)}
                placeholder="npx jest --passWithNoTests --no-colors"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used by <code className="bg-muted px-1 rounded">checkTests</code> tool. Leave empty for default: <code className="bg-muted px-1 rounded">npx jest --passWithNoTests --no-colors</code>
              </p>
            </div>
          </div>
        </section>

        {/* Context limit */}
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Context Window</h3>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">Context Limit (tokens)</label>
            <Input
              value={contextLimit}
              onChange={e => setContextLimit(e.target.value)}
              placeholder="e.g. 32768"
              className="font-mono text-sm max-w-xs"
              type="number"
            />
            <p className="text-xs text-muted-foreground mt-1">
              When a stage's prompt tokens reach 75% of this limit, the agent checkpoints its progress and restarts with fresh context. Leave empty to disable compaction. Overrides the machine setting.
            </p>
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
      </div>
    </div>
  )
}
