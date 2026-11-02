# Windows terminal GPU memory investigation (#4063)

The fork branch `fix/4063-release-webgl-context` backports xterm.js #6069
to release a terminal's GL context on disposal. This fixes a verified lifecycle
defect. It does not yet establish or fix the cause of multi-GB GPU process growth
while the terminal is open on Windows. The upstream draft PR is closed.

## Capture the stream Netcatty receives

The issue attachments contain `watch` output. If `script` ran inside zellij,
they capture the inner application, before zellij renders its outer terminal.
For that case, record outside zellij so replay includes its actual output:

```sh
script -q -c 'zellij attach <session-name>' netcatty-zellij-outer.log
```

Navigate to the affected `watch -n 1 nvidia-smi -i 1` pane and reproduce the
memory growth. Detach zellij, then exit the recording if necessary. Recording
includes terminal contents; review it for secrets before sharing. Keep the
original file for local replay so escape sequences remain intact.

## Replay on the affected Windows machine

In a checkout of the fork branch, install dependencies with `npm ci`. Download
the recording locally. In PowerShell, run the following experiments separately:

```powershell
npx electron scripts/diagnose-xterm-gpu.cjs --recording .\netcatty-zellij-outer.log > gpu-webgl.jsonl
npx electron scripts/diagnose-xterm-gpu.cjs --recording .\netcatty-zellij-outer.log --renderer dom > gpu-dom.jsonl
npx electron scripts/diagnose-xterm-gpu.cjs --recording .\netcatty-zellij-outer.log --angle gl > gpu-angle-gl.jsonl
```

The default WebGL experiment preserves Electron's default ANGLE backend.
The optional `--angle gl` experiment selects another backend; startup may fail
on systems without support. It does not change Netcatty's saved settings.
Each run opens a minimal xterm window, replays three rounds, disposes the
terminal, and observes the same Electron process for another 120 seconds.
Watch Task Manager too. If only the full Netcatty app reproduces the problem,
that is useful evidence that the minimal renderer is insufficient.

The JSONL records process PIDs/memory in KiB, actual GL backend/device,
atlas page dimensions, buffer/texture call counts, cumulative buffer upload
bytes, and whether disposal loses the context. It does not include recorded
terminal text. GL counters begin after addon construction; creation counts
therefore exclude initial resources. Upload bytes are cumulative traffic, not
live allocation size. GPU process memory also includes Chromium resources
outside the measured WebGL calls.

Replay uses one second between row-1 cursor updates, not original timestamps:
plain `script` recordings do not contain per-write timing. Options
`--interval-ms`, `--rounds`, and `--settle-ms` support shorter smoke tests or
longer observation. This is a diagnostic, not an assertion of reproduction.

## Verification so far

- Real Electron 42.11.12 on Linux SwiftShader: before the backport, disposal
  leaves the GL context live. After the backport, 20 disposals across CommonJS
  and ESM builds each call `loseContext()` once and leave a lost context.
- The attached `nvidia-smi-tty-balloon.log` replayed three times in that
  environment keeps a single 512x512 atlas page (1 MiB RGBA). This does not
  reproduce the Windows hardware failure or exclude another GPU allocation.
- Windows hardware validation and a stream known to reproduce the reported
  multi-GB growth remain outstanding. Do not mark #4063 fixed on this evidence.
