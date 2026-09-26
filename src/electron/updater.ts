/**
 * Self-update from GitHub Releases.
 *
 * electron-updater reads `latest.yml` from the newest release (the publish
 * target baked into app-update.yml at build time), downloads the NSIS
 * installer in the background and verifies its sha512 before offering it.
 * The repository is public, so no token is involved on the client.
 *
 * Only a packaged, installed build updates itself: a dev run has no
 * app-update.yml and nothing to replace.
 */

import { Notification } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/** Often enough that a fix lands the same day, rare enough to be free. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "current" }
  | { readonly kind: "downloading"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };

let status: UpdateStatus = { kind: "idle" };

export function updateStatus(): UpdateStatus {
  return status;
}

export function checkForUpdates(): void {
  if (status.kind === "checking" || status.kind === "downloading" || status.kind === "ready") return;
  // Failures arrive through the "error" event; the rejected promise carries
  // the same error, so swallowing it here loses nothing.
  autoUpdater.checkForUpdates().catch(() => {});
}

/**
 * Installs a downloaded update and exits. Returns false when there is none,
 * so the caller falls back to a plain exit.
 *
 * The tray's Quit uses `app.exit`, which skips the quit events that
 * electron-updater's install-on-quit listens for -- so installation has to be
 * triggered explicitly rather than left to `autoInstallOnAppQuit`.
 */
export function installAndExit(relaunch: boolean): boolean {
  if (status.kind !== "ready") return false;
  autoUpdater.quitAndInstall(true, relaunch);
  return true;
}

export function startUpdater(onChange: (status: UpdateStatus) => void): void {
  const set = (next: UpdateStatus): void => {
    status = next;
    onChange(next);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.on("checking-for-update", () => set({ kind: "checking" }));
  autoUpdater.on("update-not-available", () => set({ kind: "current" }));
  autoUpdater.on("update-available", (info) => set({ kind: "downloading", version: info.version }));
  autoUpdater.on("update-downloaded", (info) => {
    set({ kind: "ready", version: info.version });
    if (Notification.isSupported()) {
      new Notification({
        title: `quotadeck ${info.version} is ready`,
        body: "It installs when you quit, or pick \"Restart to update\" from the tray menu.",
      }).show();
    }
  });
  autoUpdater.on("error", (err) => set({ kind: "error", message: err instanceof Error ? err.message : String(err) }));

  checkForUpdates();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}
