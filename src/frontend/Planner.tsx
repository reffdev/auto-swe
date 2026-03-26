import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Send, CheckCircle, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import * as api from './api'
import { usePlannerPoll } from './usePlannerPoll'

interface PlannerProps {
  projectId: string
  conversationId?: string
}

export function Planner({ projectId, conversationId: initialConversationId }: PlannerProps) {
  const navigate = useNavigate()
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { messages, generating, partialText, error: pollError } = usePlannerPoll(conversationId)

  // Create conversation on mount if none provided
  useEffect(() => {
    if (initialConversationId) return
    let cancelled = false
    api.createPlannerConversation(projectId).then(conv => {
      if (!cancelled) {
        setConversationId(conv.id)
        navigate(`/project/${projectId}/planner/${conv.id}`, { replace: true })
      }
    }).catch(err => setError(err.message))
    return () => { cancelled = true }
  }, [projectId, initialConversationId, navigate])

  // Optimistic user messages (shown immediately before poll confirms them)
  const [optimisticMessages, setOptimisticMessages] = useState<api.PlannerMessage[]>([])

  // Clean up optimistic messages once their content appears in poll results
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const pollContents = new Set(messages.map(m => m.content))
    const stillPending = optimisticMessages.filter(m => !pollContents.has(m.content))
    if (stillPending.length < optimisticMessages.length) {
      setOptimisticMessages(stillPending)
    }
  }, [messages, optimisticMessages])

  // Merge poll messages with optimistic ones
  const displayMessages = (() => {
    const pollContents = new Set(messages.map(m => m.content))
    const stillPending = optimisticMessages.filter(m => !pollContents.has(m.content))
    return [...messages, ...stillPending]
  })()

  // Check if the last assistant message has a proposal (single or epic)
  const hasProposal = displayMessages.some(
    m => m.role === 'assistant' && (m.content.includes('```issue_proposal') || m.content.includes('```epic_proposal'))
  )
  const hasEpic = displayMessages.some(
    m => m.role === 'assistant' && m.content.includes('```epic_proposal')
  )
  // Count stories in epic
  const epicStoryCount = (() => {
    if (!hasEpic) return 0
    const lastEpicMsg = [...displayMessages].reverse().find(m => m.role === 'assistant' && m.content.includes('```epic_proposal'))
    if (!lastEpicMsg) return 0
    return (lastEpicMsg.content.match(/^story:\s*\d+/gm) ?? []).length
  })()

  const handleSend = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!conversationId || !input.trim() || sending || generating) return

    const text = input.trim()
    setInput('')
    setSending(true)
    setError(null)

    // Show user message immediately
    const optimistic: api.PlannerMessage = {
      id: `optimistic-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setOptimisticMessages(prev => [...prev, optimistic])

    try {
      await api.sendPlannerMessage(conversationId, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
      // Remove optimistic message on failure
      setOptimisticMessages(prev => prev.filter(m => m.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }, [conversationId, input, sending, generating])

  const handleApprove = useCallback(async () => {
    if (!conversationId || approving) return
    setApproving(true)
    setError(null)
    try {
      const result = await api.approvePlannerConversation(conversationId) as any
      const issueId = result.epic?.id ?? result.issue?.id
      navigate(`/project/${projectId}/issue/${issueId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create issue')
    } finally {
      setApproving(false)
    }
  }, [conversationId, approving, projectId, navigate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const displayError = error || pollError

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigate(`/project/${projectId}`)}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <MessageSquarePlus className="size-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Issue Planner</h2>
        </div>
        {hasProposal && (
          <Button onClick={handleApprove} disabled={approving || generating}>
            <CheckCircle className="size-4 mr-2" />
            {approving ? 'Creating...' : hasEpic ? `Create Epic (${epicStoryCount} stories)` : 'Create Issue'}
          </Button>
        )}
      </div>

      {/* Conversation */}
      <Conversation className="flex-1">
        <ConversationContent>
          {displayMessages.length === 0 && !generating && (
            <ConversationEmptyState
              title="Start planning an issue"
              description="Describe what you want to build or fix, and I'll help you refine it into a clear issue specification."
              icon={<MessageSquarePlus className="size-8" />}
            />
          )}
          {displayMessages.map(msg => (
            <Message key={msg.id} from={msg.role}>
              <MessageContent>
                <MessageResponse>{msg.content}</MessageResponse>
              </MessageContent>
            </Message>
          ))}
          {generating && partialText && (
            <Message from="assistant">
              <MessageContent>
                <MessageResponse isAnimating>{partialText}</MessageResponse>
              </MessageContent>
            </Message>
          )}
          {generating && !partialText && (
            <Message from="assistant">
              <MessageContent>
                <span className="text-muted-foreground text-sm animate-pulse">Thinking...</span>
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Error display */}
      {displayError && (
        <div className="px-6 py-2 text-sm text-destructive">{displayError}</div>
      )}

      {/* Input */}
      <div className="border-t border-border p-4">
        <form onSubmit={handleSend} className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want to build or fix..."
            className="min-h-[44px] max-h-[200px] resize-none"
            rows={1}
            disabled={!conversationId || generating}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || !conversationId || sending || generating}
          >
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  )
}
