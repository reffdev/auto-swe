import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Trash2, Save, Plus, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Machine, MachineModel } from './api'

interface MachineDetailProps {
  machine: Machine
  onBack: () => void
  onDataChange: () => void
}

export function MachineDetail({ machine, onBack, onDataChange }: MachineDetailProps) {
  const [name, setName] = useState(machine.name)
  const [baseUrl, setBaseUrl] = useState(machine.base_url)
  const [modelId, setModelId] = useState(machine.model_id ?? '')
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
    setModelId(machine.model_id ?? '')
    setMachineType(machine.machine_type as 'inference' | 'comfyui' | 'npu' ?? 'inference')
    setEnabled(!!machine.enabled)
    setContextLimit(machine.context_limit?.toString() ?? '')
    setMaxConcurrent(machine.max_concurrent?.toString() ?? '1')
    setApiKey(machine.api_key ?? '')
    setReleaseUrl(machine.release_url ?? '')
  }, [machine.id, machine.name, machine.base_url, machine.model_id, machine.machine_type, machine.enabled, machine.context_limit, machine.max_concurrent, machine.api_key, machine.release_url])

  const parsedContextLimit = contextLimit ? parseInt(contextLimit, 10) || null : null
  const parsedMaxConcurrent = parseInt(maxConcurrent, 10) || 1
  const hasChanges =
    name !== machine.name ||
    baseUrl !== machine.base_url ||
    (modelId || null) !== (machine.model_id ?? null) ||
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
        model_id: modelId || null,
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
            <label htmlFor="machine-model-id" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Model ID</label>
            <Input id="machine-model-id" value={modelId} onChange={(e) => { setModelId(e.target.value); }} placeholder="e.g. anthropic/claude-sonnet-4-20250514" />
            <p className="text-xs text-muted-foreground mt-1">Default model name. Optional if projects specify their own model.</p>
          </div>

          <div>
            <label htmlFor="machine-max-concurrent" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Max Concurrent Jobs</label>
            <Input id="machine-max-concurrent" value={maxConcurrent} onChange={(e) => { setMaxConcurrent(e.target.value); }} placeholder="1" type="number" min="1" className="max-w-[100px]" />
            <p className="text-xs text-muted-foreground mt-1">How many issues this machine can process simultaneously. Cloud APIs support many; local servers typically 1.</p>
          </div>

          <div>
            <label htmlFor="machine-context-limit" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Context Limit (tokens)</label>
            <Input id="machine-context-limit" value={contextLimit} onChange={(e) => { setContextLimit(e.target.value); }} placeholder="128000" type="number" />
            <p className="text-xs text-muted-foreground mt-1">Model&apos;s context window size. Leave empty for default (128k). Tool output truncation scales to this.</p>
          </div>

          <div>
            <label htmlFor="machine-api-key" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">API Key</label>
            <Input id="machine-api-key" value={apiKey} onChange={(e) => { setApiKey(e.target.value); }} placeholder="sk-..." type="password" />
            <p className="text-xs text-muted-foreground mt-1">Bearer token for cloud providers (OpenRouter, LiteLLM, etc.). Leave empty for local servers.</p>
          </div>

          <div>
            <label htmlFor="machine-release-url" className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Release URL</label>
            <Input id="machine-release-url" value={releaseUrl} onChange={(e) => { setReleaseUrl(e.target.value); }} placeholder="http://192.168.1.10:8188/free" />
            <p className="text-xs text-muted-foreground mt-1">URL to call to free GPU resources when a colocated machine needs the GPU. For ComfyUI: <code className="text-[10px] bg-muted px-1 rounded">http://host:8188/free</code> — For llama-swap: <code className="text-[10px] bg-muted px-1 rounded">http://host:8080/api/models/unload</code></p>
          </div>

          {/* Models catalog */}
          <ModelsCatalog machineId={machine.id} activeModelId={modelId || null} onSelect={(selectedModelId, selectedContextLimit) => {
            setModelId(selectedModelId)
            setContextLimit(selectedContextLimit?.toString() ?? '')
          }} />

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
        <Button onClick={handleSave} disabled={!hasChanges || !baseUrl || (machineType !== 'comfyui' && !modelId) || saving}>
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

// ─── Models Catalog ───────────────────────────────────────────────────────

function ModelsCatalog({ machineId, activeModelId, onSelect }: {
  machineId: string
  activeModelId: string | null
  onSelect: (modelId: string, contextLimit: number | null) => void
}) {
  const [models, setModels] = useState<MachineModel[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newContextLimit, setNewContextLimit] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editModelId, setEditModelId] = useState('')
  const [editLabel, setEditLabel] = useState('')
  const [editContextLimit, setEditContextLimit] = useState('')

  const refresh = useCallback(() => {
    api.getMachineModels(machineId).then(setModels).catch(() => {})
  }, [machineId])

  useEffect(() => { refresh() }, [refresh])

  const handleAdd = async () => {
    if (!newModelId) return
    await api.createMachineModel(machineId, {
      model_id: newModelId,
      label: newLabel || newModelId,
      context_limit: newContextLimit ? parseInt(newContextLimit, 10) : null,
    })
    setNewModelId(''); setNewLabel(''); setNewContextLimit(''); setShowAdd(false)
    refresh()
  }

  const handleSelect = (model: MachineModel) => {
    // Just update parent form fields — actual save happens via Save Changes button
    onSelect(model.model_id, model.context_limit)
  }

  const startEdit = (m: MachineModel) => {
    setEditingId(m.id)
    setEditModelId(m.model_id)
    setEditLabel(m.label)
    setEditContextLimit(m.context_limit?.toString() ?? '')
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    await api.updateMachineModel(machineId, editingId, {
      model_id: editModelId,
      label: editLabel,
      context_limit: editContextLimit ? parseInt(editContextLimit, 10) : null,
    })
    setEditingId(null)
    refresh()
  }

  const handleDelete = async (modelId: string) => {
    if (!confirm('Delete this model?')) return
    await api.deleteMachineModel(machineId, modelId)
    refresh()
  }

  return (
    <div className="border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Available Models</label>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="size-3.5" />
        </Button>
      </div>

      {models.length === 0 && !showAdd && (
        <p className="text-xs text-muted-foreground">No models configured. Add models to quickly switch between them.</p>
      )}

      {/* Model list */}
      <div className="space-y-1">
        {models.map(m => {
          const isActive = m.model_id === activeModelId
          const isEditing = editingId === m.id

          if (isEditing) {
            return (
              <div key={m.id} className="flex items-center gap-1.5 bg-muted/50 rounded p-1.5">
                <Input value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder="Label" className="h-6 text-xs flex-1" />
                <Input value={editModelId} onChange={e => setEditModelId(e.target.value)} placeholder="Model ID" className="h-6 text-xs flex-1" />
                <Input value={editContextLimit} onChange={e => setEditContextLimit(e.target.value)} placeholder="CTX" className="h-6 text-xs w-16" type="number" />
                <Button variant="ghost" size="icon-sm" onClick={handleSaveEdit}><Check className="size-3" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)}><X className="size-3" /></Button>
              </div>
            )
          }

          return (
            <div key={m.id} className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-xs group",
              isActive ? "bg-primary/10 border border-primary/30" : "bg-muted/30 hover:bg-muted/50"
            )}>
              <button onClick={() => handleSelect(m)} className="shrink-0" title="Set as active">
                <div className={cn("size-3 rounded-full border-2", isActive ? "border-primary bg-primary" : "border-muted-foreground/40")} />
              </button>
              <span className="font-medium truncate">{m.label || m.model_id}</span>
              <span className="text-muted-foreground font-mono truncate">{m.model_id}</span>
              {m.context_limit && <span className="text-muted-foreground/60 shrink-0">{Math.round(m.context_limit / 1024)}k</span>}
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => startEdit(m)} className="p-0.5 hover:text-primary"><Save className="size-2.5" /></button>
                <button onClick={() => handleDelete(m.id)} className="p-0.5 hover:text-destructive"><Trash2 className="size-2.5" /></button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="flex items-center gap-1.5 bg-muted/50 rounded p-1.5">
          <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label" className="h-6 text-xs flex-1" />
          <Input value={newModelId} onChange={e => setNewModelId(e.target.value)} placeholder="Model ID" className="h-6 text-xs flex-1" />
          <Input value={newContextLimit} onChange={e => setNewContextLimit(e.target.value)} placeholder="CTX" className="h-6 text-xs w-16" type="number" />
          <Button variant="ghost" size="icon-sm" onClick={handleAdd} disabled={!newModelId}><Check className="size-3" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setShowAdd(false)}><X className="size-3" /></Button>
        </div>
      )}
    </div>
  )
}
