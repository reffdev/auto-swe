import { useState, useEffect, memo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Streamdown } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { ChevronRight, ChevronDown, FileText, Folder, BookOpen } from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocEntry {
  path: string
  name: string
  type: 'file' | 'dir'
  children?: DocEntry[]
}

interface DocsTree {
  tree: DocEntry[]
  topLevel: DocEntry[]
}

// ─── Streamdown renderer ────────────────────────────────────────────────────

const streamdownPlugins = { cjk, code, math, mermaid }

const MarkdownRenderer = memo(({ content }: { content: string }) => (
  <Streamdown
    className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    plugins={streamdownPlugins}
  >
    {content}
  </Streamdown>
))
MarkdownRenderer.displayName = 'MarkdownRenderer'

// ─── Sidebar Tree ───────────────────────────────────────────────────────────

function TreeNode({ entry, selectedPath, onSelect, depth = 0 }: {
  entry: DocEntry
  selectedPath: string | null
  onSelect: (path: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(true)
  const isSelected = entry.path === selectedPath
  const isDir = entry.type === 'dir'

  // Pretty display name: strip numbers and extension
  const displayName = entry.name
    .replace(/^\d+-/, '')
    .replace(/\.md$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div>
      <button
        onClick={() => {
          if (isDir) setExpanded(!expanded)
          else onSelect(entry.path)
        }}
        className={cn(
          'w-full text-left px-2 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 cursor-pointer',
          isSelected
            ? 'bg-accent text-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
        ) : (
          <FileText className="size-3 shrink-0" />
        )}
        <span className="truncate">{displayName}</span>
      </button>
      {isDir && expanded && entry.children && (
        <div>
          {entry.children.map(child => (
            <TreeNode
              key={child.path}
              entry={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function DocsView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedPath = searchParams.get('file')
  const [tree, setTree] = useState<DocsTree | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load tree
  useEffect(() => {
    fetch('/api/docs').then(r => r.json()).then(setTree).catch(() => {})
  }, [])

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedPath) {
      setContent(null)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/docs/file?path=${encodeURIComponent(selectedPath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then(d => { setContent(d.content); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [selectedPath])

  const selectFile = (path: string) => {
    setSearchParams({ file: path }, { replace: true })
  }

  // Auto-select README if nothing selected
  useEffect(() => {
    if (!selectedPath && tree) {
      const readme = tree.tree.find(e => e.type === 'dir' && e.name === 'architecture')
        ?.children?.find(e => e.name === 'README.md')
      if (readme) selectFile(readme.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, selectedPath])

  return (
    <div className="flex h-full">
      {/* File tree sidebar */}
      <div className="w-56 shrink-0 border-r border-border overflow-y-auto p-2">
        <div className="flex items-center gap-2 px-2 py-2 mb-2">
          <BookOpen className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Documentation</span>
        </div>

        {/* Top-level docs */}
        {tree?.topLevel && tree.topLevel.length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">
              Project Root
            </div>
            {tree.topLevel.map(entry => (
              <TreeNode key={entry.path} entry={entry} selectedPath={selectedPath} onSelect={selectFile} />
            ))}
          </div>
        )}

        {/* docs/ tree */}
        {tree?.tree && tree.tree.length > 0 && (
          <div>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium flex items-center gap-1">
              <Folder className="size-3" />
              docs/
            </div>
            {tree.tree.map(entry => (
              <TreeNode key={entry.path} entry={entry} selectedPath={selectedPath} onSelect={selectFile} />
            ))}
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading...</div>
        )}
        {error && (
          <div className="p-6 text-destructive text-sm">Error loading file: {error}</div>
        )}
        {!loading && !error && content !== null && (
          <div className="max-w-4xl mx-auto px-8 py-6">
            <div className="mb-4 text-xs text-muted-foreground font-mono">
              {selectedPath}
            </div>
            <article className="prose prose-sm prose-invert max-w-none
              [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:first:mt-0 [&_h1]:text-foreground [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2
              [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-foreground
              [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-foreground
              [&_h4]:text-base [&_h4]:font-medium [&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:text-foreground
              [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-foreground/90 [&_p]:mb-3
              [&_ul]:text-sm [&_ul]:mb-3 [&_ul]:pl-5 [&_ul]:list-disc [&_ul]:text-foreground/90
              [&_ol]:text-sm [&_ol]:mb-3 [&_ol]:pl-5 [&_ol]:list-decimal [&_ol]:text-foreground/90
              [&_li]:mb-1 [&_li]:text-foreground/90
              [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
              [&_strong]:text-foreground [&_strong]:font-semibold
              [&_code]:text-xs [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-foreground/90 [&_code]:font-mono
              [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:mb-4 [&_pre]:text-xs
              [&_pre_code]:bg-transparent [&_pre_code]:p-0
              [&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-4
              [&_table]:w-full [&_table]:text-xs [&_table]:mb-4 [&_table]:border-collapse
              [&_th]:text-left [&_th]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-foreground
              [&_td]:p-2 [&_td]:border [&_td]:border-border [&_td]:text-foreground/90
              [&_tr:hover]:bg-accent/30
              [&_hr]:border-border [&_hr]:my-6
              [&_.mermaid]:my-4 [&_.mermaid]:flex [&_.mermaid]:justify-center
            ">
              <MarkdownRenderer content={content} />
            </article>
          </div>
        )}
        {!loading && !error && content === null && !selectedPath && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <BookOpen className="size-8" />
            <p className="text-sm">Select a document from the sidebar</p>
          </div>
        )}
      </div>
    </div>
  )
}
