import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const input = resolve(process.argv[2] ?? "design-prototypes/quotadeck-compact.html");
const output = resolve(process.argv[3] ?? "design-prototypes/quotadeck-compact.png");

async function capture() {
  const window = new BrowserWindow({
    width: 380,
    height: 632,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: "#0b0f14",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await window.loadFile(input);
  await new Promise((resolveReady) => setTimeout(resolveReady, 250));

  await mkdir(dirname(output), { recursive: true });
  const extension = extname(output);
  const stem = output.slice(0, -extension.length);
  const views = [
    { tab: "tab-quotas", path: output },
    { tab: "tab-activity", path: `${stem}-activity${extension}` },
    { tab: "tab-health", path: `${stem}-health${extension}` },
  ];

  for (const view of views) {
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(view.tab)}).click()`);
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
    const image = await window.webContents.capturePage();
    await writeFile(view.path, image.toPNG());
    console.log(`prototype screenshot -> ${view.path} (${image.getSize().width}x${image.getSize().height})`);
  }

  window.destroy();
  app.exit(0);
}

app.whenReady().then(capture).catch((error) => {
  console.error(error);
  app.exit(1);
});
