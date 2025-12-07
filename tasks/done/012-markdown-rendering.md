# Task 012: Markdown Rendering

**Status:** Todo  
**Estimated Time:** 3-4 hours  
**Phase:** 3 - Essential Features  
**Dependencies:** 007 (Message Display)

## Overview

Implement proper markdown rendering for assistant messages with syntax-highlighted code blocks. Replace basic text display with rich markdown formatting using Marked and Shiki.

## Context

Currently messages display as plain text. We need to parse and render markdown content from assistant messages, including:

- Headings, bold, italic, links
- Code blocks with syntax highlighting
- Inline code
- Lists (ordered and unordered)
- Blockquotes
- Tables (if needed)

## Requirements

### Functional Requirements

1. **Markdown Parser Integration**
   - Use `marked` library for markdown parsing
   - Configure for safe HTML rendering
   - Support GitHub-flavored markdown

2. **Syntax Highlighting**
   - Use `shiki` for code block highlighting
   - Support light and dark themes
   - Support common languages: TypeScript, JavaScript, Python, Bash, JSON, HTML, CSS, etc.

3. **Code Block Features**
   - Language label displayed
   - Copy button on hover
   - Line numbers (optional for MVP)

4. **Inline Code**
   - Distinct background color
   - Monospace font
   - Subtle padding

5. **Links**
   - Open in external browser
   - Show external link icon
   - Prevent opening in same window

### Technical Requirements

1. **Dependencies**
   - Install `marked` and `@types/marked`
   - Install `shiki`
   - Install `marked-highlight` for integration

2. **Theme Support**
   - Light mode: `github-light` theme
   - Dark mode: `github-dark` theme
   - Respect system theme preference

3. **Security**
   - Sanitize HTML output
   - No script execution
   - Safe link handling

4. **Performance**
   - Lazy load Shiki highlighter
   - Cache highlighter instance
   - Don't re-parse unchanged messages

## Implementation Steps

### Step 1: Install Dependencies

```bash
cd packages/opencode-client
npm install marked shiki
npm install -D @types/marked
```

### Step 2: Create Markdown Utility

Create `src/lib/markdown.ts`:

```typescript
import { marked } from "marked"
import { getHighlighter, type Highlighter } from "shiki"

let highlighter: Highlighter | null = null

async function getOrCreateHighlighter() {
  if (!highlighter) {
    highlighter = await getHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["typescript", "javascript", "python", "bash", "json", "html", "css", "markdown", "yaml", "sql"],
    })
  }
  return highlighter
}

export async function initMarkdown(isDark: boolean) {
  const hl = await getOrCreateHighlighter()

  marked.use({
    async: false,
    breaks: true,
    gfm: true,
  })

  const renderer = new marked.Renderer()

  renderer.code = (code: string, language: string | undefined) => {
    if (!language) {
      return `<pre><code>${escapeHtml(code)}</code></pre>`
    }

    try {
      const html = hl.codeToHtml(code, {
        lang: language,
        theme: isDark ? "github-dark" : "github-light",
      })
      return html
    } catch (e) {
      return `<pre><code class="language-${language}">${escapeHtml(code)}</code></pre>`
    }
  }

  renderer.link = (href: string, title: string | null, text: string) => {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`
  }

  marked.use({ renderer })
}

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}
```

### Step 3: Create Markdown Component

Create `src/components/markdown.tsx`:

```typescript
import { createEffect, createSignal, onMount } from 'solid-js'
import { initMarkdown, renderMarkdown } from '../lib/markdown'

interface MarkdownProps {
  content: string
  isDark?: boolean
}

export function Markdown(props: MarkdownProps) {
  const [html, setHtml] = createSignal('')
  const [ready, setReady] = createSignal(false)

  onMount(async () => {
    await initMarkdown(props.isDark ?? false)
    setReady(true)
  })

  createEffect(() => {
    if (ready()) {
      const rendered = renderMarkdown(props.content)
      setHtml(rendered)
    }
  })

  createEffect(async () => {
    if (props.isDark !== undefined) {
      await initMarkdown(props.isDark)
      const rendered = renderMarkdown(props.content)
      setHtml(rendered)
    }
  })

  return (
    <div
      class="prose prose-sm dark:prose-invert max-w-none"
      innerHTML={html()}
    />
  )
}
```

### Step 4: Add Copy Button to Code Blocks

Create `src/components/code-block.tsx`:

```typescript
import { createSignal, Show } from 'solid-js'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlockWrapper(props: CodeBlockProps) {
  const [copied, setCopied] = createSignal(false)

  const copyCode = async () => {
    await navigator.clipboard.writeText(props.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="relative group">
      <div class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={copyCode}
          class="px-2 py-1 text-xs bg-gray-700 text-white rounded hover:bg-gray-600"
        >
          <Show when={copied()} fallback="Copy">
            Copied!
          </Show>
        </button>
      </div>
      <Show when={props.language}>
        <div class="text-xs text-gray-500 dark:text-gray-400 px-4 pt-2">
          {props.language}
        </div>
      </Show>
      <div innerHTML={props.code} />
    </div>
  )
}
```

### Step 5: Update Message Component

Update `src/components/message-item.tsx` to use Markdown component:

```typescript
import { Markdown } from './markdown'

// In the assistant message rendering:
<For each={textParts()}>
  {(part) => (
    <Markdown
      content={part.content}
      isDark={/* get from theme context */}
    />
  )}
</For>
```

### Step 6: Add Markdown Styles

Add to `src/index.css`:

```css
/* Markdown prose styles */
.prose {
  @apply text-gray-900 dark:text-gray-100;
}

.prose code {
  @apply bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm;
}

.prose pre {
  @apply bg-gray-50 dark:bg-gray-900 rounded-lg p-4 overflow-x-auto;
}

.prose pre code {
  @apply bg-transparent p-0;
}

.prose a {
  @apply text-blue-600 dark:text-blue-400 hover:underline;
}

.prose blockquote {
  @apply border-l-4 border-gray-300 dark:border-gray-700 pl-4 italic;
}

.prose ul {
  @apply list-disc list-inside;
}

.prose ol {
  @apply list-decimal list-inside;
}

.prose h1 {
  @apply text-2xl font-bold mb-4;
}

.prose h2 {
  @apply text-xl font-bold mb-3;
}

.prose h3 {
  @apply text-lg font-bold mb-2;
}

.prose table {
  @apply border-collapse w-full;
}

.prose th {
  @apply border border-gray-300 dark:border-gray-700 px-4 py-2 bg-gray-100 dark:bg-gray-800;
}

.prose td {
  @apply border border-gray-300 dark:border-gray-700 px-4 py-2;
}
```

### Step 7: Handle Theme Changes

Create or update theme context to track light/dark mode:

```typescript
import { createContext, createSignal, useContext } from 'solid-js'

const ThemeContext = createContext<{
  isDark: () => boolean
  toggleTheme: () => void
}>()

export function ThemeProvider(props: { children: any }) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const [isDark, setIsDark] = createSignal(prefersDark)

  const toggleTheme = () => {
    setIsDark(!isDark())
    document.documentElement.classList.toggle('dark')
  }

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {props.children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
```

### Step 8: Test Markdown Rendering

Test with various markdown inputs:

1. **Headings**: `# Heading 1\n## Heading 2`
2. **Code blocks**: ` ```typescript\nconst x = 1\n``` `
3. **Inline code**: `` `npm install` ``
4. **Lists**: `- Item 1\n- Item 2`
5. **Links**: `[OpenCode](https://opencode.ai)`
6. **Bold/Italic**: `**bold** and *italic*`
7. **Blockquotes**: `> Quote`

## Acceptance Criteria

- [ ] Markdown content renders with proper formatting
- [ ] Code blocks have syntax highlighting
- [ ] Light and dark themes work correctly
- [ ] Copy button appears on code block hover
- [ ] Copy button successfully copies code to clipboard
- [ ] Language label shows for code blocks
- [ ] Inline code has distinct styling
- [ ] Links open in external browser
- [ ] No XSS vulnerabilities (sanitized output)
- [ ] Theme changes update code highlighting
- [ ] Headings, lists, blockquotes render correctly
- [ ] Performance is acceptable (no lag when rendering)

## Testing Checklist

- [ ] Test all markdown syntax types
- [ ] Test code blocks with various languages
- [ ] Test switching between light and dark mode
- [ ] Test copy functionality
- [ ] Test external link opening
- [ ] Test very long code blocks (scrolling)
- [ ] Test malformed markdown
- [ ] Test HTML in markdown (should be escaped)

## Notes

- Shiki loads language grammars asynchronously, so first render may be slower
- Consider caching rendered markdown if re-rendering same content
- For MVP, don't implement line numbers or advanced code block features
- Keep the language list limited to common ones to reduce bundle size

## Future Enhancements (Post-MVP)

- Line numbers in code blocks
- Code block diff highlighting
- Collapsible long code blocks
- Search within code blocks
- More language support
- Custom syntax themes
- LaTeX/Math rendering
- Mermaid diagram support
