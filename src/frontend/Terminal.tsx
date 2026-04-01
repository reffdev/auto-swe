import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@/components/ui/button'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import * as api from './api'

export function TerminalView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const navigate = useNavigate()
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [connected, setConnected] = useState(false)
  const [projects, setProjects] = useState<api.Project[]>([])

  useEffect(() => {
    api.poll().then(d => setProjects(d.projects)).catch(() => {})
  }, [])

  const connect = () => {
    if (!termRef.current) return

    // Clean up previous
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    if (xtermRef.current) { xtermRef.current.dispose(); xtermRef.current = null }

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
      scrollback: 5000,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termRef.current)

    xtermRef.current = term
    fitRef.current = fit

    // Debounced fit — prevents rapid layout thrashing
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const debouncedFit = () => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        try {
          fit.fit()
          // Sync size to PTY
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        } catch { /* container not ready */ }
      }, 100)
    }

    // Initial fit after layout settles
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { fit.fit() } catch {}

        // Connect WebSocket after fit so we have correct dimensions
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const params = new URLSearchParams()
        if (projectId) params.set('project', projectId)
        params.set('cols', String(term.cols))
        params.set('rows', String(term.rows))
        const wsUrl = `${proto}//${window.location.host}/ws/terminal?${params}`

        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          setConnected(true)
          term.focus()
        }

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            switch (msg.type) {
              case 'output':
                term.write(msg.data)
                break
              case 'exit':
                term.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`)
                setConnected(false)
                break
              case 'error':
                term.write(`\r\n\x1b[31m${msg.data}\x1b[0m\r\n`)
                setConnected(false)
                break
            }
          } catch {
            term.write(event.data)
          }
        }

        ws.onclose = () => setConnected(false)
        ws.onerror = () => setConnected(false)

        // Terminal → WebSocket
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }))
          }
        })
      })
    })

    // Observe container resize
    const resizeObserver = new ResizeObserver(() => debouncedFit())
    resizeObserver.observe(termRef.current)

    return () => {
      resizeObserver.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
    }
  }

  // Connect when projectId changes
  useEffect(() => {
    if (projectId) {
      const cleanup = connect()
      return () => {
        cleanup?.()
        wsRef.current?.close()
        xtermRef.current?.dispose()
      }
    }
  }, [projectId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      xtermRef.current?.dispose()
    }
  }, [])

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
          <Button variant="ghost" size="icon-sm" onClick={connect} title="Reconnect">
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={termRef}
        className="flex-1 bg-[#0a0a0a]"
        style={{ minHeight: 0, padding: '4px' }}
      />
    </div>
  )
}
