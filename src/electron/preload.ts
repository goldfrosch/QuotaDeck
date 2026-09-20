/**
 * Context bridge. The renderer gets a narrow, typed surface and no Node access;
 * everything it receives is already secret-free (fingerprints, percentages).
 */

import { contextBridge, ipcRenderer } from "electron";
import type { DeckState } from "./state.ts";

export interface DeckApi {
  get(): Promise<DeckState>;
  refresh(): Promise<DeckState>;
  sync(): Promise<DeckState>;
  /** Custody dry run: reports what would change without writing anything. */
  check(): Promise<DeckState>;
  /** Whether the widget is currently held above other windows. */
  pinned(): Promise<boolean>;
  /** Returns the state actually applied, so the button never desyncs. */
  setPinned(value: boolean): Promise<boolean>;
  openStateDir(): Promise<void>;
  hide(): void;
  onUpdate(handler: (state: DeckState) => void): void;
}

const api: DeckApi = {
  get: () => ipcRenderer.invoke("deck:get") as Promise<DeckState>,
  refresh: () => ipcRenderer.invoke("deck:refresh") as Promise<DeckState>,
  sync: () => ipcRenderer.invoke("deck:sync") as Promise<DeckState>,
  check: () => ipcRenderer.invoke("deck:check") as Promise<DeckState>,
  pinned: () => ipcRenderer.invoke("deck:pin-get") as Promise<boolean>,
  setPinned: (value) => ipcRenderer.invoke("deck:pin-set", value) as Promise<boolean>,
  openStateDir: () => ipcRenderer.invoke("deck:open-state-dir") as Promise<void>,
  hide: () => ipcRenderer.send("deck:hide"),
  onUpdate: (handler) => {
    ipcRenderer.on("deck:update", (_event, state: DeckState) => handler(state));
  },
};

contextBridge.exposeInMainWorld("deck", api);
