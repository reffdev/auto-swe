import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import * as api from './api'
import type { Project } from './api'

interface ProjectSettingsProps {
  project: Project
  onBack: () => void
  onDataChange: () => void
}

export function ProjectSettings({ project, onBack, onDataChange }: ProjectSettingsProps) {
  const [name, setName] = useState(project.name)
  const [workdir, setWorkdir] = useState(project.workdir)
  const [gitRemote, setGitRemote] = useState(project.git_remote ?? '')
  const [gitToken, setGitToken] = useState(project.git_server_token ?? '')
  const [gitBranch, setGitBranch] = useState(project.git_default_branch)
  const [modelId, setModelId] = useState(project.model_id ?? '')

  // Sync form when project prop changes (from polling)
  useEffect(() => {
    setName(project.name)
    setWorkdir(project.workdir)
    setGitRemote(project.git_remote ?? '')
    setGitToken(project.git_server_token ?? '')
    setGitBranch(project.git_default_branch)
    setModelId(project.model_id ?? '')
  }, [project.id, project.name, project.workdir, project.git_remote, project.git_server_token, project.git_default_branch, project.model_id])

  const hasChanges =
    name !== project.name ||
    workdir !== project.workdir ||
    gitRemote !== (project.git_remote ?? '') ||
    gitToken !== (project.git_server_token ?? '') ||
    gitBranch !== project.git_default_branch ||
    modelId !== (project.model_id ?? '')

  const handleSave = async () => {
    try {
      await api.updateProject(project.id, {
        name,
        workdir,
        git_remote: gitRemote || undefined,
        git_server_token: gitToken || undefined,
        git_default_branch: gitBranch,
        model_id: modelId || undefined,
      })
      onDataChange()
    } catch (e: unknown) {
      // Error is handled by the API call throwing
      throw e
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
          <h2 className="text-base font-semibold flex-1">Project Settings</h2>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-lg space-y-5">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-project" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Workdir</label>
            <Input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/path/to/local/repo" />
            <p className="text-xs text-muted-foreground mt-1">Local directory containing the git repository</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Git Remote</label>
            <Input value={gitRemote} onChange={(e) => setGitRemote(e.target.value)} placeholder="https://github.com/user/repo.git" />
            <p className="text-xs text-muted-foreground mt-1">Remote repository URL</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Git Token</label>
            <Input type="password" value={gitToken} onChange={(e) => setGitToken(e.target.value)} placeholder="ghp_xxxxxxxxxxxx" />
            <p className="text-xs text-muted-foreground mt-1">Token for git operations (PR creation)</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Default Branch</label>
            <Input value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="main" />
            <p className="text-xs text-muted-foreground mt-1">Default branch for the repository</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Model ID</label>
            <Input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="e.g. qwen2.5-coder-32b" />
            <p className="text-xs text-muted-foreground mt-1">Model to use for this project (overrides machine default)</p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">ID</label>
            <code className="text-xs text-muted-foreground">{project.id}</code>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Created</label>
            <code className="text-xs text-muted-foreground">{new Date(project.created_at).toLocaleString()}</code>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="px-6 py-4 border-t border-border">
        <Button onClick={handleSave} disabled={!hasChanges}>
          Save Changes
        </Button>
      </div>
    </div>
  )
}
