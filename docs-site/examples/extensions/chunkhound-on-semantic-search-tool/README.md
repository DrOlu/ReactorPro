# ChunkHound Search Extension

This extension overrides AiderDesk's built-in `power---semantic_search` tool to use [ChunkHound](https://chunkhound.github.io/) for semantic code search.

## Features

- **Better Semantic Understanding**: ChunkHound uses advanced embeddings to understand code semantics
- **Multi-hop BFS Traversal**: Explores connected code components through semantic relationships
- **29+ Languages**: Supports Python, JavaScript, TypeScript, Go, Rust, Java, C++, and more
- **Auto-Indexing**: Starts indexing when a project is opened (background)
- **Lazy Indexing**: Indexes on first search if not already indexed
- **Auto-Reindexing**: Reindexes when files are modified before next search
- **Abort Support**: Properly handles interrupted operations (SIGTERM)
- **Concurrent Safety**: Waits for existing index processes instead of duplicating

## Installation

### 1. Install uv (if you don't have it)

**macOS and Linux:**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows:**
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### 2. Install ChunkHound

```bash
uv tool install chunkhound
```

### 3. Install the Extension

Copy this folder to your AiderDesk global extensions directory:

```bash
cp -r . ~/.aider-desk/extensions/chunkhound
```

### 4. Configure Embedding Provider

Create a `.chunkhound.json` file in the **extension folder** (`~/.aider-desk/extensions/chunkhound/`):

**VoyageAI (Recommended - fastest, most accurate, cost-effective):**
```json
{
  "embedding": {
    "provider": "voyageai",
    "api_key": "pa-your-voyage-key"
  }
}
```
Get an API key from [VoyageAI Console](https://dash.voyageai.com/)

**OpenAI:**
```json
{
  "embedding": {
    "provider": "openai",
    "api_key": "sk-your-openai-key"
  }
}
```
Get an API key from [OpenAI Platform](https://platform.openai.com/api-keys)

**Ollama (Local/Offline - best for privacy):**
```json
{
  "embedding": {
    "provider": "openai",
    "base_url": "http://localhost:11434/v1",
    "model": "dengcao/Qwen3-Embedding-8B:Q5_K_M",
    "api_key": "dummy-key"
  }
}
```

For Ollama, you'll need to:
```bash
# Install and start Ollama
ollama pull dengcao/Qwen3-Embedding-8B:Q5_K_M
ollama serve
```

## Usage

Once installed, the extension automatically intercepts all `power---semantic_search` tool calls and routes them through ChunkHound.

Your AI assistant can now search your codebase using natural language queries:

- "Find authentication functions"
- "Search for database models and their relationships"
- "How is rate limiting implemented?"

## Configuration Options

The extension supports the same parameters as the built-in semantic search:

- `query` - Search query (required)
- `maxTokens` - Maximum tokens to return (default: 5000)

## How It Works

1. **Project Open**: Starts background indexing when a project is opened
2. **First Search**: If index doesn't exist, waits for indexing to complete (or starts it)
3. **Subsequent Searches**: Uses existing index for fast results
4. **File Modifications**: Detects when files are edited/written and marks project for reindexing
5. **Next Search**: Reindexes automatically before searching to include latest changes
6. **Concurrent Safety**: If indexing is already running, waits for it instead of starting a new one

## Troubleshooting

### "ChunkHound is not installed"

Make sure ChunkHound is installed and in your PATH:
```bash
chunkhound --version
```

### "ChunkHound config not found"

Make sure `.chunkhound.json` exists in the extension folder:
```bash
ls ~/.aider-desk/extensions/chunkhound/.chunkhound.json
```

### Indexing Issues

- Check your `.chunkhound.json` configuration
- Ensure your API key is valid
- For Ollama, make sure the server is running

### Performance Tips

- ChunkHound respects `.gitignore` files
- Re-running `chunkhound index` only processes changed files
- The database is stored in `.chunkhound.db` in your project root
- Add `.chunkhound.db` to your `.gitignore`

## Files

- `index.ts` - Extension source code
- `.chunkhound.json` - Your embedding provider config (create this)
- `README.md` - This file

## Resources

- [ChunkHound Documentation](https://chunkhound.github.io/)
- [ChunkHound GitHub](https://github.com/chunkhound/chunkhound)
- [Discord Community](https://discord.gg/BAepHEXXnX)
