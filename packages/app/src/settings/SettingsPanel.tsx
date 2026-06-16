import { useEffect, useState, type KeyboardEvent } from "react";
import type { Settings } from "../lib/ipc";
import { chordToAccelerator, isValidAccelerator } from "../lib/accelerator";

export interface SettingsPanelProps {
  settings: Settings;
  onClose: () => void;
  onSave: (settings: Settings) => Promise<void> | void;
}

/** In-window settings panel (opened from the tray "Settings…" item). */
export function SettingsPanel({ settings, onClose, onSave }: SettingsPanelProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const onHotkeyKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    const accelerator = chordToAccelerator({
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      code: e.nativeEvent.code,
      key: e.key,
    });
    if (accelerator) {
      setDraft((d) => ({ ...d, hotkey: accelerator }));
      setCapturing(false);
    }
  };

  const valid = isValidAccelerator(draft.hotkey);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cb-settings-backdrop" onMouseDown={onClose}>
      <div
        className="cb-settings"
        role="dialog"
        aria-label="Cutting Board settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Settings</h2>

        <label className="cb-field">
          <span>Global hotkey</span>
          <button
            type="button"
            className={`cb-hotkey${capturing ? " is-capturing" : ""}`}
            onClick={() => setCapturing(true)}
            onKeyDown={onHotkeyKeyDown}
          >
            {capturing ? "Press a shortcut…" : draft.hotkey}
          </button>
          {!valid && <small className="cb-error">Choose a key with at least one modifier.</small>}
        </label>

        <label className="cb-field cb-field--row">
          <input
            type="checkbox"
            checked={draft.autoHideOnBlur}
            onChange={(e) => setDraft((d) => ({ ...d, autoHideOnBlur: e.target.checked }))}
          />
          <span>Hide automatically when the window loses focus</span>
        </label>

        <label className="cb-field">
          <span>Export resolution: {draft.exportScale}×</span>
          <input
            type="range"
            min={1}
            max={3}
            step={1}
            value={draft.exportScale}
            onChange={(e) => setDraft((d) => ({ ...d, exportScale: Number(e.target.value) }))}
          />
        </label>

        <div className="cb-settings__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cb-primary" disabled={!valid || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
