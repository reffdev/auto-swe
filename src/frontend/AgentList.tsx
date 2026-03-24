import type { Agent } from './Dashboard'
import { cn } from '@/lib/utils'

const STATUS_DOT: Record<Agent['status'], string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-green-500 animate-pulse',
  completed: 'bg-blue-500',
  error: 'bg-destructive',
}

interface AgentListProps {
  agents: Agent[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function AgentList({ agents, selectedId, onSelect }: AgentListProps) {
  return (
    <nav className="flex-1 overflow-y-auto">
      {agents.map((agent) => (
        <button
          key={agent.id}
          onClick={() => onSelect(agent.id)}
          className={cn(
            'w-full text-left px-4 py-3 border-b border-border transition-colors',
            'hover:bg-accent',
            selectedId === agent.id && 'bg-accent',
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full shrink-0', STATUS_DOT[agent.status])} />
            <span className="font-medium text-sm truncate">{agent.name}</span>
            <span className="ml-auto text-xs text-muted-foreground capitalize">{agent.status}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">{agent.task}</p>
        </button>
      ))}
    </nav>
  )
}
