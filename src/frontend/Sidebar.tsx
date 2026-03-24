import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Plus, Server, FolderGit2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import * as api from './api'
import type { Project, Machine } from './api'

// ─── New Project Dialog ──────────────────────────────────────────────────────

function NewProjectDialog({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [gitRemote, setGitRemote] = useState('')
  const [gitToken, setGitToken] = useState('')
  const [branch, setBranch] = useState('main')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset form when dialog closes
  const resetForm = () => {
    setName(''); setWorkdir(''); setGitRemote(''); setGitToken(''); setBranch('main'); setError('')
  }

  const handleClose = () => { resetForm(); onClose() }

  const handleSubmit = async () => {
    setError('')
    setSubmitting(true)
    try {
      await api.createProject({
        name,
        workdir: workdir || undefined,
        git_remote: gitRemote || undefined,
        git_server_token: gitToken || undefined,
        git_default_branch: branch || undefined,
      })
      onCreated()
      handleClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Git remote URL" value={gitRemote} onChange={(e) => setGitRemote(e.target.value)} />
          <Input placeholder="Git server token (for PR creation)" type="password" value={gitToken} onChange={(e) => setGitToken(e.target.value)} />
          <Input placeholder="Local workdir path (optional — clones remote if empty)" value={workdir} onChange={(e) => setWorkdir(e.target.value)} />
          <Input placeholder="Default branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!name || (!workdir && !gitRemote) || submitting}>
            {submitting ? 'Creating...' : 'Create Project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── New Machine Dialog ──────────────────────────────────────────────────────

function NewMachineDialog({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const resetForm = () => { setName(''); setBaseUrl(''); setModelId(''); setError('') }
  const handleClose = () => { resetForm(); onClose() }

  const handleSubmit = async () => {
    setError('')
    setSubmitting(true)
    try {
      await api.createMachine({ name: name || undefined, base_url: baseUrl, model_id: modelId })
      onCreated()
      handleClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Machine</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Base URL (e.g. http://192.168.1.50:8080/v1)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <Input placeholder="Model ID (e.g. qwen2.5-coder-32b)" value={modelId} onChange={(e) => setModelId(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!baseUrl || !modelId || submitting}>
            {submitting ? 'Adding...' : 'Add Machine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

interface SidebarProps {
  projects: Project[]
  machines: Machine[]
  selectedProjectId: string | null
  selectedMachineId: string | null
  onSelectProject: (id: string | null) => void
  onSelectMachine: (id: string | null) => void
  onOpenProjectSettings: (id: string) => void
  onDataChange: () => void
}

const MACHINE_STATUS: Record<Machine['status'], string> = {
  idle: 'bg-muted-foreground',
  working: 'bg-green-500 animate-pulse',
}

export function Sidebar({ projects, machines, selectedProjectId, selectedMachineId, onSelectProject, onSelectMachine, onOpenProjectSettings, onDataChange }: SidebarProps) {
  const [showNewProject, setShowNewProject] = useState(false)
  const [showNewMachine, setShowNewMachine] = useState(false)

  return (
    <aside className="w-72 border-r border-border flex flex-col shrink-0">
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-semibold tracking-tight">Open SWE</h1>
        <p className="text-xs text-muted-foreground">Autonomous Coding Agents</p>
      </div>

      {/* Projects */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowNewProject(true)}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <nav className="px-1 pb-2">
        {projects.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No projects yet</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="group flex items-center gap-1">
            <button
              onClick={() => onSelectProject(p.id === selectedProjectId ? null : p.id)}
              className={cn(
                'flex-1 text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
                'hover:bg-accent',
                selectedProjectId === p.id && 'bg-accent font-medium',
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{p.name}</span>
            </button>
            <button
              onClick={() => onOpenProjectSettings(p.id)}
              className={cn(
                'p-1 rounded-md transition-colors',
                'hover:bg-accent',
                selectedProjectId === p.id && 'bg-accent',
              )}
              title="Project settings"
            >
              <Settings className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        ))}
      </nav>

      <div className="border-t border-border" />

      {/* Machines */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Machines</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowNewMachine(true)}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <nav className="px-1 pb-2 flex-1 overflow-y-auto">
        {machines.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No machines yet</p>
        )}
        {machines.map((m) => (
          <button
            key={m.id}
            onClick={() => onSelectMachine(m.id === selectedMachineId ? null : m.id)}
            className={cn(
              'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
              'hover:bg-accent',
              selectedMachineId === m.id && 'bg-accent font-medium',
            )}
          >
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate flex-1">{m.name || m.model_id}</span>
            <span className={cn('size-2 rounded-full shrink-0', MACHINE_STATUS[m.status])} />
          </button>
        ))}
      </nav>

      {/* Dialogs */}
      <NewProjectDialog open={showNewProject} onClose={() => setShowNewProject(false)} onCreated={onDataChange} />
      <NewMachineDialog open={showNewMachine} onClose={() => setShowNewMachine(false)} onCreated={onDataChange} />
    </aside>
  )
}
