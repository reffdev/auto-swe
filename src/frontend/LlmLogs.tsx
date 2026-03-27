import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { 
  ChevronRight, 
  ChevronDown, 
  Eye, 
  EyeOff, 
  Clock, 
  Cpu, 
  AlertCircle, 
  CheckCircle, 
  Loader2,
  MessageSquare,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import * as api from './api'
import type { GroupedLlmLogCall, GroupedLlmLog } from './api'

// ─── Status badge ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<GroupedLlmLogCall['status'], string> = {
  success: 'bg-emerald-500/20 text-emerald-400',
  error: 'bg-destructive/20 text-destructive',
}

function StatusBadge({ status }: { status: GroupedLlmLogCall['status'] }) {
  return (
    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1.5', STATUS_COLORS[status])}>
      {status === 'success' ? <CheckCircle className="size-3" /> : <AlertCircle className="size-3" />}
      {status}
    </span>
  )
}

// ─── Token count badge ───────────────────────────────────────────────────────

function TokenBadge({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-md">
      {label}: {value}
    </span>
  )
}

// ─── Latency badge ───────────────────────────────────────────────────────────

function LatencyBadge({ ms }: { ms: number }) {
  const color = ms < 1000 
    ? 'text-emerald-400' 
    : ms < 3000 
      ? 'text-yellow-400' 
      : 'text-destructive'
  
  return (
    <span className={cn('text-xs font-medium', color)}>
      {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
    </span>
  )
}

// ─── Truncated text with expand ──────────────────────────────────────────────

function TruncatedText({ text, maxLines = 2 }: { text: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false)
  
  if (!text) {
    return <span className="text-muted-foreground italic">No content</span>
  }
  
  const lines = text.split('\n')
  const displayLines = expanded ? lines : lines.slice(0, maxLines)
  const isTruncated = lines.length > maxLines
  
  return (
    <div className="relative">
      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all bg-muted/30 p-2 rounded-md">
        {displayLines.join('\n')}
      </pre>
      {isTruncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="absolute bottom-0 right-0 bg-background px-2 py-0.5 text-xs text-primary hover:underline rounded-tl-md"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// ─── Full content modal ──────────────────────────────────────────────────────

function ContentModal({ 
  open, 
  onClose, 
  title, 
  content 
}: { 
  open: boolean; 
  onClose: () => void; 
  title: string; 
  content: string | null 
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>{title}</DialogTitle>
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground">
            {content || 'No content'}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── LLM call row ────────────────────────────────────────────────────────────

function LlmCallRow({ call }: { call: GroupedLlmLogCall }) {
  const [showPrompt, setShowPrompt] = useState(false)
  const [showResponse, setShowResponse] = useState(false)

  return (
    <div className="border-b border-border hover:bg-accent/30 transition-colors">
      <div className="grid grid-cols-12 gap-4 px-6 py-3 text-sm">
        {/* Timestamp */}
        <div className="col-span-2 flex items-center gap-2">
          <Clock className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground font-mono">
            {new Date(call.timestamp).toLocaleString()}
          </span>
        </div>
        
        {/* Model */}
        <div className="col-span-2 flex items-center gap-2">
          <Cpu className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium">{call.model}</span>
        </div>
        
        {/* Status */}
        <div className="col-span-1 flex items-center">
          <StatusBadge status={call.status} />
        </div>
        
        {/* Tokens */}
        <div className="col-span-2 flex items-center gap-2">
          <TokenBadge label="In" value={call.input_tokens} />
          <TokenBadge label="Out" value={call.output_tokens} />
        </div>
        
        {/* Latency */}
        <div className="col-span-1 flex items-center">
          <LatencyBadge ms={call.latency_ms} />
        </div>
        
        {/* Actions */}
        <div className="col-span-2 flex items-center justify-end gap-2">
          <Button 
            variant="ghost" 
            size="icon-xs" 
            onClick={() => setShowPrompt(true)}
            title="View prompt"
          >
            <MessageSquare className="size-3.5" />
          </Button>
          <Button 
            variant="ghost" 
            size="icon-xs" 
            onClick={() => setShowResponse(true)}
            title="View response"
          >
            <Eye className="size-3.5" />
          </Button>
        </div>
      </div>
      
      {/* Expanded details */}
      <div className="px-6 pb-3 pl-14">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-medium text-muted-foreground mb-1.5 block">Prompt</span>
            <TruncatedText text={call.prompt_preview} />
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground mb-1.5 block">Response</span>
            <TruncatedText text={call.response_preview} />
          </div>
        </div>
      </div>
      
      {/* Modals */}
      <ContentModal 
        open={showPrompt} 
        onClose={() => setShowPrompt(false)} 
        title="Prompt" 
        content={call.prompt_preview} 
      />
      <ContentModal 
        open={showResponse} 
        onClose={() => setShowResponse(false)} 
        title="Response" 
        content={call.response_preview} 
      />
    </div>
  )
}

// ─── Issue group row ─────────────────────────────────────────────────────────

function IssueGroupRow({ 
  group, 
  expanded, 
  onToggle 
}: { 
  group: GroupedLlmLog; 
  expanded: boolean; 
  onToggle: () => void 
}) {
  const isUnassigned = group.issue_id === null
  
  return (
    <div className="border-b border-border bg-card">
      <button
        onClick={onToggle}
        className="w-full text-left px-6 py-4 hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ChevronRight 
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )} 
            />
            
            {/* Issue info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {isUnassigned ? (
                  <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                    Unassigned
                  </span>
                ) : (
                  <>
                    <span className="text-xs font-medium text-primary">
                      #{group.issue_id}
                    </span>
                    {group.issue_title && (
                      <span className="text-sm font-medium truncate max-w-md">
                        {group.issue_title}
                      </span>
                    )}
                  </>
                )}
                
                {group.issue_status && (
                  <span className="text-xs text-muted-foreground">
                    [{group.issue_status}]
                  </span>
                )}
              </div>
              
              {/* Summary info */}
              <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  Last: {new Date(group.last_request_at).toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <Loader2 className="size-3" />
                  {group.call_count} calls
                </span>
                {group.issue_assignee && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-primary" />
                    {group.issue_assignee}
                  </span>
                )}
              </div>
            </div>
          </div>
          
          {/* Call count badge */}
          <span className="text-xs font-medium bg-accent text-accent-foreground px-2.5 py-1 rounded-md shrink-0">
            {group.call_count} call{group.call_count !== 1 ? 's' : ''}
          </span>
        </div>
      </button>
      
      {/* Expanded calls */}
      {expanded && (
        <div className="border-t border-border">
          {group.calls.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted-foreground text-sm">
              No LLM calls for this issue
            </div>
          ) : (
            group.calls.map((call) => (
              <LlmCallRow key={call.id} call={call} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

interface LlmLogsProps {
  projectId: string
}

export function LlmLogs({ projectId }: LlmLogsProps) {
  const navigate = useNavigate()
  const [groups, setGroups] = useState<GroupedLlmLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        setLoading(true)
        const data = await api.getGroupedLlmLogs()
        setGroups(data.groups)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch LLM logs')
      } finally {
        setLoading(false)
      }
    }
    
    fetchLogs()
  }, [projectId])

  const toggleGroup = (issueId: string | null) => {
    const id = issueId ?? 'unassigned'
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const totalGroups = groups.length
  const totalCalls = groups.reduce((sum, g) => sum + g.call_count, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">LLM Logs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Grouped by issue • {totalGroups} issue{totalGroups !== 1 ? 's' : ''} • {totalCalls} call{totalCalls !== 1 ? 's' : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(`/project/${projectId}`)}>
          Back to Project
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-6 py-8 text-center">
            <AlertCircle className="size-12 mx-auto text-destructive/50 mb-3" />
            <p className="text-destructive">{error}</p>
          </div>
        )}
        
        {loading && !groups.length ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {groups.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted-foreground">
                No LLM logs found
              </div>
            ) : (
              groups.map((group) => (
                <IssueGroupRow
                  key={group.issue_id ?? 'unassigned'}
                  group={group}
                  expanded={expandedGroups.has(group.issue_id ?? 'unassigned')}
                  onToggle={() => toggleGroup(group.issue_id)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
