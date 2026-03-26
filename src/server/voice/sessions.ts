/**
 * In-memory voice session store with auto-expiry.
 */

import { randomUUID } from "crypto";

export interface VoiceSession {
  id: string;
  messages: Array<{ role: string; content: string }>;
  createdAt: number;
  lastUsedAt: number;
  processing: boolean;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const MAX_MESSAGES = 50; // cap conversation history to prevent context overflow

const sessions = new Map<string, VoiceSession>();

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function getOrCreateSession(sessionId?: string): VoiceSession {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // Trim old messages to prevent context overflow (keep most recent pairs)
      if (existing.messages.length > MAX_MESSAGES) {
        existing.messages = existing.messages.slice(-MAX_MESSAGES);
      }
      return existing;
    }
  }

  const session: VoiceSession = {
    id: sessionId ?? randomUUID(),
    messages: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    processing: false,
  };
  sessions.set(session.id, session);
  return session;
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function getSessionCount(): number {
  return sessions.size;
}
