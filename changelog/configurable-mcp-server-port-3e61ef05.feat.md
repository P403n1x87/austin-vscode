Added the `austin.mcp.port` setting to run the MCP server on a fixed port, so
that a `.mcp.json` file can be shared with a team, e.g. by committing it to the
repository. When a fixed port is set, the extension no longer rewrites
`.mcp.json` on startup. If the port is already in use, e.g. by another VS Code
window, a random port is used instead and a warning is shown.
