# Task 009: Prompt Input Basic - Text Input with Send Functionality

## Status: TODO

## Objective

Implement a basic prompt input component that allows users to type messages and send them to the OpenCode server. This enables testing of the SSE integration and completes the core chat interface loop.

## Prerequisites

- Task 007 (Message display) complete
- Task 008 (SSE integration) complete
- Active session available
- SDK client configured

## Context

The prompt input is the primary way users interact with OpenCode. For the MVP, we need:

- Simple text input (multi-line textarea)
- Send button
- Basic keyboard shortcuts (Enter to send, Shift+Enter for new line)
- Loading state while assistant is responding
- Basic validation (empty message prevention)

Advanced features (slash commands, file attachments, @ mentions) will come in Task 021-024.

## Implementation Steps

### Step 1: Create Prompt Input Component

Create `src/components/prompt-input.tsx`:

```typescript
import { createSignal, Show } from "solid-js"

interface PromptInputProps {
  instanceId: string
  sessionId: string
  onSend: (prompt: string) => Promise<void>
  disabled?: boolean
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPrompt] = createSignal("")
  const [sending, setSending] = createSignal(false)
  let textareaRef: HTMLTextAreaElement | undefined

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleSend() {
    const text = prompt().trim()
    if (!text || sending() || props.disabled) return

    setSending(true)
    try {
      await props.onSend(text)
      setPrompt("")

      // Auto-resize textarea back to initial size
      if (textareaRef) {
        textareaRef.style.height = "auto"
      }
    } catch (error) {
      console.error("Failed to send message:", error)
      alert("Failed to send message: " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSending(false)
      textareaRef?.focus()
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement
    setPrompt(target.value)

    // Auto-resize textarea
    target.style.height = "auto"
    target.style.height = Math.min(target.scrollHeight, 200) + "px"
  }

  const canSend = () => prompt().trim().length > 0 && !sending() && !props.disabled

  return (
    <div class="prompt-input-container">
      <div class="prompt-input-wrapper">
        <textarea
          ref={textareaRef}
          class="prompt-input"
          placeholder="Type your message or /command..."
          value={prompt()}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={sending() || props.disabled}
          rows={1}
        />
        <button
          class="send-button"
          onClick={handleSend}
          disabled={!canSend()}
          aria-label="Send message"
        >
          <Show when={sending()} fallback={<span class="send-icon">▶</span>}>
            <span class="spinner-small" />
          </Show>
        </button>
      </div>
      <div class="prompt-input-hints">
        <span class="hint">
          <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
        </span>
      </div>
    </div>
  )
}
```

### Step 2: Add Send Message Function to Sessions Store

Update `src/stores/sessions.ts` to add message sending:

```typescript
async function sendMessage(
  instanceId: string,
  sessionId: string,
  prompt: string,
  attachments: string[] = [],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  // Add user message optimistically
  const userMessage: Message = {
    id: `temp-${Date.now()}`,
    sessionId,
    type: "user",
    parts: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
    status: "sending",
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    const updatedSession = instanceSessions.get(sessionId)
    if (updatedSession) {
      const newMessages = [...updatedSession.messages, userMessage]
      instanceSessions.set(sessionId, { ...updatedSession, messages: newMessages })
    }
    next.set(instanceId, instanceSessions)
    return next
  })

  try {
    // Send to server using session.prompt (not session.message)
    await instance.client.session.prompt({
      path: { id: sessionId },
      body: {
        messageID: userMessage.id,
        parts: [
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    })

    // Update user message status
    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      const updatedSession = instanceSessions.get(sessionId)
      if (updatedSession) {
        const messages = updatedSession.messages.map((m) =>
          m.id === userMessage.id ? { ...m, status: "sent" as const } : m,
        )
        instanceSessions.set(sessionId, { ...updatedSession, messages })
      }
      next.set(instanceId, instanceSessions)
      return next
    })
  } catch (error) {
    // Update user message with error
    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      const updatedSession = instanceSessions.get(sessionId)
      if (updatedSession) {
        const messages = updatedSession.messages.map((m) =>
          m.id === userMessage.id ? { ...m, status: "error" as const } : m,
        )
        instanceSessions.set(sessionId, { ...updatedSession, messages })
      }
      next.set(instanceId, instanceSessions)
      return next
    })
    throw error
  }
}

// Export it
export { sendMessage }
```

### Step 3: Integrate Prompt Input into App

Update `src/App.tsx` to add the prompt input:

```typescript
import PromptInput from "./components/prompt-input"
import { sendMessage } from "./stores/sessions"

// In the SessionMessages component or create a new wrapper component
const SessionView: Component<{
  sessionId: string
  activeSessions: Map<string, Session>
  instanceId: string
}> = (props) => {
  const session = () => props.activeSessions.get(props.sessionId)

  createEffect(() => {
    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch(console.error)
    }
  })

  async function handleSendMessage(prompt: string) {
    await sendMessage(props.instanceId, props.sessionId, prompt)
  }

  return (
    <Show
      when={session()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">Session not found</div>
        </div>
      }
    >
      {(s) => (
        <div class="session-view">
          <MessageStream
            instanceId={props.instanceId}
            sessionId={s().id}
            messages={s().messages || []}
            messagesInfo={s().messagesInfo}
          />
          <PromptInput
            instanceId={props.instanceId}
            sessionId={s().id}
            onSend={handleSendMessage}
          />
        </div>
      )}
    </Show>
  )
}

// Replace SessionMessages usage with SessionView
```

### Step 4: Add Styling

Add to `src/index.css`:

```css
.prompt-input-container {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-color);
  background-color: var(--background);
}

.prompt-input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
}

.prompt-input {
  flex: 1;
  min-height: 40px;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  background-color: var(--background);
  color: inherit;
  outline: none;
  transition: border-color 150ms ease;
}

.prompt-input:focus {
  border-color: var(--accent-color);
}

.prompt-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.prompt-input::placeholder {
  color: var(--text-muted);
}

.send-button {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background-color: var(--accent-color);
  color: white;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity 150ms ease,
    transform 150ms ease;
  flex-shrink: 0;
}

.send-button:hover:not(:disabled) {
  opacity: 0.9;
  transform: scale(1.05);
}

.send-button:active:not(:disabled) {
  transform: scale(0.95);
}

.send-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-icon {
  font-size: 16px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.prompt-input-hints {
  padding: 0 16px 8px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.hint kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-family: monospace;
  background-color: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  margin: 0 2px;
}

.session-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
```

### Step 5: Update Message Display for User Messages

Make sure user messages display correctly in `src/components/message-item.tsx`:

```typescript
// User messages should show with user styling
// Message status should be visible (sending, sent, error)

<Show when={props.message.status === "error"}>
  <div class="message-error">Failed to send message</div>
</Show>

<Show when={props.message.status === "sending"}>
  <div class="message-sending">
    <span class="generating-spinner">●</span> Sending...
  </div>
</Show>
```

### Step 6: Handle Real-time Response

The SSE integration from Task 008 should automatically:

1. Receive message_updated events
2. Create assistant message in the session
3. Stream message parts as they arrive
4. Update the UI in real-time

No additional code needed - this should "just work" if SSE is connected.

## Testing Checklist

### Basic Functionality

- [ ] Prompt input renders at bottom of session view
- [ ] Can type text in the textarea
- [ ] Textarea auto-expands as you type (up to max height)
- [ ] Send button is disabled when input is empty
- [ ] Send button is enabled when text is present

### Sending Messages

- [ ] Click send button - message appears in stream
- [ ] Press Enter - message sends
- [ ] Press Shift+Enter - adds new line (doesn't send)
- [ ] Input clears after sending
- [ ] Focus returns to input after sending

### User Message Display

- [ ] User message appears immediately (optimistic update)
- [ ] User message shows "Sending..." state briefly
- [ ] User message updates to "sent" after API confirms
- [ ] Error state shows if send fails

### Assistant Response

- [ ] After sending, SSE receives message updates
- [ ] Assistant message appears in stream
- [ ] Message parts stream in real-time
- [ ] Tool calls appear as they execute
- [ ] Connection status indicator shows "Connected"

### Edge Cases

- [ ] Can't send while previous message is processing
- [ ] Empty/whitespace-only messages don't send
- [ ] Very long messages work correctly
- [ ] Multiple rapid sends are queued properly
- [ ] Network error shows helpful message

## Acceptance Criteria

- [ ] Can type and send text messages
- [ ] Enter key sends message
- [ ] Shift+Enter creates new line
- [ ] Send button works correctly
- [ ] User messages appear immediately
- [ ] Assistant responses stream in real-time via SSE
- [ ] Input auto-expands up to max height
- [ ] Loading states are clear
- [ ] Error handling works
- [ ] No console errors during normal operation

## Performance Considerations

**Per MVP principles - keep it simple:**

- Direct API calls - no batching
- Optimistic updates for user messages
- SSE handles streaming automatically
- No debouncing or throttling needed

## Future Enhancements (Post-MVP)

- Slash command autocomplete (Task 021)
- File attachment support (Task 022)
- Drag & drop files (Task 023)
- Attachment chips (Task 024)
- Message history navigation (Task 025)
- Multi-line paste handling
- Rich text formatting
- Message drafts persistence

## References

- [User Interface - Prompt Input](../docs/user-interface.md#5-prompt-input)
- [Technical Implementation - Message Rendering](../docs/technical-implementation.md#message-rendering)
- [Task 008 - SSE Integration](./008-sse-integration.md)

## Estimated Time

2-3 hours

## Notes

- Focus on core functionality - no fancy features yet
- Test thoroughly with SSE to ensure real-time streaming works
- This completes the basic chat loop - users can now interact with OpenCode
- Keep error messages user-friendly and actionable
- Ensure keyboard shortcuts work as expected
