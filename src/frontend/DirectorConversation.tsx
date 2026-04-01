import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Send, Check, Loader2, RotateCcw, Cpu } from 'lucide-react'
import * as api from './api'
import type { DirectorMessage } from './api'

export function DirectorConversation({ directiveId, onBack }: { directiveId: string; onBack: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DirectorMessage[]>([])
  const [generating, setGenerating] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [machines, setMachines] = useState<api.Machine[]>([])
  const [directorMachineId, setDirectorMachineId] = useState<string>('')
  const [directorModelId, setDirectorModelId] = useState<string>('')

  // Load machines and director config
  useEffect(() => {
    void api.getMachines().then(setMachines).catch(() => {})
    void api.getForemanConfig().then(config => {
      if (config) {
        setDirectorMachineId(config.director_machine_id ?? '')
        setDirectorModelId(config.director_model_id ?? '')
      }
    }).catch(() => {})
  }, [])

  // Load directive and conversation
  useEffect(() => {
    api.getDirectorDirective(directiveId).then(data => {
      if (data.directive.conversation_id) {
        setConversationId(data.directive.conversation_id)
      }
    }).catch(() => {})
  }, [directiveId])

  // Poll for messages when we have a conversation
  const poll = useCallback(async () => {
    if (!conversationId) return
    try {
      const lastId = messages.length > 0 ? messages[messages.length - 1].id : undefined
      const data = await api.pollDirectorMessages(conversationId, lastId)
      if (data.messages.length > 0) {
        setMessages(prev => [...prev, ...data.messages])
      }
      setGenerating(data.generating)
      setPartialText(data.partialText ?? '')
    } catch { /* ignore */ }
  }, [conversationId, messages])

  // Initial load
  useEffect(() => {
    if (!conversationId) return
    api.getDirectorConversation(conversationId).then(data => {
      setMessages(data.messages)
    }).catch(() => {})
  }, [conversationId])

  // Polling interval
  useEffect(() => {
    if (!conversationId) return
    const interval = setInterval(poll, 1500)
    return () => clearInterval(interval)
  }, [conversationId, poll])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, partialText])

  const handleSend = async () => {
    if (!input.trim() || !conversationId) return
    const text = input.trim()
    setInput('')
    setSending(true)
    setError('')
    try {
      await api.sendDirectorMessage(conversationId, text)
      // Message will appear via polling
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setInput(text) // restore input on error
    } finally {
      setSending(false)
    }
  }

  const handleApprove = async () => {
    if (!conversationId) return
    setApproving(true)
    setError('')
    try {
      await api.approveDirectorConversation(conversationId)
      onBack() // go to directive detail
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApproving(false)
    }
  }

  // Check if last message has a plan (design_doc + milestones blocks)
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const hasPlan = lastAssistant?.content.includes('```design_doc') && lastAssistant?.content.includes('```milestones')

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Director Conversation</h2>
          <p className="text-xs text-muted-foreground">Clarify requirements before autonomous execution begins</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Cpu className="size-3.5 text-muted-foreground shrink-0" />
            <select
              value={directorMachineId}
              onChange={(e) => {
                const machineId = e.target.value || null
                setDirectorMachineId(e.target.value)
                const machine = machines.find(m => m.id === machineId)
                void api.updateForemanConfig({
                  director_machine_id: machineId,
                  director_model_id: machine?.model_id ?? null,
                } as any)
                if (machine?.model_id) setDirectorModelId(machine.model_id)
              }}
              className="h-7 text-xs bg-background border border-border rounded-md px-2 text-foreground"
            >
              <option value="">Auto</option>
              {machines.filter(m => m.machine_type === 'inference').map(m => (
                <option key={m.id} value={m.id}>{m.name || m.model_id || m.base_url}{!m.enabled ? ' (disabled)' : ''}</option>
              ))}
            </select>
            {directorMachineId && (
              <input
                value={directorModelId}
                onChange={(e) => {
                  setDirectorModelId(e.target.value)
                  void api.updateForemanConfig({ director_model_id: e.target.value || null } as any)
                }}
                placeholder="model override"
                className="h-7 text-xs bg-background border border-border rounded-md px-2 text-foreground w-40"
              />
            )}
          </div>
          {hasPlan && !generating && (
            <Button size="sm" onClick={handleApprove} disabled={approving}>
              {approving ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Check className="size-3.5 mr-1.5" />}
              {approving ? 'Approving...' : 'Approve Plan'}
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((msg, idx) => {
          const isLast = idx === messages.length - 1;
          const isFailedResponse = isLast && msg.role === 'assistant' && !generating && (
            msg.content.includes('(No response generated)') ||
            msg.content.startsWith('Error generating response:')
          );

          return (
            <div key={msg.id} className={cn('max-w-[80%]', msg.role === 'user' ? 'ml-auto' : '')}>
              <div className={cn(
                'rounded-lg px-4 py-3 text-sm',
                msg.role === 'user' ? 'bg-primary text-primary-foreground' :
                isFailedResponse ? 'bg-destructive/10 border border-destructive/30' : 'bg-muted',
              )}>
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-muted-foreground">
                  {msg.role === 'user' ? 'You' : 'Director'} &middot; {new Date(msg.created_at).toLocaleTimeString()}
                </span>
                {isFailedResponse && conversationId && (
                  <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5"
                    onClick={() => {
                      void api.retryDirectorConversation(conversationId)
                    }}
                  >
                    <RotateCcw className="size-2.5 mr-1" /> Retry
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming partial */}
        {generating && partialText && (
          <div className="max-w-[80%]">
            <div className="bg-muted rounded-lg px-4 py-3 text-sm">
              <pre className="whitespace-pre-wrap font-sans">{partialText}</pre>
              <Loader2 className="size-3 animate-spin text-muted-foreground mt-2 inline-block" />
            </div>
          </div>
        )}

        {generating && !partialText && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-3.5 animate-spin" />
            Director is thinking...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-6 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      {/* Input */}
      <div className="px-6 py-3 border-t border-border">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            disabled={generating || sending}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button onClick={handleSend} disabled={!input.trim() || generating || sending} size="sm">
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
