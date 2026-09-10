# Security

`@inssist/mcp` is a local bridge: it binds `127.0.0.1` only, accepts WebSocket connections
solely from `chrome-extension://` origins, holds no Instagram credentials, and forwards every
tool call to the INSSIST extension running in the user's own browser. Nothing leaves the
machine except the Instagram traffic the browser already makes.

The threat model accepts that any process running as the same OS user can drive the bridge
while the user's **AI Agents** toggle is on; such a process already owns the browser session.

## Reporting a vulnerability

Email **inssist@slashed.io** with the details and, if you have one, a reproduction. You will
get a human reply within 5 business days. Please do not open a public report before we have
had a chance to ship a fix; we credit reporters in the changelog unless asked not to.

Supported version: the latest release on npm.
