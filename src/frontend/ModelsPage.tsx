/**
 * Models page — manages logical models (the first-class entities created by the
 * logical-models refactor). Models are independent of machines; bindings live
 * on the machine detail page.
 *
 * Layout:
 *   - List of all logical models with name, slug, family, default context, binding count, archived flag
 *   - "+ New Model" creates a new logical model
 *   - Click a row → expand to inline edit metadata + see hosting machines
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Plus, Save, Trash2, Check, X, Archive, ArchiveRestore } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Machine, MachineBinding, Model } from './api'

interface ModelsPageProps {
  onBack: () => void
}

export function ModelsPage({ onBack }: ModelsPageProps) {
  const [models, setModels] = useState<Model[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [bindings, setBindings] = useState<MachineBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [m, mch] = await Promise.all([api.getModels(), api.getMachines()])
      setModels(m)
      setMachines(mch)
      // Pull bindings from every machine in parallel — small N
      const allBindings = await Promise.all(mch.map(machine => api.getMachineBindings(machine.id)))
      setBindings(allBindings.flat())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const machineById = new Map(machines.map(m => [m.id, m]))
  const bindingsByModel = new Map<string, MachineBinding[]>()
  for (const b of bindings) {
    const list = bindingsByModel.get(b.model_id) ?? []
    list.push(b)
    bindingsByModel.set(b.model_id, list)
  }

  const visibleModels = includeArchived ? models : models.filter(m => !m.archived_at)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <h2 className="text-base font-semibold flex-1">Models</h2>
          <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={e => setIncludeArchived(e.target.checked)}
              className="size-3"
            />
            Show archived
          </label>
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            <Plus className="size-3.5 mr-1.5" />
            New Model
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Logical models are independent of machines. To make a model available for dispatch, bind it to one or more machines on the machine detail page. The Director and Foreman code slots are configured on the Foreman config page.
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {loading && models.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}

          {showCreate && (
            <CreateModelForm
              onCancel={() => setShowCreate(false)}
              onCreated={() => { setShowCreate(false); void refresh() }}
            />
          )}

          {!loading && visibleModels.length === 0 && !showCreate && (
            <p className="text-sm text-muted-foreground">No models yet. Click "New Model" to create one.</p>
          )}

          {visibleModels.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              bindings={bindingsByModel.get(model.id) ?? []}
              machineById={machineById}
              expanded={expandedId === model.id}
              onToggle={() => setExpandedId(expandedId === model.id ? null : model.id)}
              onChanged={refresh}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Create form ────────────────────────────────────────────────────────────

function CreateModelForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [family, setFamily] = useState('')
  const [contextLimit, setContextLimit] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)

  // Auto-generate slug from name unless the user has manually edited it
  useEffect(() => {
    if (slugTouched) return
    const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    setSlug(auto)
  }, [name, slugTouched])

  const handleSubmit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      await api.createModel({
        name: name.trim(),
        slug: slug.trim(),
        family: family.trim() || null,
        default_context_limit: contextLimit ? parseInt(contextLimit, 10) : null,
        description: description.trim() || null,
      })
      onCreated()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 bg-muted/20">
      <h3 className="text-sm font-semibold">New logical model</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Name</label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Qwen3 Coder 30B" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Slug</label>
          <Input value={slug} onChange={e => { setSlug(e.target.value); setSlugTouched(true) }} placeholder="qwen3-coder-30b" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Family <span className="opacity-60">(optional)</span></label>
          <Input value={family} onChange={e => setFamily(e.target.value)} placeholder="qwen3" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Default context (tokens) <span className="opacity-60">(optional)</span></label>
          <Input value={contextLimit} onChange={e => setContextLimit(e.target.value)} placeholder="32768" type="number" />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description <span className="opacity-60">(optional)</span></label>
        <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Notes about this model" />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={handleSubmit} disabled={submitting || !name.trim() || !slug.trim()}>
          <Check className="size-3.5 mr-1.5" />
          {submitting ? 'Creating…' : 'Create'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-3.5 mr-1.5" />
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── Row ────────────────────────────────────────────────────────────────────

function ModelRow({
  model,
  bindings,
  machineById,
  expanded,
  onToggle,
  onChanged,
}: {
  model: Model
  bindings: MachineBinding[]
  machineById: Map<string, Machine>
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState(model.name)
  const [family, setFamily] = useState(model.family ?? '')
  const [contextLimit, setContextLimit] = useState(model.default_context_limit?.toString() ?? '')
  const [description, setDescription] = useState(model.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset local form when model prop changes from upstream
  useEffect(() => {
    setName(model.name)
    setFamily(model.family ?? '')
    setContextLimit(model.default_context_limit?.toString() ?? '')
    setDescription(model.description ?? '')
  }, [model.id, model.name, model.family, model.default_context_limit, model.description])

  // Truthy check matches the binding row's display in MachineDetail. Strict
  // `=== 1` was previously used here and would mistakenly show "0 active
  // bindings" if the API ever returned `true` instead of `1`, even though the
  // binding visibly existed on the machine page.
  const enabledBindings = bindings.filter(b => !!b.enabled)
  const archived = model.archived_at != null

  const dirty =
    name !== model.name ||
    (family || null) !== (model.family ?? null) ||
    (contextLimit ? parseInt(contextLimit, 10) || null : null) !== (model.default_context_limit ?? null) ||
    (description || null) !== (model.description ?? null)

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      await api.updateModel(model.id, {
        name: name.trim(),
        family: family.trim() || null,
        default_context_limit: contextLimit ? parseInt(contextLimit, 10) || null : null,
        description: description.trim() || null,
      })
      onChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async () => {
    setError(null)
    try {
      if (archived) {
        await api.updateModel(model.id, { archived_at: null })
      } else {
        await api.deleteModel(model.id) // soft-delete
      }
      onChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleHardDelete = async () => {
    if (!confirm(`Hard-delete model "${model.name}"? This only succeeds if no bindings or task references exist.`)) return
    setError(null)
    try {
      await api.deleteModel(model.id, { hard: true })
      onChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={cn(
      'border border-border rounded-lg overflow-hidden',
      archived && 'opacity-60'
    )}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{model.name}</span>
            {model.family && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{model.family}</span>
            )}
            {archived && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">Archived</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
            <code>{model.slug}</code>
            {model.default_context_limit && <span>{Math.round(model.default_context_limit / 1024)}k ctx</span>}
            <span>{enabledBindings.length} active binding{enabledBindings.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4 bg-muted/10">
          {/* Editable metadata */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Family</label>
              <Input value={family} onChange={e => setFamily(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Default context (tokens)</label>
              <Input value={contextLimit} onChange={e => setContextLimit(e.target.value)} type="number" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Slug <span className="opacity-60">(immutable here)</span></label>
              <Input value={model.slug} disabled />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
              <Save className="size-3.5 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleArchive}>
              {archived ? <ArchiveRestore className="size-3.5 mr-1.5" /> : <Archive className="size-3.5 mr-1.5" />}
              {archived ? 'Restore' : 'Archive'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleHardDelete} className="text-destructive hover:text-destructive ml-auto">
              <Trash2 className="size-3.5 mr-1.5" />
              Hard delete
            </Button>
          </div>

          {/* Hosted on */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Hosted on</label>
            {bindings.length === 0 && (
              <p className="text-xs text-muted-foreground">No machines host this model. Add a binding from a machine's detail page.</p>
            )}
            <div className="space-y-1">
              {bindings.map(b => {
                const machine = machineById.get(b.machine_id)
                return (
                  <div key={b.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-muted/30">
                    <div className={cn('size-2 rounded-full', b.enabled ? 'bg-primary' : 'bg-muted-foreground/40')} />
                    <span className="font-medium truncate">{machine?.name || machine?.base_url || `(machine ${b.machine_id.slice(0, 8)})`}</span>
                    <span className="text-muted-foreground font-mono truncate">{b.provider_id}</span>
                    {machine && (
                      <span className="ml-auto text-[10px] uppercase text-muted-foreground/60">{machine.machine_type}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
