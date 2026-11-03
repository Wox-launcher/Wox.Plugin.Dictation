# Dictation for Wox

TypeScript plugin with on-demand Node.js native bindings. No Go helper, native engine,
or speech model is included in the plugin package.

## Requirements

- Node.js **22+**, required by the pinned audio binding.
- Wox **2.5.0 or later**, with plugin windows and global hotkeys.
- Windows x64, macOS x64/arm64, or Linux x64/arm64. Windows is tested here; macOS/Linux
  native capture, permissions and desktop integration still need platform validation.

## Use

1. Install `wox.plugin.dictation.wox` in Wox.
2. Run `dictate model`, choose Qwen3-ASR 0.6B or SenseVoice-Small and download it.
3. Select a microphone in plugin settings; the system default is used otherwise.
4. Set a global shortcut in plugin settings to start an action.
   Hold shortcuts record until release; other shortcuts toggle recording. Click the waveform to stop or the close button to cancel. Recording has a five-minute limit.
5. A hotkey-initiated default action inserts into the original focused field when supported.
   If the focus changes or insertion is unavailable, the result is copied and a notification is shown. Multiline
   insertion on Windows uses the clipboard. On macOS, allow the helper in Privacy & Security → Accessibility.
   On Linux, insertion uses the clipboard, Python 3, X11 with `xprop` or Hyprland with
   `hyprctl`, and access to `/dev/uinput` and keyboard state under `/dev/input`.
   Hyprland can verify the window but not which field inside it has focus.
   Clipboard actions copy automatically; overlay actions display the result.

`dictate` shows dictation history; `dictate <search>` searches original and processed text, with Copy/Delete.
Enable AI refinement and select a provider/model in plugin settings. Custom actions use
`{wox:dictation_text}` and `{wox:selected_text}`; selected text is available in text
selection queries. Empty custom prompts pass the transcript through. A custom AI failure
preserves the raw transcript in history and reports the error. Default refinement failures
retain the transcript instead of losing the utterance.

When AI refinement is enabled, the Dictionary table in settings supplies preferred
spellings to the refiner. Opening input-device settings lists microphones after the
native runtime has been installed with a speech model.
Enable Pause media in settings to pause playing media during recording and resume it
when capture ends.

History holds 500 entries. Refinement context uses
ten entries from ten minutes, with topic-gap markers. Settings and history use Wox
persistence; downloads use `API.GetCacheFolder`. Microphone preferences are platform-specific.
Audio is not saved to disk or sent to a speech service. Optional AI refinement sends text,
recent context and dictionary phrases to the configured provider.

Start/stop sounds are optional. Capture uses the native device rate, mixes to mono,
resamples to 16 kHz, runs Silero VAD in 512-sample windows and decodes asynchronously.
A Node.js child isolates native failures from the plugin host. Cancelling a recording closes
the microphone and retains the model; cancelling model startup or recognition ends the process.
Idle engines are released after ten minutes unless keep-loaded mode is selected. AI cancellation suppresses late output locally; the SDK cannot cancel the
upstream provider request yet.

## Online assets

- `sherpa-onnx-node@2.0.1` plus its platform package; `node-cpal@1.0.0` for audio.
- Runtime archives are pinned by URL/version/SHA-512 in `src/runtime-lock.json`.
- Qwen3-ASR (about 838 MiB compressed), SenseVoice (155 MiB) and Silero VAD download
  from the upstream sherpa-onnx GitHub release, with pinned SHA-256 digests.
- Downloads stream to staging directories, reject archive links/path traversal, and
  become visible only after integrity checks, extraction and required-file validation.
  Cancellation/failure cleans staging files. Partial models are never considered ready.
- Packages are extracted directly: no npm execution, install scripts or compiler required.
  Recognition runs offline after provisioning.

Sources: [sherpa Node bindings](https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html),
[Node CPAL](https://github.com/saeta-eth/node-cpal),
[model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models).

## Development and verification

The project uses the published Wox SDK 0.0.146 for its plugin, window and hotkey types.
No adjacent Wox checkout is needed to build, and SDK type imports do not become runtime
dependencies in the packaged plugin.

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
make package PYTHON=python
```

Only plugin/worker JavaScript, metadata, docs, logo, license and short feedback WAVs enter
the `.wox` package. Test caches and research/build directories are ignored.

Run `pnpm run test:provision` once to download integration-test assets (about 1 GiB).
`pnpm run test:native` uses those assets in `.test-cache` (or `DICTATION_TEST_CACHE`)
and upstream model WAVs. It checks native loading, device enumeration, both model formats,
resampling/VAD/recognition and protocol errors. It does not record the microphone.

## Replacement status

Wox migrates built-in Dictation settings, history and downloaded models to this plugin when upgrading. After verifying each model copy, Wox removes its old files. Existing standalone settings and models are preserved. Native dependencies still need to be downloaded; if the old VAD model is missing or incompatible, the plugin downloads it on first use. Some older microphone IDs may need to be reselected.

Direct insertion on other Wayland desktops, selection for background activation and opening Wox AI Chat are not implemented.

## Attribution

Dictation behavior, refinement prompt, icon, sounds and translations originate in
[Wox](https://github.com/Wox-launcher/Wox), under GPL-3.0 (see LICENSE). This implementation
calls upstream bindings; it does not copy the Go speech engine. Downloaded runtime/model
assets retain their own licenses, included in their distributions.
