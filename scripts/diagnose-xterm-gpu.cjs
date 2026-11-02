"use strict";

// Run with Electron on the affected Windows machine. JSONL contains allocation
// counters and process metrics, never terminal contents.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const recording = option("recording");
const renderer = option("renderer", "webgl");
const angle = option("angle");
const intervalMs = Number(option("interval-ms", "1000"));
const settleMs = Number(option("settle-ms", "120000"));
const rounds = Number(option("rounds", "3"));
if (!recording || !["dom", "webgl"].includes(renderer) ||
    !Number.isFinite(intervalMs) || intervalMs < 0 ||
    !Number.isFinite(settleMs) || settleMs < 0 ||
    !Number.isInteger(rounds) || rounds < 1) {
  throw new Error("Usage: electron scripts/diagnose-xterm-gpu.cjs --recording <PTY log> [--renderer dom|webgl] [--angle d3d11|gl|swiftshader] [--rounds 3] [--interval-ms 1000] [--settle-ms 120000]");
}
if (angle) app.commandLine.appendSwitch("use-angle", angle);
if (angle === "swiftshader") app.commandLine.appendSwitch("enable-unsafe-swiftshader");
const output = value => console.log(JSON.stringify(value));
let timer;
let window;
let phase = "startup";

void app.whenReady().then(async () => {
  const text = fs.readFileSync(recording, "utf8");
  const columns = Number(/COLUMNS="(\d+)"/.exec(text)?.[1] || 172);
  const rows = Number(/LINES="(\d+)"/.exec(text)?.[1] || 45);
  // These script recordings have a moving clock on row 1. Keep every byte of
  // terminal output, including alternate-screen entry/exit, in its original order.
  const body = text.replace(/^Script started[^\n]*\n/, "").replace(/\nScript done[^\n]*\n?$/, "");
  const frames = body.split(/(?=\x1b\[1;\d+H)/);
  const css = fs.readFileSync(path.resolve(path.dirname(require.resolve("@xterm/xterm")), "../css/xterm.css"), "utf8");
  output({ event: "environment", platform: process.platform, versions: process.versions,
    renderer, angle: angle || "default", columns, rows, frames: frames.length,
    gpu: app.getGPUFeatureStatus(), rounds, intervalMs, settleMs });
  window = new BrowserWindow({ width: 1600, height: 1000, show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    `<style>${css}\nbody{margin:0;background:black}</style><div id='terminal'></div>`));
  const sample = () => output({ event: "processes", at: Date.now(), phase,
    processes: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory })) });
  sample();
  timer = setInterval(sample, 1000);
  window.webContents.on("console-message", (event) => {
    if (event.message?.startsWith("GPU_DIAG ")) {
      output(JSON.parse(event.message.slice(9)));
    }
  });
  phase = "replay";
  await window.webContents.executeJavaScript(`(async () => {
    const { Terminal } = require(${JSON.stringify(require.resolve("@xterm/xterm"))});
    const { WebglAddon } = require(${JSON.stringify(require.resolve("@xterm/addon-webgl"))});
    const terminal = new Terminal({ cols: ${columns}, rows: ${rows}, cursorBlink: true });
    terminal.open(document.getElementById('terminal'));
    let addon;
    const counts = {};
    if (${JSON.stringify(renderer)} === 'webgl') {
      addon = new WebglAddon();
      terminal.loadAddon(addon);
      const gl = addon._renderer._gl;
      counts.backend = gl.getParameter(gl.RENDERER);
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (debug) counts.device = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
      for (const name of ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D',
        'createTexture', 'deleteTexture', 'createBuffer', 'deleteBuffer', 'drawElementsInstanced']) {
        const original = gl[name].bind(gl);
        gl[name] = (...args) => {
          counts[name] = (counts[name] || 0) + 1;
          if (name === 'bufferData') counts.bufferUploadBytes =
            (counts.bufferUploadBytes || 0) + (typeof args[1] === 'number' ? args[1] : args[1]?.byteLength || 0);
          return original(...args);
        };
      }
    }
    console.log('GPU_DIAG ' + JSON.stringify({ event: 'renderer', devicePixelRatio,
      fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize,
      dimensions: addon?._renderer?.dimensions }));
    const frames = ${JSON.stringify(frames)};
    for (let round = 0; round < ${rounds}; round++) {
      for (let frame = 0; frame < frames.length; frame++) {
        await new Promise(resolve => terminal.write(frames[frame], resolve));
        await new Promise(resolve => setTimeout(resolve, ${intervalMs}));
        const atlas = addon?._renderer?._charAtlas;
        console.log('GPU_DIAG ' + JSON.stringify({ event: 'allocations', round, frame, counts,
          atlasPages: atlas?.pages.map(page => ({ width: page.canvas.width, height: page.canvas.height })) }));
      }
    }
    const gl = addon?._renderer?._gl;
    terminal.dispose();
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log('GPU_DIAG ' + JSON.stringify({ event: 'disposed', contextLost: gl?.isContextLost(), counts }));
  })()`);
  phase = "disposed";
  sample();
  await new Promise(resolve => setTimeout(resolve, settleMs));
  sample();
  clearInterval(timer);
  app.exit(0);
}).catch(error => {
  clearInterval(timer);
  console.error(error);
  app.exit(1);
});
