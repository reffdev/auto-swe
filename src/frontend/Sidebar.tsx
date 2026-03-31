import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Plus, Server, FolderGit2, RefreshCw, Activity, Cpu, AlertTriangle, GitPullRequest, Zap, ArrowRight, Hammer, Settings, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useNavigate, useLocation } from 'react-router-dom'
import * as api from './api'
import type { Project, Machine, Issue } from './api'

// ─── Restart Overlay ─────────────────────────────────────────────────────────

function RestartOverlay() {
  const [status, setStatus] = useState('Updating and rebuilding...')
  const [details, setDetails] = useState('')
  const [dots, setDots] = useState('')

  useEffect(() => {
    const dotTimer = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 500)

    let cancelled = false
    let versionBefore: { commit: string; startedAt: number } | null = null

    const run = async () => {
      // Capture current version
      try {
        const res = await fetch('/api/version', { signal: AbortSignal.timeout(3000) })
        if (res.ok) versionBefore = await res.json()
      } catch { /* server may already be restarting */ }

      setStatus('Building...')

      // Poll /api/version until we get a response with a different startedAt
      // (different startedAt = server restarted, even if commit is the same)
      while (!cancelled) {
        await new Promise(r => setTimeout(r, 2000))
        try {
          const res = await fetch('/api/version', { signal: AbortSignal.timeout(3000) })
          if (!res.ok) {
            setStatus('Restarting...')
            continue
          }
          const version = await res.json() as { commit: string; startedAt: number }

          // Server is up — check if it's a new instance
          if (!versionBefore || version.startedAt !== versionBefore.startedAt) {
            const updated = versionBefore && version.commit !== versionBefore.commit
            setDetails(`${version.commit}${updated ? ' (updated)' : ' (restarted)'}`)
            setStatus('Server is back! Reloading...')
            await new Promise(r => setTimeout(r, 1000))
            window.location.reload()
            return
          }

          // Same instance still running — build/restart hasn't happened yet
          setStatus('Building...')
        } catch {
          // Server is down
          setStatus('Restarting...')
        }
      }
    }

    const timer = setTimeout(run, 1000)

    return () => {
      cancelled = true
      clearTimeout(timer)
      clearInterval(dotTimer)
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="text-center space-y-3">
        <RefreshCw className="size-8 mx-auto animate-spin text-muted-foreground" />
        <p className="text-sm text-foreground font-medium">{status}{dots}</p>
        {details && <p className="text-xs text-muted-foreground font-mono">{details}</p>}
        <p className="text-xs text-muted-foreground">Do not close this tab</p>
      </div>
    </div>
  )
}

// ─── Stats Panel ─────────────────────────────────────────────────────────────

interface SpeedResult {
  prompt_tokens_per_sec: number | null;
  completion_tokens_per_sec: number | null;
}

interface Stats {
  machines: { active: number; total: number };
  issues: { queued: number; pr_open: number; failed: number };
  speed: SpeedResult;
  machineSpeed: Record<string, SpeedResult>;
}

// Shared stats state so both StatsPanel and machine list can read it
let _cachedStats: Stats | null = null;

function useStats(): Stats | null {
  const [stats, setStats] = useState(_cachedStats)

  useEffect(() => {
    const fetchStats = () => {
      fetch('/api/stats').then(r => r.json()).then((s: Stats) => {
        _cachedStats = s
        setStats(s)
      }).catch(() => {})
    }
    if (!_cachedStats) fetchStats()
    const interval = setInterval(fetchStats, 10_000)
    return () => { clearInterval(interval); }
  }, [])

  return stats
}

function StatsPanel({ stats }: { stats: Stats | null }) {
  if (!stats) return null

  const promptTps = stats.speed.prompt_tokens_per_sec
  const completionTps = stats.speed.completion_tokens_per_sec

  return (
    <div className="px-3 py-2 border-t border-border space-y-1.5">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Cpu className="size-3 shrink-0" />
          <span>Active</span>
        </div>
        <span className="text-right font-mono">
          <span className={stats.machines.active > 0 ? 'text-emerald-400' : ''}>{stats.machines.active}</span>
          <span className="text-muted-foreground">/{stats.machines.total}</span>
        </span>

        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Activity className="size-3 shrink-0" />
          <span>Queued</span>
        </div>
        <span className="text-right font-mono">{stats.issues.queued}</span>

        <div className="flex items-center gap-1.5 text-muted-foreground">
          <GitPullRequest className="size-3 shrink-0" />
          <span>PRs Open</span>
        </div>
        <span className="text-right font-mono">
          {stats.issues.pr_open > 0 ? <span className="text-blue-400">{stats.issues.pr_open}</span> : '0'}
        </span>

        {stats.issues.failed > 0 && (
          <>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <AlertTriangle className="size-3 shrink-0" />
              <span>Failed</span>
            </div>
            <span className="text-right font-mono text-destructive">{stats.issues.failed}</span>
          </>
        )}
      </div>

      {(promptTps || completionTps) && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-0.5">
          <Zap className="size-3 shrink-0 text-yellow-500" />
          <span className="font-mono">
            {promptTps ? `${Math.round(promptTps)} in` : ''}
            {promptTps && completionTps ? ' / ' : ''}
            {completionTps ? `${Math.round(completionTps)} out` : ''}
            <span className="text-muted-foreground/60"> tok/s</span>
          </span>
        </div>
      )}
    </div>
  )
}

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
          <Input placeholder="Project name" value={name} onChange={(e) => { setName(e.target.value); }} />
          <Input placeholder="Git remote URL" value={gitRemote} onChange={(e) => { setGitRemote(e.target.value); }} />
          <Input placeholder="Git server token (for PR creation)" type="password" value={gitToken} onChange={(e) => { setGitToken(e.target.value); }} />
          <Input placeholder="Local workdir path (optional — clones remote if empty)" value={workdir} onChange={(e) => { setWorkdir(e.target.value); }} />
          <Input placeholder="Default branch" value={branch} onChange={(e) => { setBranch(e.target.value); }} />
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
          <Input placeholder="Name (optional)" value={name} onChange={(e) => { setName(e.target.value); }} />
          <Input placeholder="Base URL (e.g. http://192.168.1.50:8080/v1)" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); }} />
          <Input placeholder="Model ID (e.g. qwen2.5-coder-32b)" value={modelId} onChange={(e) => { setModelId(e.target.value); }} />
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
  issues: Issue[]
  selectedProjectId: string | null
  selectedMachineId: string | null
  onSelectProject: (id: string | null) => void
  onSelectMachine: (id: string | null) => void
  onDataChange: () => void
}

const MACHINE_STATUS: Record<Machine['status'], string> = {
  idle: 'bg-muted-foreground',
  working: 'bg-green-500 animate-pulse',
}

export function Sidebar({ projects, machines, issues, selectedProjectId, selectedMachineId, onSelectProject, onSelectMachine, onDataChange }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [showNewProject, setShowNewProject] = useState(false)
  const [showNewMachine, setShowNewMachine] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [serverInfo, setServerInfo] = useState<{ commit: string; branch: string } | null>(null)
  const stats = useStats()

  useEffect(() => {
    fetch('/api/server-info').then(r => r.json()).then(setServerInfo).catch(() => {})
  }, [])

  return (
    <aside className="w-72 border-r border-border flex flex-col shrink-0">
      <div className="p-4 border-b border-border">
        <button
          onClick={() => navigate('/')}
          className="block text-left"
        >
          <h1 className="text-lg font-semibold tracking-tight hover:text-primary transition-colors cursor-pointer">Auto-SWE</h1>
          <p className="text-xs text-muted-foreground">Agentic Wrangling</p>
        </button>
      </div>

      {/* Projects */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
        <Button variant="ghost" size="icon-sm" onClick={() => { setShowNewProject(true); }}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <nav className="px-1 pb-2">
        {projects.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No projects yet</p>
        )}
        {projects.map((p) => {
          const isSelected = selectedProjectId === p.id
          const navClass = (active: boolean) => cn(
            'w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-2',
            active ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )
          // Detect which sub-page is active
          const path = location.pathname
          const isIssues = isSelected && !path.includes('/llm-logs') && !path.includes('/analysis') && !path.includes('/settings') && !path.includes('/planner')
          const isLlmLogs = isSelected && path.includes('/llm-logs')
          const isAnalysis = isSelected && path.includes('/analysis')
          const isSettings = isSelected && path.includes('/settings')

          return (
          <div key={p.id} className="mb-2">
            <button
              onClick={() => { void navigate(`/project/${p.id}`); }}
              className={cn(
                'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
                'hover:bg-accent',
                isSelected && 'font-medium',
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate flex-1">{p.name}</span>
            </button>
            <div className="pl-5 space-y-0.5 mt-0.5">
              <button onClick={() => { void navigate(`/project/${p.id}`); }} className={navClass(isIssues)}>
                <FolderGit2 className="size-3" />
                Issues
              </button>
              <button onClick={() => { void navigate(`/project/${p.id}/llm-logs`); }} className={navClass(isLlmLogs)}>
                <Activity className="size-3" />
                LLM Logs
              </button>
              <button onClick={() => { void navigate(`/project/${p.id}/analysis`); }} className={navClass(isAnalysis)}>
                <Activity className="size-3" />
                Analysis
              </button>
              <button onClick={() => { void navigate(`/project/${p.id}/settings`); }} className={navClass(isSettings)}>
                <Activity className="size-3" />
                Settings
              </button>
            </div>
          </div>
          )
        })}
      </nav>

      <div className="border-t border-border" />

      {/* Machines */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Machines</span>
        <Button variant="ghost" size="icon-sm" onClick={() => { setShowNewMachine(true); }}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <nav className="px-1 pb-2 flex-1 overflow-y-auto">
        {machines.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No machines yet</p>
        )}
        {machines.map((m) => {
          const activeIds = m.active_issue_ids ?? []
          const activeIssues = activeIds.map(id => issues.find(i => i.id === id)).filter(Boolean) as Issue[]
          const machineSpd = stats?.machineSpeed?.[m.id]
          const outTps = machineSpd?.completion_tokens_per_sec

          // Cycling arrow: find which active issue to link to
          const currentPath = location.pathname
          const currentIssueId = currentPath.match(/\/issue\/([^/]+)/)?.[1]
          let nextIssue: typeof activeIssues[0] | null = null
          if (activeIssues.length > 0) {
            const currentIdx = activeIssues.findIndex(i => i.id === currentIssueId)
            if (currentIdx >= 0) {
              // Currently viewing one — cycle to next
              nextIssue = activeIssues[(currentIdx + 1) % activeIssues.length]
            } else {
              // Not viewing any — go to first
              nextIssue = activeIssues[0]
            }
          }

          return (
            <div key={m.id}>
              <div className="flex items-center">
                <button
                  onClick={() => { onSelectMachine(m.id === selectedMachineId ? null : m.id); }}
                  className={cn(
                    'flex-1 text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
                    'hover:bg-accent',
                    selectedMachineId === m.id && 'bg-accent font-medium',
                  )}
                >
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{m.name || m.model_id || 'Unnamed'}</span>
                  {activeIds.length > 0 && machineSpd && (outTps || machineSpd.prompt_tokens_per_sec) ? (
                    <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0 flex items-center gap-0.5">
                      <Zap className="size-2.5 text-yellow-500/70" />
                      {machineSpd.prompt_tokens_per_sec ? Math.round(machineSpd.prompt_tokens_per_sec) : '—'}
                      {' / '}
                      {outTps ? Math.round(outTps) : '—'}
                    </span>
                  ) : null}
                  {activeIds.length > 0 ? (
                    <span className="text-[10px] font-mono text-emerald-400 shrink-0">{activeIds.length}/{m.max_concurrent}</span>
                  ) : (
                    <span className={cn('size-2 rounded-full shrink-0', MACHINE_STATUS[m.status])} />
                  )}
                </button>
              {nextIssue && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigate(`/project/${nextIssue.project_id}/issue/${nextIssue.id}`)
                  }}
                  title={nextIssue.title}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-accent transition-colors shrink-0"
                >
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              </div>
            </div>
          )
        })}
      </nav>

      <div className="border-t border-border" />

      {/* Director */}
      <div className="px-3 pt-3 pb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Director</span>
      </div>
      <nav className="px-1 pb-2">
        {(() => {
          const path = location.pathname
          const isDirector = path.startsWith('/director')
          const navClass = (active: boolean) => cn(
            'w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-2',
            active ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )
          return (
            <button onClick={() => { void navigate('/director'); }} className={navClass(isDirector)}>
              <Target className="size-3" />
              Directives
            </button>
          )
        })()}
      </nav>

      {/* Foreman */}
      <div className="px-3 pt-3 pb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Foreman</span>
      </div>
      <nav className="px-1 pb-2">
        {(() => {
          const path = location.pathname
          const isForeman = path === '/foreman' || path.startsWith('/foreman/task')
          const isForemanConfig = path === '/foreman/config'
          const navClass = (active: boolean) => cn(
            'w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-2',
            active ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )
          return (
            <>
              <button onClick={() => { void navigate('/foreman'); }} className={navClass(isForeman)}>
                <Hammer className="size-3" />
                Task Queue
              </button>
              <button onClick={() => { void navigate('/foreman/config'); }} className={navClass(isForemanConfig)}>
                <Settings className="size-3" />
                Config
              </button>
            </>
          )
        })()}
      </nav>

      {/* Stats */}
      <div className="mt-auto" />
      <StatsPanel stats={stats} />

      {/* Update & Restart */}
      <div className="p-2 border-t border-border space-y-1">
        {serverInfo && (
          <p className="text-[10px] text-muted-foreground text-center font-mono">
            {serverInfo.branch}@{serverInfo.commit}
          </p>
        )}
        <button
          onClick={async () => {
            if (!confirm('Pull latest, rebuild, and restart the server?')) return
            setRestarting(true)
            try {
              await api.updateAndRestart()
            } catch { /* server will disconnect during restart */ }
          }}
          className="w-full px-3 py-1.5 text-xs rounded-md font-medium text-center bg-muted text-muted-foreground hover:bg-muted/80 transition-colors flex items-center justify-center gap-1.5"
        >
          <RefreshCw className="size-3" />
          Update & Restart
        </button>
      </div>

      {/* Dialogs */}
      <NewProjectDialog open={showNewProject} onClose={() => { setShowNewProject(false); }} onCreated={onDataChange} />
      <NewMachineDialog open={showNewMachine} onClose={() => { setShowNewMachine(false); }} onCreated={onDataChange} />

      {/* Restart overlay */}
      {restarting && <RestartOverlay />}
    </aside>
  )
}
