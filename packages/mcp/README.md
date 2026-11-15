# ssc-mcp — Utir MCP Server

An MCP stdio server that lets AI agents (Claude, Cursor, etc.) deploy and manage apps on [Utir](https://app.utir.dev).

## Install

```sh
npm install -g @utir/ssc-mcp
```

## Tools

| Tool | Description |
|---|---|
| `deploy_app` | Deploy a local directory or GitHub URL; streams logs until done |
| `delete_app` | Permanently delete an app (requires exact name confirmation) |
| `get_deployment_status` | Poll the status of a deployment by ID |

## Configuration (Claude Code example)

```json
{
  "mcpServers": {
    "ssc": {
      "command": "ssc-mcp",
      "env": {
        "SSC_API_KEY": "ssc_...",
        "SSC_API_URL": "https://api.utir.dev"
      }
    }
  }
}
```

## License

UNLICENSED — proprietary software.
