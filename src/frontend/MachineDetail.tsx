import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Trash2, Save, Plus, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Machine, MachineBinding, Model } from './api'

interface MachineDetailProps {
  machine: Machine
  onBack: () => void
  onDataChange: () => void
}

export function MachineDetail({ machine, onBack, onDataChange }: MachineDetailProps) {
  const [name, setName] = useState(machine.name)
  const [baseUrl, setBaseUrl] = useState(machine.base_url)
  const [machineType, setMachineType] = useState<'inference' | 'comfyui' | 'npu'>(machine.machine_type as 'inference' | 'comfyui' | 'npu' ?? 'inference')
  const [enabled, setEnabled] = useState(!!machine.enabled)
  const [contextLimit, setContextLimit] = useState(machine.context_limit?.toString() ?? '')
  const [maxConcurrent, setMaxConcurrent] = useState(machine.max_concurrent?.toString() ?? '1')
  const [apiKey, setApiKey] = useState(machine.api_key ?? '')
  const [releaseUrl, setReleaseUrl] = useState(machine.release_url ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Sync form when machine prop changes (from polling)
  useEffect(() => {
    setName(machine.name)
    setBaseUrl(machine.base_url)
    setMachineType(machine.machine_type as 'inference' | 'comfyui' | 'npu' ?? 'inference')
    setEnabled(!!machine.enabled)
    setContextLimit(machine.context_limit?.toString() ?? '')
    setMaxConcurrent(machine.max_concurrent?.toString() ?? '1')
    setApiKey(machine.api_key ?? '')
    setReleaseUrl(machine.release_url ?? '')
  }, [machine.id, machine.name, machine.base_url, machine.machine_type, machine.enabled, machine.context_limit, machine.max_concurrent, machine.api_key, machine.release_url])

  const parsedContextLimit = contextLimit ? parseInt(contextLimit, 10) || null : null
  const parsedMaxConcurrent = parseInt(maxConcurrent, 10) || 1
  const hasChanges =
    name !== machine.name ||
    baseUrl !== machine.base_url ||
    machineType !== (machine.machine_type ?? 'inference') ||
    parsedContextLimit !== (machine.context_limit ?? null) ||
    parsedMaxConcurrent !== (machine.max_concurrent ?? 1) ||
    (apiKey || null) !== (machine.api_key ?? null) ||
    (releaseUrl || null) !== (machine.release_url ?? null) ||
    enabled !== !!machine.enabled

  const handleSave = async () => {
    setError(null)
    setSuccess(false)
    setSaving(true)
    try {
      const update: Record<string, unknown> = {
        name,
        base_url: baseUrl,
        machine_type: machineType,
        enabled: enabled ? 1 : 0,
        context_limit: parsedContextLimit,
        max_concurrent: parsedMaxConcurrent,
      }
      update.release_url = releaseUrl || null
      // Only send api_key if user changed it from the masked value
      if (apiKey !== (machine.api_key ?? '') && apiKey !== '••••••••') {
        update.api_key = apiKey || null
      }
      await api.updateMachine(machine.id, update as Partial<Machine>)
      setSuccess(true)
      onDataChange()
      setTimeout(() => { setSuccess(false); }, 2000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete machine "${machine.name || machine.id}"?`)) return
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
            <label htmlFor="machine-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Name</label>
            <Input id="machine-name" value={name} onChange={(e) => { setName(e.target.value); }} placeholder="e.g. local-gpu" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setMachineType('inference'); }}
                className={cn('px-3 py-1.5 text-sm rounded-md border transition-colors', machineType === 'inference' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground')}
              >Inference</button>
              <button
                onClick={() => { setMachineType('comfyui'); }}
                className={cn('px-3 py-1.5 text-sm rounded-md border transition-colors', machineType === 'comfyui' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground')}
              >ComfyUI</button>
              <button
                onClick={() => { setMachineType('npu'); }}
                className={cn('px-3 py-1.5 text-sm rounded-md border transition-colors', machineType === 'npu' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground')}
              >NPU</button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Inference: heavy LLM tasks. ComfyUI: art/music/sfx. NPU: lightweight extraction &amp; feedback.</p>
          </div>

          <div>
            <label htmlFor="machine-base-url" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Base URL</label>
            <Input id="machine-base-url" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); }} placeholder="https://openrouter.ai/api/v1" />
            <p className="text-xs text-muted-foreground mt-1">OpenAI-compatible API endpoint (OpenRouter, LiteLLM, local llama.cpp, etc.)</p>
          </div>

          <div>
            <label htmlFor="machine-max-concurrent" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Max Concurrent Jobs</label>
            <Input id="machine-max-concurrent" value={maxConcurrent} onChange={(e) => { setMaxConcurrent(e.target.value); }} placeholder="1" type="number" min="1" className="max-w-[100px]" />
            <p className="text-xs text-muted-foreground mt-1">How many issues this machine can process simultaneously. Cloud APIs support many; local servers typically 1.</p>
          </div>

          <div>
            <label htmlFor="machine-context-limit" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Hardware context ceiling (tokens)</label>
            <Input id="machine-context-limit" value={contextLimit} onChange={(e) => { setContextLimit(e.target.value); }} placeholder="128000" type="number" />
            <p className="text-xs text-muted-foreground mt-1">Hardware-imposed maximum for any model on this machine. Per-binding overrides and per-model defaults can lower this further; the smallest wins.</p>
          </div>

          <div>
            <label htmlFor="machine-api-key" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">API Key</label>
            <Input id="machine-api-key" value={apiKey} onChange={(e) => { setApiKey(e.target.value); }} placeholder="sk-..." type="password" />
            <p className="text-xs text-muted-foreground mt-1">Bearer token for cloud providers (OpenRouter, LiteLLM, etc.). Leave empty for local servers.</p>
          </div>

          <div>
            <label htmlFor="machine-release-url" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Release URL</label>
            <Input id="machine-release-url" value={releaseUrl} onChange={(e) => { setReleaseUrl(e.target.value); }} placeholder="http://comfyui.local:8188/free" />
            <p className="text-xs text-muted-foreground mt-1">URL to call to free GPU resources when a colocated machine needs the GPU. For ComfyUI: <code className="text-[10px] bg-muted px-1 rounded">http://host:8188/free</code> — For llama-swap: <code className="text-[10px] bg-muted px-1 rounded">http://host:8080/api/models/unload</code></p>
          </div>

          {/* Hosted model bindings */}
          <MachineBindings machineId={machine.id} />

          <div className="flex items-center gap-3">
            <button
              id="machine-enabled"
              onClick={() => { setEnabled(!enabled); }}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                enabled ? 'bg-primary' : 'bg-muted-foreground/30'
              )}
              role="switch"
              aria-checked={enabled}
            >
              <span className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0'
              )} />
            </button>
            <label htmlFor="machine-enabled" className="text-sm">Enabled</label>
          </div>

          {machine.active_issue_ids?.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Active Jobs ({machine.active_issue_ids.length}/{machine.max_concurrent})</span>
              <div className="space-y-1">
                {machine.active_issue_ids.map(id => (
                  <code key={id} className="text-xs text-muted-foreground block">{id}</code>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">ID</span>
            <code className="text-xs text-muted-foreground">{machine.id}</code>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-emerald-400">Saved</p>}
        </div>
      </div>

      {/* Actions */}
      <div className="px-6 py-4 border-t border-border flex items-center gap-3">
        <Button onClick={handleSave} disabled={!hasChanges || !baseUrl || saving}>
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

// ─── Hosted Model Bindings ────────────────────────────────────────────────
//
// Replaces the legacy ModelsCatalog. A binding pairs a logical model with this
// machine and supplies the per-machine `provider_id` (the literal string passed
// to the AI SDK on this host). Logical models are managed on the Models page.

function MachineBindings({ machineId }: { machineId: string }) {
  const [bindings, setBindings] = useState<MachineBinding[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newProviderId, setNewProviderId] = useState('')
  const [newContextLimit, setNewContextLimit] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editProviderId, setEditProviderId] = useState('')
  const [editContextLimit, setEditContextLimit] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.getMachineBindings(machineId).then(setBindings).catch(() => {})
    api.getModels().then(setModels).catch(() => {})
  }, [machineId])

  useEffect(() => { refresh() }, [refresh])

  const modelById = new Map(models.map(m => [m.id, m]))
  const unboundModels = models.filter(m => !m.archived_at && !bindings.some(b => b.model_id === m.id))

  const handleAdd = async () => {
    if (!newModelId || !newProviderId) return
    setError(null)
    try {
      await api.createMachineBinding(machineId, {
        model_id: newModelId,
        provider_id: newProviderId,
        context_limit: newContextLimit ? parseInt(newContextLimit, 10) : null,
      })
      setNewModelId(''); setNewProviderId(''); setNewContextLimit(''); setShowAdd(false)
      refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startEdit = (b: MachineBinding) => {
    setEditingId(b.id)
    setEditProviderId(b.provider_id)
    setEditContextLimit(b.context_limit?.toString() ?? '')
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    setError(null)
    try {
      await api.updateMachineBinding(machineId, editingId, {
        provider_id: editProviderId,
        context_limit: editContextLimit ? parseInt(editContextLimit, 10) : null,
      })
      setEditingId(null)
      refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (bindingId: string) => {
    if (!confirm('Delete this binding?')) return
    setError(null)
    try {
      await api.deleteMachineBinding(machineId, bindingId)
      refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleToggleEnabled = async (b: MachineBinding) => {
    setError(null)
    try {
      await api.updateMachineBinding(machineId, b.id, { enabled: !b.enabled })
      refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Hosted Models</label>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowAdd(!showAdd)} disabled={unboundModels.length === 0}>
          <Plus className="size-3.5" />
        </Button>
      </div>

      {bindings.length === 0 && !showAdd && (
        <p className="text-xs text-muted-foreground">No models hosted on this machine. Bind a logical model to make it available for dispatch.</p>
      )}
      {models.length === 0 && (
        <p className="text-xs text-amber-400">No logical models exist. Create one on the Models page first.</p>
      )}

      {/* Bindings list */}
      <div className="space-y-1">
        {bindings.map(b => {
          const model = modelById.get(b.model_id)
          const isEditing = editingId === b.id
          if (isEditing) {
            return (
              <div key={b.id} className="flex items-center gap-1.5 bg-muted/50 rounded p-1.5">
                <span className="text-xs font-medium truncate flex-1">{model?.name ?? '(unknown)'}</span>
                <Input value={editProviderId} onChange={e => setEditProviderId(e.target.value)} placeholder="provider id" className="h-6 text-xs flex-1" />
                <Input value={editContextLimit} onChange={e => setEditContextLimit(e.target.value)} placeholder="ctx" className="h-6 text-xs w-16" type="number" />
                <Button variant="ghost" size="icon-sm" onClick={handleSaveEdit}><Check className="size-3" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)}><X className="size-3" /></Button>
              </div>
            )
          }
          return (
            <div key={b.id} className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-xs group",
              b.enabled ? "bg-muted/30 hover:bg-muted/50" : "bg-muted/10 opacity-60"
            )}>
              <button
                onClick={() => handleToggleEnabled(b)}
                className="shrink-0"
                title={b.enabled ? 'Disable binding' : 'Enable binding'}
              >
                <div className={cn("size-3 rounded-full border-2", b.enabled ? "border-primary bg-primary" : "border-muted-foreground/40")} />
              </button>
              <span className="font-medium truncate">{model?.name ?? `(unknown ${b.model_id.slice(0, 8)})`}</span>
              <span className="text-muted-foreground font-mono truncate">{b.provider_id}</span>
              {b.context_limit && <span className="text-muted-foreground/60 shrink-0">{Math.round(b.context_limit / 1024)}k</span>}
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => startEdit(b)} className="p-0.5 hover:text-primary"><Save className="size-2.5" /></button>
                <button onClick={() => handleDelete(b.id)} className="p-0.5 hover:text-destructive"><Trash2 className="size-2.5" /></button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="flex flex-col gap-1.5 bg-muted/50 rounded p-1.5">
          <select
            value={newModelId}
            onChange={e => setNewModelId(e.target.value)}
            className="h-7 text-xs px-2 rounded bg-background border border-border"
          >
            <option value="">Select a logical model…</option>
            {unboundModels.map(m => (
              <option key={m.id} value={m.id}>{m.name} ({m.slug})</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <Input value={newProviderId} onChange={e => setNewProviderId(e.target.value)} placeholder="provider id (e.g. qwen3-coder:30b)" className="h-6 text-xs flex-1" />
            <Input value={newContextLimit} onChange={e => setNewContextLimit(e.target.value)} placeholder="ctx" className="h-6 text-xs w-16" type="number" />
            <Button variant="ghost" size="icon-sm" onClick={handleAdd} disabled={!newModelId || !newProviderId}><Check className="size-3" /></Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setShowAdd(false)}><X className="size-3" /></Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
