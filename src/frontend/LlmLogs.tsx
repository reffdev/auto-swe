import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { 
  ChevronRight, 
  Eye, 
  Clock, 
  Cpu, 
  AlertCircle, 
  CheckCircle, 
  Loader2,
  MessageSquare,
  X,
  Search,
  Filter,
  Calendar
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import * as api from './api'
import type { GroupedLlmLogCall, GroupedLlmLog } from './api'

// ─── Debounce utility ───────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedValue(value); }, delay)
    return () => { clearTimeout(timer); }
  }, [value, delay])

  return debouncedValue
}

// ─── Filter state types ──────────────────────────────────────────────────────

interface FilterState {
  search: string
  status: Set<'success' | 'error'>
  models: Set<string>
  startDate: string
  endDate: string
}

const DEFAULT_FILTER_STATE: FilterState = {
  search: '',
  status: new Set(),
  models: new Set(),
  startDate: '',
  endDate: '',
}

// ─── Extract distinct models from data ───────────────────────────────────────

function extractDistinctModels(groups: GroupedLlmLog[]): string[] {
  const models = new Set<string>()
  for (const group of groups) {
    for (const call of group.calls) {
      if (call.model) {
        models.add(call.model)
      }
    }
  }
  return Array.from(models).sort()
}

// ─── Client-side filtering logic ─────────────────────────────────────────────

function filterGroups(
  groups: GroupedLlmLog[],
  filters: FilterState
): GroupedLlmLog[] {
  const { search, status, models, startDate, endDate } = filters
  
  return groups.filter((group) => {
    // Filter by status (if any status filters selected)
    if (status.size > 0) {
      const hasMatchingCall = group.calls.some((call) => status.has(call.status))
      if (!hasMatchingCall) return false
    }
    
    // Filter by model (if any model filters selected)
    if (models.size > 0) {
      const hasMatchingCall = group.calls.some((call) => models.has(call.model))
      if (!hasMatchingCall) return false
    }
    
    // Filter by date range
    if (startDate || endDate) {
      const groupDate = new Date(group.last_request_at)
      if (startDate) {
        const start = new Date(startDate)
        start.setHours(0, 0, 0, 0)
        if (groupDate < start) return false
      }
      if (endDate) {
        const end = new Date(endDate)
        end.setHours(23, 59, 59, 999)
        if (groupDate > end) return false
      }
    }
    
    // Filter by search text
    if (search.trim()) {
      const searchLower = search.toLowerCase().trim()
      const searchableText = [
        group.issue_title ?? '',
        ...group.calls.map((c) => c.model),
        ...group.calls.map((c) => c.prompt_preview),
        ...group.calls.map((c) => c.response_preview),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      
      if (!searchableText.includes(searchLower)) {
        return false
      }
    }
    
    return true
  })
}

// ─── Filter Bar Component ────────────────────────────────────────────────────

function FilterBar({
  filters,
  onFiltersChange,
  models,
  onClear,
  hasActiveFilters,
}: {
  filters: FilterState
  onFiltersChange: (filters: FilterState) => void
  models: string[]
  onClear: () => void
  hasActiveFilters: boolean
}) {
  const [searchInput, setSearchInput] = useState(filters.search)
  const debouncedSearch = useDebounce(searchInput, 300)

  // Update parent when debounced search changes
  /* eslint-disable react-hooks/exhaustive-deps -- Only react to debouncedSearch changes; including filters/onFiltersChange would cause infinite re-render loops */
  useEffect(() => {
    if (debouncedSearch !== filters.search) {
      onFiltersChange({ ...filters, search: debouncedSearch })
    }
  }, [debouncedSearch])
  /* eslint-enable react-hooks/exhaustive-deps */

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value)
  }

  const handleStatusToggle = (status: 'success' | 'error') => {
    const newStatus = new Set(filters.status)
    if (newStatus.has(status)) {
      newStatus.delete(status)
    } else {
      newStatus.add(status)
    }
    onFiltersChange({ ...filters, status: newStatus })
  }

  const handleModelToggle = (model: string) => {
    const newModels = new Set(filters.models)
    if (newModels.has(model)) {
      newModels.delete(model)
    } else {
      newModels.add(model)
    }
    onFiltersChange({ ...filters, models: newModels })
  }

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, startDate: e.target.value })
  }

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, endDate: e.target.value })
  }

  return (
    <div className="px-6 py-3 border-b border-border bg-muted/20">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search input */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Search logs..."
            value={searchInput}
            onChange={handleSearchChange}
            className="pl-9 h-8"
          />
        </div>

        {/* Status filter dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Filter className="size-3.5" />
              Status
              {filters.status.size > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-full">
                  {filters.status.size}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            <DropdownMenuLabel className="text-xs">Status</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={filters.status.has('success')}
              onCheckedChange={() => { handleStatusToggle('success'); }}
            >
              <CheckCircle className="size-3.5 mr-1.5 text-emerald-500" />
              Success
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filters.status.has('error')}
              onCheckedChange={() => { handleStatusToggle('error'); }}
            >
              <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
              Error
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Model filter dropdown */}
        {models.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Cpu className="size-3.5" />
                Model
                {filters.models.size > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-full">
                    {filters.models.size}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48 max-h-64 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Model</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {models.map((model) => (
                <DropdownMenuCheckboxItem
                  key={model}
                  checked={filters.models.has(model)}
                  onCheckedChange={() => { handleModelToggle(model); }}
                >
                  {model}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Date range */}
        <div className="flex items-center gap-2">
          <Calendar className="size-4 text-muted-foreground" />
          <Input
            type="date"
            aria-label="Start date"
            value={filters.startDate}
            onChange={handleStartDateChange}
            className="h-8 w-32 text-xs"
            placeholder="Start"
          />
          <span className="text-muted-foreground text-xs">to</span>
          <Input
            type="date"
            value={filters.endDate}
            aria-label="End date"
            onChange={handleEndDateChange}
            className="h-8 w-32 text-xs"
            placeholder="End"
          />
        </div>

        {/* Clear filters button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-8 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5 mr-1" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

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
          onClick={() => { setExpanded(!expanded); }}
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
            onClick={() => { setShowPrompt(true); }}
            title="View prompt"
          >
            <MessageSquare className="size-3.5" />
          </Button>
          <Button 
            variant="ghost" 
            size="icon-xs" 
            onClick={() => { setShowResponse(true); }}
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
        onClose={() => { setShowPrompt(false); }} 
        title="Prompt" 
        content={call.prompt_preview} 
      />
      <ContentModal 
        open={showResponse} 
        onClose={() => { setShowResponse(false); }} 
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
  const [expandedGroups, setExpandedGroups] = useState(new Set())
  const [filters, setFilters] = useState(DEFAULT_FILTER_STATE)

  // Extract distinct models from fetched data
  const availableModels = useMemo(() => extractDistinctModels(groups), [groups])

  // Check if any filters are active
  const hasActiveFilters = useMemo(() => {
    return (
      filters.search.trim() !== '' ||
      filters.status.size > 0 ||
      filters.models.size > 0 ||
      filters.startDate !== '' ||
      filters.endDate !== ''
    )
  }, [filters])

  // Apply client-side filtering
  const filteredGroups = useMemo(() => {
    return filterGroups(groups, filters)
  }, [groups, filters])

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
    
    void fetchLogs()
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

  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTER_STATE)
  }, [])

  const totalGroups = filteredGroups.length
  const totalCalls = filteredGroups.reduce((sum, g) => sum + g.call_count, 0)

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

      {/* Filter Bar */}
      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        models={availableModels}
        onClear={clearFilters}
        hasActiveFilters={hasActiveFilters}
      />

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
            ) : filteredGroups.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted-foreground">
                No logs found matching your filters
              </div>
            ) : (
              filteredGroups.map((group) => (
                <IssueGroupRow
                  key={group.issue_id ?? 'unassigned'}
                  group={group}
                  expanded={expandedGroups.has(group.issue_id ?? 'unassigned')}
                  onToggle={() => { toggleGroup(group.issue_id); }}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
