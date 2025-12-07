# User Interface Specification

## Overview

The ReactorPro interface consists of a two-level tabbed layout with instance tabs at the top and session tabs below. Each session displays a message stream and prompt input.

## Layout Structure

```
┌──────────────────────────────────────────────────────────────┐
│ File  Edit  View  Window  Help                    ● ○ ◐     │ ← Native menu bar
├──────────────────────────────────────────────────────────────┤
│ [~/project-a] [~/project-a (2)] [~/api-service] [+]         │ ← Instance tabs (Level 1)
├──────────────────────────────────────────────────────────────┤
│ [Main] [Fix login] [Write tests] [Logs] [+]                 │ ← Session tabs (Level 2)
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Messages Area                                          │ │
│  │                                                        │ │
│  │ User: How do I set up testing?                        │ │
│  │                                                        │ │
│  │ Assistant: To set up testing, you'll need to...       │ │
│  │ → bash: npm install vitest                     ✓      │ │
│  │   Output: added 50 packages                           │ │
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Agent: Build ▼        Model: Claude 3.5 Sonnet ▼            │ ← Controls
├──────────────────────────────────────────────────────────────┤
│ [@file.ts] [@api.ts] [×]                                    │ ← Attachments
│ ┌────────────────────────────────────────────────────────┐  │
│ │ Type your message or /command...                       │  │ ← Prompt input
│ │                                                        │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                          [▶] │ ← Send button
└──────────────────────────────────────────────────────────────┘
```

## Components Specification

### 1. Instance Tabs (Level 1)

**Visual Design:**

- Horizontal tabs at top of window
- Each tab shows folder name
- Icon: Folder icon (🗂️)
- Close button (×) on hover
- Active tab: Highlighted with accent color
- Inactive tabs: Muted background

**Tab Label Format:**

- Single instance: `~/project-name`
- Multiple instances of same folder: `~/project-name (2)`, `~/project-name (3)`
- Max width: 200px with ellipsis for long paths
- Tooltip shows full path on hover

**Actions:**

- Click: Switch to that instance
- Close (×): Stop server and close instance (with confirmation)
- Drag: Reorder tabs (future)

**New Instance Button (+):**

- Always visible at right end
- Click: Opens folder picker dialog
- Keyboard: Cmd/Ctrl+N

**States:**

- Starting: Loading spinner + "Starting..."
- Ready: Normal appearance
- Error: Red indicator + error icon
- Stopped: Grayed out (should not be visible, tab closes)

### 2. Session Tabs (Level 2)

**Visual Design:**

- Horizontal tabs below instance tabs
- Smaller than instance tabs
- Each tab shows session title or "Untitled"
- Active tab: Underline or bold
- Parent-child relationship: No visual distinction (all siblings)

**Tab Types:**

**Session Tab:**

- Label: Session title (editable on double-click)
- Icon: Chat bubble (💬) or none
- Close button (×) on hover
- Max width: 150px with ellipsis

**Logs Tab:**

- Label: "Logs"
- Icon: Terminal (⚡)
- Always present per instance
- Non-closable
- Shows server stdout/stderr

**Actions:**

- Click: Switch to that session
- Double-click label: Rename session
- Close (×): Delete session (with confirmation if has messages)
- Right-click: Context menu (Share, Export, Delete)

**New Session Button (+):**

- Click: Creates new session with default agent
- Keyboard: Cmd/Ctrl+T

### 3. Messages Area

**Container:**

- Scrollable viewport
- Auto-scroll to bottom when new messages arrive
- Manual scroll up: Disable auto-scroll
- "Scroll to bottom" button appears when scrolled up

**Message Layout:**

**User Message:**

```
┌──────────────────────────────────────────┐
│ You                            10:32 AM  │
│ How do I set up testing?                │
│                                          │
│ [@src/app.ts] [@package.json]           │ ← Attachments if any
└──────────────────────────────────────────┘
```

**Assistant Message:**

````
┌──────────────────────────────────────────┐
│ Assistant • Build              10:32 AM  │
│ To set up testing, you'll need to        │
│ install Vitest and configure it.         │
│                                          │
│ ▶ bash: npm install vitest        ✓     │ ← Tool call (collapsed)
│                                          │
│ ▶ edit src/vitest.config.ts      ✓     │
│                                          │
│ Here's the configuration I added:        │
│ ```typescript                            │
│ export default {                         │
│   test: { globals: true }                │
│ }                                        │
│ ```                                      │
└──────────────────────────────────────────┘
````

**Tool Call (Collapsed):**

```
▶ bash: npm install vitest                    ✓
  ^   ^                                       ^
  |   |                                       |
Icon Tool name + summary                   Status
```

**Tool Call (Expanded):**

```
▼ bash: npm install vitest                    ✓

  Input:
  {
    "command": "npm install vitest"
  }

  Output:
  added 50 packages, and audited 51 packages in 2s
  found 0 vulnerabilities
```

**Status Icons:**

- ⏳ Pending (spinner)
- ✓ Success (green checkmark)
- ✗ Error (red X)
- ⚠ Warning (yellow triangle)

**File Change Display:**

```
▶ edit src/vitest.config.ts                   ✓
  Modified: src/vitest.config.ts
  +12 lines, -3 lines
```

Click to expand: Show diff inline

### 4. Controls Bar

**Agent Selector:**

- Dropdown button showing current agent
- Click: Opens dropdown with agent list
- Shows: Agent name + description
- Grouped by category (if applicable)

**Model Selector:**

- Dropdown button showing current model
- Click: Opens dropdown with model list
- Shows: Provider icon + Model name
- Grouped by provider
- Displays: Context window, capabilities icons

**Layout:**

```
┌────────────────────────────────────────────┐
│ Agent: Build ▼    Model: Claude 3.5 ▼     │
└────────────────────────────────────────────┘
```

### 5. Prompt Input

**Input Field:**

- Multi-line textarea
- Auto-expanding (max 10 lines)
- Placeholder: "Type your message or /command..."
- Supports keyboard shortcuts

**Features:**

**Slash Commands:**

- Type `/` → Autocomplete dropdown appears
- Shows: Command name + description
- Filter as you type
- Enter to execute

**File Mentions:**

- Type `@` → File picker appears
- Search files by name
- Shows: File icon + path
- Enter to attach

**Attachments:**

- Display as chips above input
- Format: [@filename] [×]
- Click × to remove
- Drag & drop files onto input area

**Send Button:**

- Icon: Arrow (▶) or paper plane
- Click: Submit message
- Keyboard: Enter (without Shift)
- Disabled when: Empty input or server busy

**Keyboard Shortcuts:**

- Enter: New line
- Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux): Send message
- Cmd/Ctrl+K: Clear input
- Cmd/Ctrl+V: Paste (handles files)
- Cmd/Ctrl+L: Focus input
- Up/Down: Navigate message history (when input empty)

## Overlays & Modals

### Session Picker (Startup)

Appears when instance starts:

```
┌────────────────────────────────────────┐
│  OpenCode • ~/project-a                │
├────────────────────────────────────────┤
│  Resume a session:                     │
│                                        │
│  > Fix login bug            2h ago     │
│    Add dark mode            5h ago     │
│    Refactor API             Yesterday  │
│                                        │
│  ────────────── or ──────────────      │
│                                        │
│  Start new session:                    │
│  Agent: [Build ▼]  [Start]             │
│                                        │
│  [Cancel]                              │
└────────────────────────────────────────┘
```

**Actions:**

- Click session: Resume that session
- Click "Start": Create new session with selected agent
- Click "Cancel": Close instance
- Keyboard: Arrow keys to navigate, Enter to select

### Confirmation Dialogs

**Close Instance:**

```
┌────────────────────────────────────────┐
│  Stop OpenCode instance?               │
├────────────────────────────────────────┤
│  This will stop the server for:        │
│  ~/project-a                           │
│                                        │
│  Active sessions will be lost.         │
│                                        │
│  [Cancel]  [Stop Instance]             │
└────────────────────────────────────────┘
```

**Delete Session:**

```
┌────────────────────────────────────────┐
│  Delete session?                       │
├────────────────────────────────────────┤
│  This will permanently delete:         │
│  "Fix login bug"                       │
│                                        │
│  This cannot be undone.                │
│                                        │
│  [Cancel]  [Delete]                    │
└────────────────────────────────────────┘
```

## Empty States

### No Instances

```
┌──────────────────────────────────────────┐
│                                          │
│           [Folder Icon]                  │
│                                          │
│        Start Coding with AI        │
│                                          │
│  Select a folder to start coding with AI │
│                                          │
│     [Select Folder]                      │
│                                          │
│  Keyboard shortcut: Cmd/Ctrl+N           │
│                                          │
└──────────────────────────────────────────┘
```

### No Messages (New Session)

```
┌──────────────────────────────────────────┐
│                                          │
│     Start a conversation                 │
│                                          │
│  Type a message below or try:            │
│  • /init-project                         │
│  • Ask about your codebase               │
│  • Attach files with @                   │
│                                          │
└──────────────────────────────────────────┘
```

### Logs Tab (No Logs Yet)

```
┌──────────────────────────────────────────┐
│  Waiting for server output...            │
└──────────────────────────────────────────┘
```

## Visual Styling

### Color Scheme

**Light Mode:**

- Background: #FFFFFF
- Secondary background: #F5F5F5
- Border: #E0E0E0
- Text: #1A1A1A
- Muted text: #666666
- Accent: #0066FF

**Dark Mode:**

- Background: #1A1A1A
- Secondary background: #2A2A2A
- Border: #3A3A3A
- Text: #E0E0E0
- Muted text: #999999
- Accent: #0080FF

### Typography

- **Main text**: 14px, system font
- **Headers**: 16px, medium weight
- **Labels**: 12px, regular weight
- **Code**: Monospace font (Consolas, Monaco, Courier)
- **Line height**: 1.5

### Spacing

- **Padding**: 8px, 12px, 16px, 24px (consistent scale)
- **Margins**: Same as padding
- **Tab height**: 40px
- **Input height**: 80px (auto-expanding)
- **Message spacing**: 16px between messages

### Icons

- Use consistent icon set (Lucide, Heroicons, or similar)
- Size: 16px for inline, 20px for buttons
- Stroke width: 2px

## Responsive Behavior

### Minimum Window Size

- Width: 800px
- Height: 600px

### Behavior When Small

- Instance tabs: Scroll horizontally
- Session tabs: Scroll horizontally
- Messages: Always visible, scroll vertically
- Input: Fixed at bottom

## Accessibility

- All interactive elements keyboard-navigable
- ARIA labels for screen readers
- Focus indicators visible
- Color contrast WCAG AA compliant
- Tab trap in modals
- Escape key closes overlays

## Animation & Transitions

- Tab switching: Instant (no animation)
- Message appearance: Fade in (100ms)
- Tool expand/collapse: Slide (200ms)
- Dropdown menus: Fade + slide (150ms)
- Loading states: Spinner or skeleton

## Context Menus

### Session Tab Right-Click

- Rename
- Duplicate
- Share
- Export
- Delete
- Close Other Tabs

### Message Right-Click

- Copy message
- Copy code block
- Edit & regenerate
- Delete message
- Quote in reply

## Status Indicators

### Instance Tab

- Green dot: Server running
- Yellow dot: Server starting
- Red dot: Server error
- No dot: Server stopped

### Session Tab

- Blue pulse: Assistant responding
- No indicator: Idle

### Connection Status

- Bottom right corner: "Connected" or "Reconnecting..."
