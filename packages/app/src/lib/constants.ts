/** App version surfaced to the MCP `get_status` tool. Keep in sync with package.json. */
export const APP_VERSION = "0.1.0";

/** persistenceKey-less: we persist the board to a file via the Rust side. */
export const DEFAULT_STICKY_COLOR = "yellow" as const;
export const DEFAULT_SHAPE_COLOR = "black" as const;

/** Default geometry for programmatically created shapes (page units). */
export const DEFAULT_SHAPE_SIZE = { w: 160, h: 100 } as const;
export const DEFAULT_STICKY_SIZE = { w: 200, h: 200 } as const;
