/**
 * Polling hook for planner conversation messages.
 *
 * Polls at 1s while the LLM is generating, 4s otherwise.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { PlannerMessage, PlannerPollResponse } from "./api";
import { pollPlannerMessages } from "./api";

const POLL_FAST = 1000;
const POLL_SLOW = 4000;

export function usePlannerPoll(conversationId: string | null) {
  const [messages, setMessages] = useState<PlannerMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [partialText, setPartialText] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Track the last message ID for incremental polling
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!conversationId) return;
    try {
      const data: PlannerPollResponse = await pollPlannerMessages(
        conversationId,
        lastMessageIdRef.current
      );

      if (data.messages.length > 0) {
        setMessages(prev => {
          // Merge new messages, avoiding duplicates
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = data.messages.filter(m => !existingIds.has(m.id));
          return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
        });
        lastMessageIdRef.current = data.messages[data.messages.length - 1].id;
      }

      setGenerating(data.generating);
      setPartialText(data.partialText);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Poll failed");
    }
  }, [conversationId]);

  // Initial full fetch when conversation changes
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setGenerating(false);
      setPartialText(undefined);
      lastMessageIdRef.current = undefined;
      return;
    }

    // Reset and do a full fetch (no afterId)
    lastMessageIdRef.current = undefined;
    setMessages([]);
    fetchMessages();
  }, [conversationId, fetchMessages]);

  // Polling interval — faster while generating
  useEffect(() => {
    if (!conversationId) return;

    const interval = generating ? POLL_FAST : POLL_SLOW;

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchMessages, interval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [conversationId, generating, fetchMessages]);

  return { messages, generating, partialText, error, refresh: fetchMessages };
}
