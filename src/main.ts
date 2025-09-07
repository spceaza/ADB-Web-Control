import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import type { ReadableStream as YReadable } from "@yume-chan/stream-extra"; // TS typing bridge

const pick = document.getElementById("pick") as HTMLInputElement;
const btnPush = document.getElementById("push") as HTMLButtonElement;
const bar = document.getElementById("bar") as HTMLProgressElement;

const cmdInput   = document.getElementById("cmd") as HTMLInputElement;
const btnRunCmd  = document.getElementById("runCmd") as HTMLButtonElement;
const btnStopCmd = document.getElementById("stopCmd") as HTMLButtonElement;

let cmdProc: any = null; // current running process (if any)
let cmdReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

const logEl = document.getElementById("log") as HTMLPreElement;
const btnConnect = document.getElementById("connect") as HTMLButtonElement;
const btnDisconnect = document.getElementById("disconnect") as HTMLButtonElement;
const btnGammaray = document.getElementById("gammaray") as HTMLButtonElement;
const btnUSB = document.getElementById("usbdialog") as HTMLButtonElement;
const btnReboot = document.getElementById("reboot") as HTMLButtonElement;
const btnStartLogs = document.getElementById("startLogs") as HTMLButtonElement;
const btnStopLogs = document.getElementById("stopLogs") as HTMLButtonElement;

const Manager = AdbDaemonWebUsbDeviceManager.BROWSER;

let adb: Adb | null = null;
let transport: AdbDaemonTransport | null = null;
let currentLogProc: Awaited<ReturnType<Adb["subprocess"]["shell"]>> | null = null;
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let currentKill: (() => Promise<void> | void) | null = null;
const decoder = new TextDecoder();

let logProc: any = null;
let readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

const fsRefresh = document.getElementById("fsRefresh") as HTMLButtonElement;
const fsUp      = document.getElementById("fsUp") as HTMLButtonElement;
const fsGo      = document.getElementById("fsGo") as HTMLButtonElement;
const fsPath    = document.getElementById("fsPath") as HTMLInputElement;
const fsList    = document.getElementById("fsList") as HTMLUListElement;

function log(line: string) {
  logEl.textContent += line + "\n";
  // keep the last ~2000 lines to prevent unbounded memory growth
  if (logEl.textContent.length > 2_000_000) {
    logEl.textContent = logEl.textContent.slice(-1_000_000);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setConnectedUI(connected: boolean) {
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
  btnGammaray.disabled = !connected;
  btnUSB.disabled = !connected;
  btnReboot.disabled = !connected;
  btnStartLogs.disabled = !connected;
  btnPush.disabled = !connected;
  btnStopLogs.disabled = !connected || currentLogProc === null;
  btnRunCmd.disabled  = !connected;
  btnStopCmd.disabled = !connected || cmdProc === null;

  // FS explorer controls
  fsRefresh.disabled = !connected;
  fsUp.disabled = !connected;
  fsGo.disabled = !connected;
  fsPath.disabled = !connected;
}

async function connect() {
  if (!Manager) {
    log("❌ WebUSB not available. Use Chrome/Edge and https:// or http://localhost");
    return;
  }

  try {
    log("🔌 Requesting device…");
    const device = await Manager.requestDevice();
    if (!device) {
      log("Canceled.");
      return;
    }

    log("🔗 Claiming ADB interface…");
    const connection = await device.connect(); // throws if busy / in use

    log("🔐 Authenticating (check your phone for the RSA dialog) …");
    transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: new AdbWebCredentialStore("WebADB Demo Key"),
    });

    adb = new Adb(transport);
    log("✅ Connected!");
    setConnectedUI(true);
    await navigateTo("/"); // or "/mnt/onboard"
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/busy|in use/i.test(msg)) {
      log("⚠️ The phone’s ADB interface is already in use by another program. Close Android Studio/scrcpy/etc. and run `adb kill-server`, then try again.");
    } else {
      log("❌ " + msg);
    }
    await disconnect(); // ensure clean state
  }
}

async function disconnect() {
  await stopLogs(); // stop any running logread
  if (transport) {
    try { await transport.close(); } catch {}
  }
  transport = null;
  adb = null;
  setConnectedUI(false);
  log("🔌 Disconnected.");
  fsList.innerHTML = "";
  fsPath.value = "/";
}

async function startGammaray() {
  if (!adb) return;
  log("▶️▶️starting gammaray");
  const proc = await adb.subprocess.noneProtocol.spawn("source /env.sh && /usr/bin/gammaray -p $(pidof nickel) --inject-only");
  const reader = proc.output.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const text = decoder.decode(value || new Uint8Array()).trim();
  log("📱 " + text);
}

async function showUsbDialog() {
  if (!adb) return;
  log("▶️▶️sow usb dialog");
  const proc = await adb.subprocess.noneProtocol.spawn("echo usb plug add > /tmp/nickel-hardware-status");
}

async function rebootDevice() {
  if (!adb) return;
  const proc = await adb.subprocess.noneProtocol.spawn("reboot");
}

async function startLogs() {
  if (!adb || logProc) return;

  try {
    // Prefer shell protocol when available (separate stdout/stderr),
    // otherwise fall back to the universal none protocol.
    if (adb.subprocess.shellProtocol) {
      log("🟢 logread via shellProtocol");
      logProc = await adb.subprocess.shellProtocol.spawn(["logread", "-f"]);

      const dec = new TextDecoder();
      const r1 = logProc.stdout.getReader();
      const r2 = logProc.stderr.getReader();
      readers = [r1, r2];

      (async () => {
        try {
          while (true) {
            const [{ value: v1, done: d1 }, { value: v2, done: d2 }] = await Promise.all([
              r1.read(),
              r2.read(),
            ]);
            if (d1 && d2) break;
            if (v1?.length) log(dec.decode(v1, { stream: true }));
            if (v2?.length) log(dec.decode(v2, { stream: true }));
          }
        } catch (e) {
          log("❌ read error: " + e.message);
        } finally {
          try { r1.releaseLock(); } catch {}
          try { r2.releaseLock(); } catch {}
          readers = [];
          logProc = null;
          btnStopLogs.disabled = true;
          log("🛑 logread ended.");
        }
      })();
    } else {
      log("🟢 logread via noneProtocol (legacy)");
      logProc = await adb.subprocess.noneProtocol.spawn(["logread", "-f"]);
      const r = logProc.output.getReader();
      readers = [r];
      const dec = new TextDecoder();

      (async () => {
        try {
          while (true) {
            const { value, done } = await r.read();
            if (done) break;
            if (value?.length) log(dec.decode(value, { stream: true }));
          }
        } catch (e) {
          log("❌ read error: " + e.message);
        } finally {
          try { r.releaseLock(); } catch {}
          readers = [];
          logProc = null;
          btnStopLogs.disabled = true;
          log("🛑 logread ended.");
        }
      })();
    }

    btnStopLogs.disabled = false;
  } catch (e: any) {
    log("❌ could not start logread: " + e.message);
    console.error(e);
  }
}

async function stopLogs() {
  if (!logProc) return;
  log("🟡 Stopping logread…");
  try { await logProc.kill?.(); } catch {}
  for (const r of readers) {
    try { await r.cancel(); } catch {}
  }
  readers = [];
  logProc = null;
  btnStopLogs.disabled = true;
}

btnPush.addEventListener("click", async () => {
  if (!adb) return;
  const f = pick.files?.[0];
  if (!f) { log("Pick a file first"); return; }

  // 1) Open a sync connection
  const sync = await adb.sync();                           // create Sync session (one command at a time)

  try {
    // 2) (optional) wrap the stream to show progress
    const total = f.size;
    let sent = 0;
    const progStream = f.stream().pipeThrough(new TransformStream<Uint8Array>({
      transform(chunk, ctl) {
        sent += chunk.byteLength;
        bar.value = total ? sent / total : 0;
        ctl.enqueue(chunk);
      }
    })) as unknown as YReadable<Uint8Array>;               // cast because DOM ReadableStream type differs

    // 3) Push to public storage (works on non-rooted devices)
    const dest = `/mnt/onboard/.kobo/${f.name}`;
    log(`⬆️ Pushing to ${dest} …`);
    await sync.write({
      filename: dest,
      file: progStream,            // you could also pass f.stream() without progress
      // permission: 0o644,        // default 0644; set explicitly if you want
    });

    log("✅ Push complete");
  } catch (e:any) {
    log("❌ Push failed: " + (e?.message ?? e));
  } finally {
    await sync.dispose();                                     // close sync socket when done
    bar.value = 0;
  }
});

async function runCustom() {
  if (!adb || cmdProc) return;

  const cmd = cmdInput.value.trim();
  if (!cmd) { log("Type a command first"); return; }

  log("▶️ " + cmd);
  btnStopCmd.disabled = false;

  try {
    // Use a real shell so users can type full commands with pipes, quotes, etc.
    const sh = ["sh", "-c", "\"" + cmd + "\""];

    if (adb.subprocess.shellProtocol) {
      // Preferred on Android 7+; has separate stdout/stderr
      cmdProc = await adb.subprocess.shellProtocol.spawn(sh);

      const rOut = cmdProc.stdout.getReader();
      const rErr = cmdProc.stderr.getReader();
      cmdReaders = [rOut, rErr];
      const dec = new TextDecoder();

      (async () => {
        try {
          while (true) {
            const [o, e] = await Promise.all([rOut.read(), rErr.read()]);
            if (o.done && e.done) break;
            if (o.value?.length) log(dec.decode(o.value, { stream: true }));
            if (e.value?.length) log(dec.decode(e.value, { stream: true }));
          }
        } catch (err) {
          log("❌ read error: " + err.message);
        } finally {
          try { rOut.releaseLock(); } catch {}
          try { rErr.releaseLock(); } catch {}
          cmdReaders = [];
          cmdProc = null;
          btnStopCmd.disabled = true;
          log("⏹️ command ended");
        }
      })();

    } else {
      // Fallback that works on all devices
      cmdProc = await adb.subprocess.noneProtocol.spawn(sh);
      const r = cmdProc.output.getReader();
      cmdReaders = [r];
      const dec = new TextDecoder();

      (async () => {
        try {
          while (true) {
            const { value, done } = await r.read();
            if (done) break;
            if (value?.length) log(dec.decode(value, { stream: true }));
          }
        } catch (err) {
          log("❌ read error: " + err.message);
        } finally {
          try { r.releaseLock(); } catch {}
          cmdReaders = [];
          cmdProc = null;
          btnStopCmd.disabled = true;
          log("⏹️ command ended");
        }
      })();
    }
  } catch (e: any) {
    log("❌ could not start command: " + e.message);
    console.error(e);
    // clean up UI state
    cmdProc = null;
    for (const r of cmdReaders) { try { await r.cancel(); } catch {} }
    cmdReaders = [];
    btnStopCmd.disabled = true;
  }
}

async function stopCustom() {
  if (!cmdProc) return;
  log("🛑 Stopping command…");
  try { await cmdProc.kill?.(); } catch {}
  for (const r of cmdReaders) { try { await r.cancel(); } catch {} }
  cmdReaders = [];
  cmdProc = null;
  btnStopCmd.disabled = true;
}

function joinPath(a: string, b: string) {
  if (!a) return b || "/";
  if (a.endsWith("/")) a = a.slice(0, -1);
  return (a || "/") + "/" + (b || "");
}

function dirname(p: string) {
  if (p === "/") return "/";
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  const d = parts.join("/");
  return d.length ? d : "/";
}

function basename(p: string) {
  return p.replace(/\/+$/, "").split("/").pop() || "/";
}

type FsEntry = {
  name: string;
  mode: number;  // POSIX mode; dir if S_IFDIR
  size: number;
  mtime: number;
  path: string;  // full path convenience
};

function isDir(mode: number) {
  // 0o040000 is S_IFDIR in adb sync results
  return (mode & 0o170000) === 0o040000;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB","MB","GB","TB"];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}

function fmtTime(sec: number) {
  try { return new Date(sec * 1000).toLocaleString(); } catch { return String(sec); }
}

async function listDir(path: string): Promise<FsEntry[]> {
  if (!adb) return [];
  const sync = await adb.sync();

  const entries: FsEntry[] = [];
  try {
    // Option A: stream entries as they arrive (best UX on huge dirs)
    for await (const e of sync.opendir(path)) {
      entries.push({
        name: e.name,
        mode: Number(e.mode),
        size: Number(e.size),          // e.size is bigint
        mtime: Number(e.mtime),        // e.mtime is bigint
        path: joinPath(path, e.name),
      });
    }

    // Option B (simpler): collect all at once
    // const raw = await sync.readdir(path);
    // for (const e of raw) { entries.push({ ...same mapping... }); }

  } catch (err: any) {
    log(`❌ list failed for ${path}: ${err?.message || err}`);
  } finally {
    await sync.dispose();
  }

  // Sort: folders first, then files
  entries.sort((a, b) => {
    const da = isDir(a.mode), db = isDir(b.mode);
    if (da !== db) return da ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

function renderEntries(path: string, entries: FsEntry[]) {
  fsList.innerHTML = "";
  fsPath.value = path;

  for (const e of entries) {
    const li = document.createElement("li");
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.justifyContent = "space-between";
    li.style.padding = "6px 8px";
    li.style.borderBottom = "1px dashed #ccc";
    li.style.cursor = "default";

    const left = document.createElement("div");
    const right = document.createElement("div");

    const kind = isDir(e.mode) ? "📁" : "📄";
    const name = document.createElement("span");
    name.textContent = `${kind} ${e.name}`;
    name.style.userSelect = "text";
    name.style.fontWeight = isDir(e.mode) ? "600" : "400";

    // Double-click folder to enter
    if (isDir(e.mode)) {
      name.style.cursor = "pointer";
      name.ondblclick = async () => {
        await navigateTo(e.path);
      };
      // Single click also acceptable if you prefer:
      // name.onclick = () => navigateTo(e.path);
    } else {
      // For files: single click shows actions
      name.onclick = () => {
        details.hidden = !details.hidden;
      };
    }

    left.appendChild(name);

    const meta = document.createElement("span");
    meta.textContent = isDir(e.mode) ? "" : `${fmtBytes(e.size)} • ${fmtTime(e.mtime)}`;
    meta.style.opacity = "0.7";
    meta.style.fontSize = "12px";
    meta.style.marginLeft = "8px";
    left.appendChild(meta);

    // Actions (files only)
    const details = document.createElement("div");
    details.hidden = true;

    if (!isDir(e.mode)) {
      const btnHead = document.createElement("button");
      btnHead.textContent = "View (head)";
      btnHead.onclick = () => previewHead(e.path);

      const btnDl = document.createElement("button");
      btnDl.textContent = "Download";
      btnDl.onclick = () => downloadFile(e.path, e.name);

      details.appendChild(btnHead);
      details.appendChild(btnDl);
    }

    right.appendChild(details);

    li.appendChild(left);
    li.appendChild(right);
    fsList.appendChild(li);
  }
}

async function navigateTo(path: string) {
  const list = await listDir(path);
  renderEntries(path, list);
}

async function previewHead(fullPath: string, bytes = 4096) {
  if (!adb) return;
  const sync = await adb.sync();
  try {
    log(`👀 Reading head of ${fullPath} …`);
    const stream = await sync.read(fullPath);
    const reader = stream.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (received < bytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const need = Math.max(0, bytes - received);
      chunks.push(value.subarray(0, need));
      received += Math.min(value.byteLength, need);
      if (received >= bytes) break;
    }
    try { reader.releaseLock(); } catch {}
    const merged = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    const text = new TextDecoder().decode(merged);
    log(`----- BEGIN ${fullPath} (first ${received} bytes) -----\n` + text + `\n----- END ${basename(fullPath)} -----`);
  } catch (e:any) {
    log("❌ preview failed: " + (e?.message ?? e));
  } finally {
    await sync.dispose();
  }
}

async function downloadFile(fullPath: string, filename: string) {
  if (!adb) return;
  const sync = await adb.sync();
  try {
    log(`⬇️ Downloading ${fullPath} …`);
    const rs = await sync.read(fullPath);
    const r = rs.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      if (value?.length) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    try { r.releaseLock(); } catch {}

    const blob = new Blob(chunks, { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || basename(fullPath);
    a.click();
    URL.revokeObjectURL(url);
    log(`✅ Downloaded ${filename} (${fmtBytes(total)})`);
  } catch (e:any) {
    log("❌ download failed: " + (e?.message ?? e));
  } finally {
    await sync.dispose();
  }
}

btnConnect.addEventListener("click", () => connect());
btnDisconnect.addEventListener("click", () => disconnect());
btnGammaray.addEventListener("click", () => startGammaray());
btnUSB.addEventListener("click", () => showUsbDialog());
btnReboot.addEventListener("click", () => rebootDevice());
btnStartLogs.addEventListener("click", () => startLogs());
btnStopLogs.addEventListener("click", () => stopLogs());
btnRunCmd.addEventListener("click", () => runCustom());
btnStopCmd.addEventListener("click", () => stopCustom());
fsRefresh.addEventListener("click", () => navigateTo(fsPath.value || "/"));
fsUp.addEventListener("click",    () => navigateTo(dirname(fsPath.value || "/")));
fsGo.addEventListener("click",    () => navigateTo(fsPath.value || "/"));

setConnectedUI(false);
