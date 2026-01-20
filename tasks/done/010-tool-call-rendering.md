# Task 010: Tool Call Rendering - Display Tool Executions Inline

## Status: TODO

## Objective

Implement interactive tool call rendering that displays tool executions inline within assistant messages. Users should be able to expand/collapse tool calls to see input, output, and execution status.

## Prerequisites

- Task 007 (Message display) complete
- Task 008 (SSE integration) complete
- Task 009 (Prompt input) complete
- Messages streaming from API
- Tool call data available in message parts

## Context

When OpenCode executes tools (bash commands, file edits, etc.), these should be visible to the user in the message stream. Tool calls need:

- Collapsed state showing summary (tool name + brief description)
- Expanded state showing full input/output
- Status indicators (pending, running, success, error)
- Click to toggle expand/collapse
- Syntax highlighting for code in input/output

This provides transparency into what OpenCode is doing and helps users understand the assistant's actions.

## Implementation Steps

### Step 1: Define Tool Call Types

Create or update `src/types/message.ts`:

```typescript
export interface ToolCallPart {
  type: "tool_call"
  id: string
  tool: string
  input: any
  output?: any
  status: "pending" | "running" | "success" | "error"
  error?: string
}

export interface MessagePart {
  type: "text" | "tool_call"
  text?: string
  id?: string
  tool?: string
  input?: any
  output?: any
  status?: "pending" | "running" | "success" | "error"
  error?: string
}
```

### Step 2: Create Tool Call Component

Create `src/components/tool-call.tsx`:

```typescript
import { createSignal, Show, Switch, Match } from "solid-js"
import type { ToolCallPart } from "../types/message"

interface ToolCallProps {
  part: ToolCallPart
}

export default function ToolCall(props: ToolCallProps) {
  const [expanded, setExpanded] = createSignal(false)

  function toggleExpanded() {
    setExpanded(!expanded())
  }

  function getToolIcon(tool: string): string {
    switch (tool) {
      case "bash":
        return "⚡"
      case "edit":
        return "✏️"
      case "read":
        return "📖"
      case "write":
        return "📝"
      case "glob":
        return "🔍"
      case "grep":
        return "🔎"
      default:
        return "🔧"
    }
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case "pending":
        return "⏳"
      case "running":
        return "⟳"
      case "success":
        return "✓"
      case "error":
        return "✗"
      default:
        return ""
    }
  }

  function getToolSummary(part: ToolCallPart): string {
    const { tool, input } = part

    switch (tool) {
      case "bash":
        return input?.command || "Execute command"
      case "edit":
        return `Edit ${input?.filePath || "file"}`
      case "read":
        return `Read ${input?.filePath || "file"}`
      case "write":
        return `Write ${input?.filePath || "file"}`
      case "glob":
        return `Find ${input?.pattern || "files"}`
      case "grep":
        return `Search for "${input?.pattern || "pattern"}"`
      default:
        return tool
    }
  }

  function formatJson(obj: any): string {
    if (typeof obj === "string") return obj
    return JSON.stringify(obj, null, 2)
  }

  return (
    <div
      class="tool-call"
      classList={{
        "tool-call-expanded": expanded(),
        "tool-call-error": props.part.status === "error",
        "tool-call-success": props.part.status === "success",
        "tool-call-running": props.part.status === "running",
      }}
      onClick={toggleExpanded}
    >
      <div class="tool-call-header">
        <span class="tool-call-expand-icon">{expanded() ? "▼" : "▶"}</span>
        <span class="tool-call-icon">{getToolIcon(props.part.tool)}</span>
        <span class="tool-call-tool">{props.part.tool}:</span>
        <span class="tool-call-summary">{getToolSummary(props.part)}</span>
        <span class="tool-call-status">{getStatusIcon(props.part.status)}</span>
      </div>

      <Show when={expanded()}>
        <div class="tool-call-body" onClick={(e) => e.stopPropagation()}>
          <Show when={props.part.input}>
            <div class="tool-call-section">
              <div class="tool-call-section-title">Input:</div>
              <pre class="tool-call-content">
                <code>{formatJson(props.part.input)}</code>
              </pre>
            </div>
          </Show>

          <Show when={props.part.output !== undefined}>
            <div class="tool-call-section">
              <div class="tool-call-section-title">Output:</div>
              <pre class="tool-call-content">
                <code>{formatJson(props.part.output)}</code>
              </pre>
            </div>
          </Show>

          <Show when={props.part.error}>
            <div class="tool-call-section tool-call-error-section">
              <div class="tool-call-section-title">Error:</div>
              <pre class="tool-call-content tool-call-error-content">
                <code>{props.part.error}</code>
              </pre>
            </div>
          </Show>

          <Show when={props.part.status === "running"}>
            <div class="tool-call-running-indicator">
              <span class="spinner-small" />
              <span>Executing...</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
```

### Step 3: Update Message Item to Render Tool Calls

Update `src/components/message-item.tsx`:

```typescript
import { For, Show, Switch, Match } from "solid-js"
import type { Message, MessagePart } from "../types/message"
import ToolCall from "./tool-call"

interface MessageItemProps {
  message: Message
}

export default function MessageItem(props: MessageItemProps) {
  const isUser = () => props.message.type === "user"

  return (
    <div
      class="message-item"
      classList={{
        "message-user": isUser(),
        "message-assistant": !isUser(),
      }}
    >
      <div class="message-header">
        <span class="message-author">{isUser() ? "You" : "Assistant"}</span>
        <span class="message-timestamp">
          {new Date(props.message.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      <div class="message-content">
        <For each={props.message.parts}>
          {(part) => (
            <Switch>
              <Match when={part.type === "text"}>
                <div class="message-text">{part.text}</div>
              </Match>
              <Match when={part.type === "tool_call"}>
                <ToolCall part={part as any} />
              </Match>
            </Switch>
          )}
        </For>
      </div>

      <Show when={props.message.status === "error"}>
        <div class="message-error">Failed to send message</div>
      </Show>

      <Show when={props.message.status === "sending"}>
        <div class="message-sending">
          <span class="generating-spinner">●</span> Sending...
        </div>
      </Show>
    </div>
  )
}
```

### Step 4: Add Tool Call Styling

Add to `src/index.css`:

```css
/* Tool Call Styles */
.tool-call {
  margin: 8px 0;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background-color: var(--secondary-bg);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.tool-call:hover {
  border-color: var(--accent-color);
}

.tool-call-expanded {
  cursor: default;
}

.tool-call-success {
  border-left: 3px solid #10b981;
}

.tool-call-error {
  border-left: 3px solid #ef4444;
}

.tool-call-running {
  border-left: 3px solid var(--accent-color);
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
}

.tool-call-expand-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 150ms ease;
}

.tool-call-expanded .tool-call-expand-icon {
  transform: rotate(0deg);
}

.tool-call-icon {
  font-size: 14px;
}

.tool-call-tool {
  font-weight: 600;
  color: var(--text);
}

.tool-call-summary {
  flex: 1;
  color: var(--text-muted);
  font-family: monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-call-status {
  font-size: 14px;
  margin-left: auto;
}

.tool-call-body {
  border-top: 1px solid var(--border-color);
  padding: 12px;
  background-color: var(--background);
}

.tool-call-section {
  margin-bottom: 12px;
}

.tool-call-section:last-child {
  margin-bottom: 0;
}

.tool-call-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}

.tool-call-content {
  background-color: var(--secondary-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 12px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  margin: 0;
}

.tool-call-content code {
  font-family: inherit;
  background: none;
  padding: 0;
}

.tool-call-error-section {
  background-color: rgba(239, 68, 68, 0.05);
  border-radius: 4px;
  padding: 8px;
}

.tool-call-error-content {
  background-color: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #dc2626;
}

.tool-call-running-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--secondary-bg);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-muted);
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Dark mode adjustments */
@media (prefers-color-scheme: dark) {
  .tool-call {
    background-color: rgba(255, 255, 255, 0.03);
  }

  .tool-call-body {
    background-color: rgba(0, 0, 0, 0.2);
  }

  .tool-call-content {
    background-color: rgba(0, 0, 0, 0.3);
  }
}
```

### Step 5: Update SSE Handler to Parse Tool Calls

Update `src/lib/sse-manager.ts` to correctly parse tool call parts from SSE events:

```typescript
function handleMessageUpdate(event: MessageUpdateEvent, instanceId: string) {
  // When a message part arrives via SSE, check if it's a tool call
  const part = event.part

  if (part.type === "tool_call") {
    // Parse tool call data
    const toolCallPart: ToolCallPart = {
      type: "tool_call",
      id: part.id || `tool-${Date.now()}`,
      tool: part.tool || "unknown",
      input: part.input,
      output: part.output,
      status: part.status || "pending",
      error: part.error,
    }

    // Add or update in messages
    updateMessagePart(instanceId, event.sessionId, event.messageId, toolCallPart)
  }
}
```

### Step 6: Handle Tool Call Updates

Ensure that tool calls can update their status as they execute:

```typescript
// In sessions store
function updateMessagePart(instanceId: string, sessionId: string, messageId: string, part: MessagePart) {
  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    const session = instanceSessions.get(sessionId)

    if (session) {
      const messages = session.messages.map((msg) => {
        if (msg.id === messageId) {
          // Find existing part by ID and update, or append
          const partIndex = msg.parts.findIndex((p) => p.type === "tool_call" && p.id === part.id)

          if (partIndex !== -1) {
            const updatedParts = [...msg.parts]
            updatedParts[partIndex] = part
            return { ...msg, parts: updatedParts }
          } else {
            return { ...msg, parts: [...msg.parts, part] }
          }
        }
        return msg
      })

      instanceSessions.set(sessionId, { ...session, messages })
    }

    next.set(instanceId, instanceSessions)
    return next
  })
}
```

## Testing Checklist

### Visual Rendering

- [ ] Tool calls render in collapsed state by default
- [ ] Tool icon displays correctly for each tool type
- [ ] Tool summary shows meaningful description
- [ ] Status icon displays correctly (pending, running, success, error)
- [ ] Styling is consistent with design

### Expand/Collapse

- [ ] Click tool call header - expands to show details
- [ ] Click again - collapses back to summary
- [ ] Expand icon rotates correctly
- [ ] Clicking inside expanded body doesn't collapse
- [ ] Multiple tool calls can be expanded independently

### Content Display

- [ ] Input section shows tool input data
- [ ] Output section shows tool output data
- [ ] JSON is formatted with proper indentation
- [ ] Code/text is displayed in monospace font
- [ ] Long output is scrollable horizontally

### Status Indicators

- [ ] Pending status shows waiting icon (⏳)
- [ ] Running status shows spinner and "Executing..."
- [ ] Success status shows checkmark (✓)
- [ ] Error status shows X (✗) and error message
- [ ] Border color changes based on status

### Real-time Updates

- [ ] Tool calls appear as SSE events arrive
- [ ] Status updates from pending → running → success
- [ ] Output appears when tool completes
- [ ] Error state shows if tool fails
- [ ] UI updates smoothly without flashing

### Different Tool Types

- [ ] Bash commands display correctly
- [ ] File edits show file path and changes
- [ ] File reads show file path
- [ ] Glob/grep show patterns
- [ ] Unknown tools have fallback icon

### Error Handling

- [ ] Tool errors display error message
- [ ] Error section has red styling
- [ ] Error state is clearly visible
- [ ] Can expand to see full error details

## Acceptance Criteria

- [ ] Tool calls render inline in assistant messages
- [ ] Default collapsed state shows summary
- [ ] Click to expand shows full input/output
- [ ] Status indicators work correctly
- [ ] Real-time updates via SSE work
- [ ] Multiple tool calls in one message work
- [ ] Error states are clear and helpful
- [ ] Styling matches design specifications
- [ ] No performance issues with many tool calls
- [ ] No console errors during normal operation

## Performance Considerations

**Per MVP principles - keep it simple:**

- Render all tool calls - no virtualization
- No lazy loading of tool content
- Simple JSON.stringify for formatting
- Direct DOM updates via SolidJS reactivity
- Add optimizations only if problems arise

## Future Enhancements (Post-MVP)

- Syntax highlighting for code in input/output (using Shiki)
- Diff view for file edits
- Copy button for tool output
- Link to file in file operations
- Collapsible sections within tool calls
- Tool execution time display
- Retry failed tools
- Export tool output

## References

- [User Interface - Tool Call Rendering](../docs/user-interface.md#3-messages-area)
- [Technical Implementation - Tool Call Rendering](../docs/technical-implementation.md#message-rendering)
- [Build Roadmap - Phase 2](../docs/build-roadmap.md#phase-2-core-chat-interface-week-2)

## Estimated Time

3-4 hours

## Notes

- Focus on clear visual hierarchy - collapsed view should be scannable
- Status indicators help users understand what's happening
- Errors should be prominent but not alarming
- Tool calls are a key differentiator - make them shine
- Test with real OpenCode responses to ensure data format matches
- Consider adding debug logging to verify SSE data structure
