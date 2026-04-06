import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@/components/ui/button'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import * as api from './api'

// ─── Persistent session store ───────────────────────────────────────────────

interface TermSession {
  projectId: string
  ws: WebSocket | null
  term: XTerm
  fit: FitAddon
  /** True once the server's session buffer has been written to xterm. */
  bufferReplayed: boolean
  onDataDisposable: { dispose(): void } | null  // prevent duplicate listeners
}

const sessions = new Map<string, TermSession>()

function getOrCreateSession(projectId: string): TermSession {
  const existing = sessions.get(projectId)
  if (existing) return existing

  const term = new XTerm({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    theme: {
      background: '#0a0a0a',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      selectionBackground: '#27272a',
    },
    scrollback: 10000,
  })

  const fit = new FitAddon()
  term.loadAddon(fit)

  const session: TermSession = { projectId, ws: null, term, fit, bufferReplayed: false, onDataDisposable: null }
  sessions.set(projectId, session)
  return session
}

function destroySession(projectId: string): void {
  const session = sessions.get(projectId)
  if (!session) return
  // Tell the server to kill the persistent PTY before tearing down the local session.
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try { session.ws.send(JSON.stringify({ type: 'kill' })) } catch {}
  }
  if (session.ws) { session.ws.close(); session.ws = null }
  session.term.dispose()
  sessions.delete(projectId)
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TerminalView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const navigate = useNavigate()
  const termRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)
  const [projects, setProjects] = useState<api.Project[]>([])
  const sessionRef = useRef<TermSession | null>(null)

  useEffect(() => {
    api.poll().then(d => setProjects(d.projects)).catch(() => {})
  }, [])

  // Debounced fit helper
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedFit = (session: TermSession) => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
    fitTimerRef.current = setTimeout(() => {
      try {
        session.fit.fit()
        if (session.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }))
        }
      } catch { /* container not ready */ }
    }, 100)
  }

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connectWs = (session: TermSession) => {
    if (session.ws && session.ws.readyState <= WebSocket.OPEN) return // already connected

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams()
    params.set('project', session.projectId)
    params.set('cols', String(session.term.cols))
    params.set('rows', String(session.term.rows))
    const wsUrl = `${proto}//${window.location.host}/ws/terminal?${params}`

    const ws = new WebSocket(wsUrl)
    session.ws = ws
    let intentionalClose = false

    ws.onopen = () => {
      if (sessionRef.current === session) setConnected(true)
      session.term.focus()
      // Re-fit and sync dimensions after connection establishes
      setTimeout(() => {
        try {
          session.fit.fit()
          ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }))
        } catch {}
      }, 300)
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'buffer':
            // Server-side session buffer replay. Only apply once per local session
            // (after page reload or new tab); skip on reconnect within the same SPA
            // session because xterm already has the content.
            if (!session.bufferReplayed) {
              session.term.reset()
              if (msg.data) session.term.write(msg.data)
              session.bufferReplayed = true
            }
            break
          case 'output':
            session.term.write(msg.data)
            session.bufferReplayed = true
            break
          case 'exit':
            session.term.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`)
            intentionalClose = true
            if (sessionRef.current === session) setConnected(false)
            session.ws = null
            break
          case 'error':
            session.term.write(`\r\n\x1b[31m${msg.data}\x1b[0m\r\n`)
            intentionalClose = true
            if (sessionRef.current === session) setConnected(false)
            session.ws = null
            break
        }
      } catch {
        session.term.write(event.data)
        session.bufferReplayed = true
      }
    }

    ws.onclose = () => {
      if (sessionRef.current === session) setConnected(false)
      session.ws = null
      // Auto-reconnect on unexpected close (not process exit/error)
      if (!intentionalClose) {
        session.term.write(`\r\n\x1b[90m[Connection lost — reconnecting...]\x1b[0m\r\n`)
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = setTimeout(() => connectWs(session), 2000)
      }
    }
    ws.onerror = () => {
      // onclose will fire after this — let it handle reconnection
      if (sessionRef.current === session) setConnected(false)
      session.ws = null
    }

    // Terminal → WebSocket — only register once per session
    if (session.onDataDisposable) session.onDataDisposable.dispose()
    session.onDataDisposable = session.term.onData((data) => {
      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'input', data }))
      }
    })
  }

  // Attach/detach terminal to DOM
  useEffect(() => {
    if (!termRef.current || !projectId) return

    const session = getOrCreateSession(projectId)
    sessionRef.current = session

    // Attach to DOM — clear any leftover elements from a previous project first
    const container = termRef.current
    while (container.firstChild) container.removeChild(container.firstChild)

    // If the terminal was already opened (navigated away and back),
    // its DOM element is detached — re-parent it into the new container.
    // xterm's open() can only be called once per instance.
    const existingEl = (session.term as any).element as HTMLElement | undefined
    if (existingEl) {
      container.appendChild(existingEl)
      session.term.focus()
    } else {
      session.term.open(container)
    }

    // Fit after layout settles, then connect
    setTimeout(() => {
      try { session.fit.fit() } catch {}
      connectWs(session)
      setConnected(session.ws?.readyState === WebSocket.OPEN)
    }, 200)

    // Resize observer
    const resizeObserver = new ResizeObserver(() => debouncedFit(session))
    resizeObserver.observe(container)

    // Reconnect when tab regains focus (browsers kill idle WS connections)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && session.ws?.readyState !== WebSocket.OPEN) {
        // Small delay to let the browser fully resume networking
        setTimeout(() => {
          if (session.ws?.readyState !== WebSocket.OPEN) {
            connectWs(session)
          }
        }, 500)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      // Detach the terminal element from the container but keep the session alive —
      // it will be re-parented when the user navigates back to this project's terminal.
      const el = (session.term as any).element as HTMLElement | undefined
      if (el?.parentNode) el.parentNode.removeChild(el)
    }
  }, [projectId])

  const handleReset = () => {
    destroySession(projectId)
    sessionRef.current = null
    setConnected(false)
    // Clear the container
    if (termRef.current) {
      termRef.current.innerHTML = ''
    }
    // Recreate after a tick
    requestAnimationFrame(() => {
      if (!termRef.current || !projectId) return
      const session = getOrCreateSession(projectId)
      sessionRef.current = session
      session.term.open(termRef.current)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { session.fit.fit() } catch {}
          connectWs(session)
        })
      })
    })
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h2 className="text-sm font-semibold">Claude CLI</h2>
          <p className="text-xs text-muted-foreground">
            {connected ? 'Connected' : 'Disconnected'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={projectId}
            onChange={(e) => { if (e.target.value) void navigate(`/terminal/${e.target.value}`) }}
            className="h-7 text-xs bg-background border border-border rounded-md px-2 text-foreground"
          >
            <option value="">Select project...</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <Button variant="ghost" size="icon-sm" onClick={handleReset} title="New session">
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={termRef}
        className="flex-1 bg-[#0a0a0a] overflow-hidden"
        style={{ minHeight: 0, minWidth: 0, padding: '4px' }}
      />
      <style>{`
        .xterm { height: 100% !important; }
        .xterm-viewport { overflow-y: auto !important; overflow-x: hidden !important; }
        .xterm-screen { width: 100% !important; }
      `}</style>
    </div>
  )
}
