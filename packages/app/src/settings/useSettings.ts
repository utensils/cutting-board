import { useCallback, useEffect, useState } from "react";
import { getSettings, setSettings as persistSettings, type Settings } from "../lib/ipc";

export const DEFAULT_SETTINGS: Settings = {
  hotkey: "CmdOrCtrl+Shift+Space",
  autoHideOnBlur: false,
  exportScale: 2,
};

/** Load settings from Rust and expose an updater that persists + re-applies them. */
export function useSettings() {
  const [settings, setLocal] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void getSettings()
      .then((s) => {
        if (active) setLocal(s);
      })
      .catch((err) => console.error("[cutting-board] failed to load settings:", err))
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(async (next: Settings) => {
    const effective = await persistSettings(next);
    setLocal(effective);
    return effective;
  }, []);

  return { settings, loaded, update };
}
