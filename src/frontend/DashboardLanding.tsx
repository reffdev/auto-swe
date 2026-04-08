import { useState, useEffect, useRef } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Plus, FolderGit2, Server, AlertCircle, Terminal, Cpu, Palette, BrainCircuit, Zap, Activity, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from './api'

// ─── Machine activity panel ──────────────────────────────────────────────
//
// Per-machine "what is this machine doing right now" view. Polls
// /api/dashboard/activity every 2 seconds. Each row shows the machine, its
// current model throughput (tokens/sec), and a list of active leases with
// the consumer (director / foreman / pipeline / analysis), the work item
// label, elapsed time, and expiry countdown. Idle but enabled machines are
// summarized at the bottom rather than listed individually so the panel
// stays compact.

const CONSUMER_STYLES: Record<string, { label: string; color: string }> = {
  director:  { label: "Director", color: "border-blue-500/50 bg-blue-500/10 text-blue-300" },
  foreman:   { label: "Foreman",  color: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" },
  pipeline:  { label: "Pipeline", color: "border-violet-500/50 bg-violet-500/10 text-violet-300" },
  analysis:  { label: "Analysis", color: "border-amber-500/50 bg-amber-500/10 text-amber-300" },
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "—"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function MachineTypeIcon({ type }: { type: string }) {
  if (type === 'comfyui') return <Palette className="size-3.5 shrink-0 text-purple-400" />
  if (type === 'npu') return <BrainCircuit className="size-3.5 shrink-0 text-cyan-400" />
  return <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
}

function MachineActivityPanel() {
  const [data, setData] = useState<api.DashboardActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchActivity = async () => {
      try {
        const result = await api.getDashboardActivity()
        if (!cancelled) {
          setData(result)
          setError(null)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    }
    void fetchActivity()
    const interval = setInterval(() => { void fetchActivity() }, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-emerald-400" />
          <CardTitle className="text-sm font-medium">Machine Activity</CardTitle>
        </div>
        {data && (
          <span className="text-xs text-muted-foreground">
            {data.summary.activeMachines} active · {data.summary.idleMachines} idle · {data.summary.totalMachines} total
          </span>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {loading && <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>}
        {error && <p className="text-xs text-destructive py-4 text-center">Error: {error}</p>}
        {!loading && !error && data && data.activity.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No machines are currently working. {data.summary.idleMachines > 0 && `${data.summary.idleMachines} machine${data.summary.idleMachines === 1 ? '' : 's'} idle and ready.`}
          </p>
        )}
        {!loading && !error && data && data.activity.length > 0 && (
          <div className="space-y-2">
            {data.activity.map(entry => (
              <div
                key={entry.machine.id}
                className={cn(
                  "rounded-md border border-border bg-muted/10 p-3",
                  entry.idle && "opacity-70",
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  <MachineTypeIcon type={entry.machine.type} />
                  <span className="text-sm font-medium truncate flex-1">{entry.machine.name}</span>
                  {(entry.tokensInPerSec || entry.tokensOutPerSec) && (
                    <span
                      className="text-[10px] font-mono text-muted-foreground flex items-center gap-1 shrink-0"
                      title="Tokens per second: prompt / completion"
                    >
                      <Zap className="size-2.5 text-yellow-500/70" />
                      {entry.tokensInPerSec ? Math.round(entry.tokensInPerSec) : '—'}
                      {' / '}
                      {entry.tokensOutPerSec ? Math.round(entry.tokensOutPerSec) : '—'}
                      <span className="text-muted-foreground/50">tok/s</span>
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono shrink-0">
                    {entry.machine.type}
                  </span>
                </div>
                {entry.leases.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic ml-5">
                    Recent traffic, no active lease — finishing up
                  </p>
                ) : (
                  <div className="space-y-1 ml-5">
                    {entry.leases.map(lease => {
                      const style = CONSUMER_STYLES[lease.consumer] ?? { label: lease.consumer, color: "border-muted bg-muted text-muted-foreground" }
                      return (
                        <div key={lease.id} className="flex items-center gap-2 text-xs">
                          <span className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0",
                            style.color,
                          )}>
                            {style.label}
                          </span>
                          <span className="truncate flex-1" title={lease.label}>{lease.label}</span>
                          <span
                            className="text-[10px] text-muted-foreground font-mono flex items-center gap-1 shrink-0"
                            title={`Acquired ${new Date(lease.acquiredAt).toLocaleTimeString()}, expires in ${formatElapsed(lease.expiresInMs)}`}
                          >
                            <Clock className="size-2.5" />
                            {formatElapsed(lease.elapsedMs)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface SummaryCounts {
  projects: number
  machines: number
  issues: number
}

interface LogEntry {
  timestamp: string;
  level: "log" | "error" | "warn";
  message: string;
}

const LEVEL_STYLES: Record<string, string> = {
  log: "text-muted-foreground",
  error: "text-destructive",
  warn: "text-yellow-400",
}

function ConsoleLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [mode, setMode] = useState<'app' | 'journal'>('app')
  const [journalEntries, setJournalEntries] = useState<LogEntry[]>([])
  const [journalLoading, setJournalLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // App logs via SSE
  useEffect(() => {
    if (mode !== 'app') return
    const es = new EventSource('/api/console')
    es.onopen = () => setEntries([])
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry
        setEntries(prev => {
          const next = [...prev, entry]
          return next.length > 500 ? next.slice(-500) : next
        })
      } catch { /* ignore */ }
    }
    return () => { es.close(); }
  }, [mode])

  // Journal logs via REST
  useEffect(() => {
    if (mode !== 'journal') return
    setJournalLoading(true)
    fetch('/api/journal?lines=500')
      .then(r => r.json())
      .then((data: LogEntry[]) => { setJournalEntries(data); setJournalLoading(false) })
      .catch(() => { setJournalLoading(false) })
  }, [mode])

  const displayEntries = mode === 'app' ? entries : journalEntries

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [displayEntries])

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40
  }

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => { setCollapsed(!collapsed); }}
          className="flex items-center gap-2 hover:text-foreground transition-colors"
        >
          <Terminal className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Server Console</span>
          <span className="text-xs text-muted-foreground">({displayEntries.length})</span>
        </button>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
              <button
                onClick={() => setMode('app')}
                className={cn('px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
                  mode === 'app' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >App</button>
              <button
                onClick={() => setMode('journal')}
                className={cn('px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
                  mode === 'journal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >System</button>
            </div>
          )}
          <button onClick={() => { setCollapsed(!collapsed); }} className="text-xs text-muted-foreground hover:text-foreground">
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-72 overflow-y-auto bg-black/30 border-t border-border font-mono text-[11px] leading-relaxed p-2"
        >
          {displayEntries.length === 0 && (
            <span className="text-muted-foreground/50">
              {mode === 'journal' && journalLoading ? 'Loading journal...' : 'Waiting for log output...'}
            </span>
          )}
          {displayEntries.map((entry, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-all", LEVEL_STYLES[entry.level])}>
              <span className="text-muted-foreground/40 mr-2 select-none">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              {entry.message}
            </div>
          ))}
          {mode === 'journal' && !journalLoading && (
            <button
              onClick={() => { setJournalLoading(true); fetch('/api/journal?lines=500').then(r => r.json()).then(setJournalEntries).finally(() => setJournalLoading(false)) }}
              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
            >Refresh</button>
          )}
        </div>
      )}
    </Card>
  )
}

export function DashboardLanding({ counts, onRefresh }: { counts: SummaryCounts; onRefresh: () => void }) {
  const handleNewProject = () => {
    const name = prompt('Project name:')
    if (name) {
      void api.createProject({ name, workdir: '', git_remote: undefined, git_server_token: undefined, git_default_branch: 'main' })
        .then(() => { onRefresh(); })
    }
  }

  const handleNewMachine = () => {
    const name = prompt('Machine name (optional):')
    const baseUrl = prompt('Base URL:', 'https://openrouter.ai/api/v1')
    if (baseUrl) {
      void api.createMachine({
        name: name || '',
        base_url: baseUrl,
      }).then(() => { onRefresh(); })
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8">
      <div className="max-w-5xl mx-auto w-full space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Overview of your autonomous coding agents</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleNewProject} size="sm">
              <Plus className="size-4 mr-2" />
              New Project
            </Button>
            <Button onClick={handleNewMachine} variant="outline" size="sm">
              <Server className="size-4 mr-2" />
              New Machine
            </Button>
          </div>
        </div>

        {/* Live machine activity — what each machine is doing right now */}
        <MachineActivityPanel />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Projects</CardTitle>
              <FolderGit2 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.projects}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.projects === 1 ? 'project configured' : 'projects configured'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Machines</CardTitle>
              <Server className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.machines}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.machines === 1 ? 'agent machine' : 'agent machines'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Issues</CardTitle>
              <AlertCircle className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{counts.issues}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.issues === 1 ? 'issue tracked' : 'issues tracked'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Live console */}
        <ConsoleLog />

        {counts.issues === 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="size-5 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  <h3 className="font-medium">Get Started</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Create a project to start tracking issues. Then create an issue to begin autonomous development.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
