import { useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { AgentList } from './AgentList'

export interface Agent {
  id: string
  name: string
  status: 'idle' | 'running' | 'error' | 'completed'
  task: string
}

const MOCK_AGENTS: Agent[] = [
  { id: '1', name: 'agent-alpha', status: 'running', task: 'Fix auth middleware token validation' },
  { id: '2', name: 'agent-beta', status: 'completed', task: 'Add pagination to /api/users endpoint' },
  { id: '3', name: 'agent-gamma', status: 'idle', task: 'Refactor database connection pooling' },
  { id: '4', name: 'agent-delta', status: 'error', task: 'Migrate legacy CSS to Tailwind' },
]

export function Dashboard() {
  const [agents] = useState<Agent[]>(MOCK_AGENTS)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(MOCK_AGENTS[0].id)

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-80 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-semibold tracking-tight">Open SWE</h1>
          <p className="text-sm text-muted-foreground">Autonomous Coding Agents</p>
        </div>
        <AgentList
          agents={agents}
          selectedId={selectedAgentId}
          onSelect={setSelectedAgentId}
        />
      </aside>
      <main className="flex-1 flex flex-col">
        {selectedAgent ? (
          <AgentPanel agent={selectedAgent} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select an agent to view details
          </div>
        )}
      </main>
    </div>
  )
}
