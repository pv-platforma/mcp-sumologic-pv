/**
 * Manages conversation context using Slack threads.
 *
 * - New top-level message → fresh context, no history
 * - Reply in a thread → gathers thread history, sends to LLM as conversation
 * - Each thread gets its own chat_id for Open WebUI session management
 * - Thread context auto-expires after 1 hour of inactivity
 */

interface ConversationEntry {
  chatId: string;
  threadTs: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastActivity: number;
  namespace?: string;
  region?: string;
}

const MAX_HISTORY_MESSAGES = 10; // Keep last 10 exchanges per thread
const CONTEXT_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

export class ConversationManager {
  private conversations: Map<string, ConversationEntry> = new Map();

  /**
   * Get or create a conversation for a thread.
   * Returns { chatId, history, isFollowUp }.
   */
  getConversation(threadTs: string | undefined): {
    chatId: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    isFollowUp: boolean;
  } {
    this.cleanup();

    // No thread = new top-level message = fresh context
    if (!threadTs) {
      return {
        chatId: `opvi-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        history: [],
        isFollowUp: false,
      };
    }

    // Existing conversation for this thread
    const existing = this.conversations.get(threadTs);
    if (existing) {
      existing.lastActivity = Date.now();
      return {
        chatId: existing.chatId,
        history: existing.messages.slice(-MAX_HISTORY_MESSAGES),
        isFollowUp: existing.messages.length > 0,
      };
    }

    // New thread — create entry
    const chatId = `opvi-thread-${threadTs}-${Math.random().toString(36).substring(2, 8)}`;
    const entry: ConversationEntry = {
      chatId,
      threadTs,
      messages: [],
      lastActivity: Date.now(),
    };
    this.conversations.set(threadTs, entry);

    return {
      chatId,
      history: [],
      isFollowUp: false,
    };
  }

  /** Add a user message to the thread's history */
  addUserMessage(threadTs: string, content: string): void {
    const entry = this.conversations.get(threadTs);
    if (entry) {
      entry.messages.push({ role: 'user', content });
      entry.lastActivity = Date.now();
      this.trimMessages(entry);
    }
  }

  /** Add an assistant response to the thread's history (trimmed to avoid token bloat) */
  addAssistantMessage(threadTs: string, content: string): void {
    const entry = this.conversations.get(threadTs);
    if (entry) {
      const trimmed = content.length > 2000
        ? content.substring(0, 2000) + '\n... (truncated)'
        : content;
      entry.messages.push({ role: 'assistant', content: trimmed });
      entry.lastActivity = Date.now();
      this.trimMessages(entry);
    }
  }

  /** Store context (namespace, region) so follow-ups inherit them */
  setContext(threadTs: string, namespace?: string, region?: string): void {
    const entry = this.conversations.get(threadTs);
    if (entry) {
      if (namespace) entry.namespace = namespace;
      if (region) entry.region = region;
    }
  }

  /** Get inherited context from the thread */
  getContext(threadTs: string | undefined): { namespace?: string; region?: string } {
    if (!threadTs) return {};
    const entry = this.conversations.get(threadTs);
    if (!entry) return {};
    return { namespace: entry.namespace, region: entry.region };
  }

  /** Stats for monitoring */
  getStats(): { activeThreads: number; totalMessages: number } {
    let totalMessages = 0;
    for (const entry of this.conversations.values()) {
      totalMessages += entry.messages.length;
    }
    return { activeThreads: this.conversations.size, totalMessages };
  }

  private trimMessages(entry: ConversationEntry): void {
    if (entry.messages.length > MAX_HISTORY_MESSAGES * 2) {
      entry.messages = entry.messages.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.conversations.entries()) {
      if (now - entry.lastActivity > CONTEXT_TTL_MS) {
        this.conversations.delete(key);
      }
    }
  }
}

// Singleton
export const conversationManager = new ConversationManager();
