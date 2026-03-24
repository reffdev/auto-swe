import { useState, useEffect } from 'react'
import { ArrowLeft, Trash2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Machine } from './api'

interface MachineDetailProps {
  machine: Machine
  onBack: () => void
  onDataChange: () => void
}

export function MachineDetail({ machine, onBack, onDataChange }: MachineDetailProps) {
  const [name, setName] = useState(machine.name)
  const [baseUrl, setBaseUrl] = useState(machine.base_url)
  const [modelId, setModelId] = useState(machine.model_id)
  const [enabled, setEnabled] = useState(!!machine.enabled)
  const [contextLimit, setContextLimit] = useState(machine.context_limit?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Sync form when machine prop changes (from polling)
  useEffect(() => {
    setName(machine.name)
    setBaseUrl(machine.base_url)
    setModelId(machine.model_id)
    setEnabled(!!machine.enabled)
    setContextLimit(machine.context_limit?.toString() ?? '')
  }, [machine.id, machine.name, machine.base_url, machine.model_id, machine.enabled, machine.context_limit])

  const parsedContextLimit = contextLimit ? parseInt(contextLimit, 10) || null : null
  const hasChanges =
    name !== machine.name ||
    baseUrl !== machine.base_url ||
    modelId !== machine.model_id ||
    parsedContextLimit !== (machine.context_limit ?? null) ||
    enabled !== !!machine.enabled

  const handleSave = async () => {
    setError(null)
    setSuccess(false)
    setSaving(true)
    try {
      await api.updateMachine(machine.id, {
        name,
        base_url: baseUrl,
        model_id: modelId,
        enabled: enabled ? 1 : 0,
        context_limit: parsedContextLimit,
      })
      setSuccess(true)
      onDataChange()
      setTimeout(() => setSuccess(false), 2000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete machine "${machine.name || machine.model_id}"?`)) return
    setError(null)
    setDeleting(true)
    try {
      await api.deleteMachine(machine.id)
      onDataChange()
      onBack()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <h2 className="text-base font-semibold flex-1">Machine Settings</h2>
          <span className={cn(
            'text-xs font-medium px-2 py-0.5 rounded-full',
            machine.status === 'idle'
              ? 'bg-muted-foreground/20 text-muted-foreground'
              : 'bg-green-500/20 text-green-400'
          )}>
            {machine.status}
          </span>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-lg space-y-5">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. local-gpu" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Base URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.50:8080/v1" />
            <p className="text-xs text-muted-foreground mt-1">OpenAI-compatible API endpoint</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Model ID</label>
            <Input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="e.g. qwen2.5-coder-32b" />
            <p className="text-xs text-muted-foreground mt-1">Model name the server expects</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Context Limit (tokens)</label>
            <Input value={contextLimit} onChange={(e) => setContextLimit(e.target.value)} placeholder="128000" type="number" />
            <p className="text-xs text-muted-foreground mt-1">Model's context window size. Leave empty for default (128k). Tool output truncation scales to this.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setEnabled(!enabled)}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                enabled ? 'bg-primary' : 'bg-muted-foreground/30'
              )}
            >
              <span className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0'
              )} />
            </button>
            <label className="text-sm">Enabled</label>
          </div>

          {machine.current_run_id && (
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Current Run</label>
              <code className="text-sm">{machine.current_run_id}</code>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">ID</label>
            <code className="text-xs text-muted-foreground">{machine.id}</code>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-emerald-400">Saved</p>}
        </div>
      </div>

      {/* Actions */}
      <div className="px-6 py-4 border-t border-border flex items-center gap-3">
        <Button onClick={handleSave} disabled={!hasChanges || !baseUrl || !modelId || saving}>
          <Save className="size-3.5 mr-1.5" />
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
        <Button
          variant="outline"
          onClick={handleDelete}
          disabled={machine.status === 'working' || deleting}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5 mr-1.5" />
          {deleting ? 'Deleting...' : 'Delete Machine'}
        </Button>
        {machine.status === 'working' && (
          <span className="text-xs text-muted-foreground">Cannot delete while working</span>
        )}
      </div>
    </div>
  )
}
