import { createContext, useContext } from "react";

export interface BoardConfig {
  /** PNG export resolution multiplier from settings. */
  exportScale: number;
}

export const BoardConfigContext = createContext<BoardConfig>({ exportScale: 2 });

export const useBoardConfig = () => useContext(BoardConfigContext);
