import { useState, useEffect, useRef } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Plus, FolderGit2, Server, AlertCircle, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from './api'

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
      void api.createProject({ name, workdir: '', git_remote: undefined, git_server_token: undefined, git_default_branch: 'main', model_id: undefined })
        .then(() => { onRefresh(); })
    }
  }

  const handleNewMachine = () => {
    const name = prompt('Machine name (optional):')
    const baseUrl = prompt('Base URL:', 'https://openrouter.ai/api/v1')
    const modelId = prompt('Default Model ID (optional):')
    if (baseUrl) {
      void api.createMachine({
        name: name || '',
        base_url: baseUrl,
        model_id: modelId || undefined,
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
