/**
 * Every identity string, port and timeout the bridge depends on lives here, so a rename or a
 * port move is one diff.
 *
 * The INSSIST extension holds a mirror of `BRIDGE_PORT` and `PROTOCOL_VERSION`
 * (`inssist-ext/imports/mcp/mcp-protocol.ts`). Change one, change the other.
 */

export const PACKAGE_NAME = '@inssist/mcp'

/** Name reported to the MCP client, shown next to the tools in the harness. */
export const MCP_SERVER_NAME = 'inssist'

/**
 * Loopback port the extension dials. 48231 sits in the unassigned range below the
 * ephemeral window (49152+), so no service claims it and the OS will not hand it out
 * to a random outbound socket. Override with `INSSIST_MCP_PORT`.
 */
export const BRIDGE_PORT = 48231

export const BRIDGE_HOST = '127.0.0.1'

export const PORT_ENV = 'INSSIST_MCP_PORT'

/** Directory holding the pairing file. Override with `INSSIST_MCP_HOME`. */
export const HOME_ENV = 'INSSIST_MCP_HOME'

export const HOME_DIR_NAME = '.inssist'

export const PAIRINGS_FILE_NAME = 'mcp-pairings.json'

/** Bumped when the frame shapes below stop being backwards compatible. */
export const PROTOCOL_VERSION = 1

/**
 * Only a browser extension may open the bridge. A web page cannot forge `Origin`, so
 * this single check keeps `http://evil.example` off the socket even though the port is
 * reachable from any process on the machine.
 */
export const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://'

/**
 * Path a second `@inssist/mcp` process dials on the first one's port to join it as a peer
 * instead of exiting: every harness gets the same browsers through one hub. Peers carry no
 * `Origin` header (a web page always does), which is how the hub tells them apart.
 */
export const PEER_PATH = '/peer'

/** Delay before a peer that lost its hub, and could not take the port itself, dials again. */
export const PEER_RETRY_MS = 1_000

/** A tool call that has not answered by then is reported as a timeout, not left hanging. */
export const CALL_TIMEOUT_MS = 120_000

/**
 * App level keepalive. Doubles as an MV3 lifeline: WebSocket traffic resets the service
 * worker idle timer, so a ping well under 30s keeps the extension's background alive
 * while an agent is working.
 */
export const KEEPALIVE_MS = 20_000

/**
 * How long a tool call waits for a browser to connect before answering with the pairing
 * steps. Harnesses often fire the first call seconds after starting the server, while the
 * extension is still inside its reconnect backoff (up to `reconnectMaxMs`, 15s); answering
 * "not connected" in that window sends the user to flip a toggle that is already on.
 */
export const CONNECT_GRACE_MS = 15_000

/** How long an unauthenticated socket may stay open before it is dropped. */
export const HANDSHAKE_TIMEOUT_MS = 5 * 60_000
