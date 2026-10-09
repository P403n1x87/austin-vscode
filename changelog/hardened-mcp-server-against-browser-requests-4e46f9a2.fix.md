Hardened the MCP server against requests from web pages by rejecting requests
with an unexpected `Host` header or a non-localhost browser `Origin`.
