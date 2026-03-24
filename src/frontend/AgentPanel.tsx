import { useState } from 'react'
import type { Agent } from './Dashboard'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { Bot } from 'lucide-react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const MOCK_MESSAGES: Record<string, ChatMessage[]> = {
  '1': [
    { id: 'm1', role: 'user', content: 'Fix the token validation bug in auth middleware' },
    { id: 'm2', role: 'assistant', content: 'I found the issue in `src/middleware/auth.ts`. The JWT expiry check was comparing timestamps in different formats. Fixing now...' },
    { id: 'm3', role: 'assistant', content: 'Done. Changed `Date.now()` to `Math.floor(Date.now() / 1000)` to match the JWT `exp` claim (seconds vs milliseconds). Running tests...' },
  ],
  '2': [
    { id: 'm1', role: 'user', content: 'Add cursor-based pagination to GET /api/users' },
    { id: 'm2', role: 'assistant', content: 'Implemented cursor-based pagination using `id` as the cursor field. Added `?cursor=<id>&limit=20` query params. All tests passing.' },
  ],
}

interface AgentPanelProps {
  agent: Agent
}

export function AgentPanel({ agent }: AgentPanelProps) {
  const [input, setInput] = useState('')
  const messages = MOCK_MESSAGES[agent.id] ?? []

  const handleSubmit = (_message: PromptInputMessage) => {
    // TODO: send message to agent backend
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{agent.name}</h2>
          <p className="text-sm text-muted-foreground">{agent.task}</p>
        </div>
        <span className="text-xs font-medium capitalize px-2 py-1 rounded-md bg-secondary">
          {agent.status}
        </span>
      </header>

      <Conversation className="flex-1 px-6">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<Bot className="size-12" />}
              title="No activity yet"
              description="This agent hasn't started working yet."
            />
          ) : (
            messages.map((msg) => (
              <Message key={msg.id} from={msg.role}>
                <MessageContent>
                  <MessageResponse>{msg.content}</MessageResponse>
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="p-4 border-t border-border">
        <PromptInput
          onSubmit={handleSubmit}
          className="w-full max-w-3xl mx-auto relative"
        >
          <PromptInputTextarea
            value={input}
            placeholder="Send a message to this agent..."
            onChange={(e) => setInput(e.currentTarget.value)}
            className="pr-12"
          />
          <PromptInputSubmit
            disabled={!input.trim()}
            className="absolute bottom-1 right-1"
          />
        </PromptInput>
      </div>
    </div>
  )
}
