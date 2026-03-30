import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { ChevronRight, FilePlus, FileMinus, FileEdit, ArrowRight, Loader2 } from 'lucide-react'
import * as api from './api'
import type { DiffFile } from './api'

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<DiffFile['status'], { label: string; color: string; icon: typeof FileEdit }> = {
  added: { label: 'added', color: 'text-green-400 bg-green-500/20', icon: FilePlus },
  deleted: { label: 'deleted', color: 'text-red-400 bg-red-500/20', icon: FileMinus },
  modified: { label: 'modified', color: 'text-yellow-400 bg-yellow-500/20', icon: FileEdit },
  renamed: { label: 'renamed', color: 'text-blue-400 bg-blue-500/20', icon: ArrowRight },
}

// ─── Diff line renderer ───────────────────────────────────────────────────────

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('@@')) {
    return <span className="text-blue-400 bg-blue-500/10 block px-3 py-0.5">{line}</span>
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <span className="text-green-300 bg-green-500/15 block px-3 py-0.5">{line}</span>
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <span className="text-red-300 bg-red-500/15 block px-3 py-0.5">{line}</span>
  }
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename')) {
    return <span className="text-muted-foreground block px-3 py-0.5">{line}</span>
  }
  return <span className="block px-3 py-0.5">{line}</span>
}

// ─── Single file diff (collapsible) ──────────────────────────────────────────

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const config = STATUS_CONFIG[file.status]
  const Icon = config.icon

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => { setOpen(!open); }}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left text-sm"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <Icon className={cn('size-3.5 shrink-0', config.color.split(' ')[0])} />
        <span className="font-mono text-foreground truncate">{file.filename}</span>
        <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded-full ml-1', config.color)}>
          {config.label}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs font-mono shrink-0">
          {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-border overflow-x-auto">
          <pre className="text-xs font-mono leading-relaxed">
            {file.patch.split('\n').map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PrDiffView({ issueId }: { issueId: string }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    api.getPrDiff(issueId).then(data => {
      if (cancelled) return
      setFiles(data.files)
      setBranch(data.branch)
      setBase(data.base)
    }).catch(err => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : 'Failed to load diff')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [issueId])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
        <Loader2 className="size-4 animate-spin" />
        Loading diff...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive text-sm">
        {error}
      </div>
    )
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No file changes found
      </div>
    )
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Summary bar */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
        </span>
        {totalAdditions > 0 && <span className="text-green-400 font-mono">+{totalAdditions}</span>}
        {totalDeletions > 0 && <span className="text-red-400 font-mono">-{totalDeletions}</span>}
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {base} ← {branch}
        </span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {files.map(file => (
          <FileDiff
            key={file.filename}
            file={file}
            defaultOpen={files.length <= 5}
          />
        ))}
      </div>
    </div>
  )
}
