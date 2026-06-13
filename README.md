# After Effects AutoCaption

Word-accurate auto captions for Adobe After Effects, driven by a ScriptUI panel.
Transcribes a selected audio/video layer with the **Groq** or **OpenAI Whisper**
API, drops one timeline **marker per word**, then generates clean, styled,
animatable caption text layers from those markers.

The markers are the source of truth — hand-fix any word or its timing on the
layer, then re-generate. Generated layers carry the comment `AutoCaption` and are
replaced on every generate, so iterating is safe.

![After Effects](https://img.shields.io/badge/After%20Effects-24%2B-9999FF?logo=adobeaftereffects&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-macOS-black?logo=apple)
![License](https://img.shields.io/badge/License-Proprietary-blue)

---

## Features

- **Word-level timing** from Groq (`whisper-large-v3-turbo`) or OpenAI (`whisper-1`).
- **Spoken-word highlight** — the current word changes color as the audio plays
  (expression-driven, no extra keyframes).
- **Text-animation presets** captured from hand-animated titles (Rise Up, Slide
  In, Flicker, Fade) applied per caption layer.
- **Smart chunking** — break captions on punctuation and natural pauses, with a
  words-per-screen cap.
- **Multi-language** — auto-detect, English, Hindi, Marathi, Spanish, French,
  German (Whisper supports many more via the API).
- **SRT / verbose-JSON import** — bring your own transcript instead of calling the API.
- **Restyle / re-animate** existing caption layers in place.
- Settings (provider, API keys, style) persist between sessions.

---

## Requirements

| Dependency | Why it's needed | Ships with macOS? |
| --- | --- | --- |
| **After Effects 24+** | Host app; uses the `app.fonts` catalog API | — |
| **[ffmpeg](https://ffmpeg.org/)** | Extracts audio → 16 kHz mono WAV before upload | ❌ install via Homebrew |
| **python3** | Runs the bundled `flatten.py` (standard library only — no pip packages) | ✅ yes |
| **curl** | Sends the audio to the transcription API | ✅ yes |
| **A Groq or OpenAI API key** | The actual transcription | ❌ get one (free tier on Groq) |

> Transcription runs on a **remote API** — there is no local Whisper model and
> **no heavy download**. The only thing you install is `ffmpeg`.

### Get an API key

- **Groq** (default, fast, free tier): <https://console.groq.com/keys>
- **OpenAI**: <https://platform.openai.com/api-keys>

You paste the key into the panel inside After Effects — never into the terminal.
It is stored locally at
`~/Library/Application Support/AutoCaption/settings.json`.

---

## Installation

### One command — paste this into Terminal

It installs Homebrew (if missing) + ffmpeg, then drops `AutoCaption.jsx` straight
into your After Effects ScriptUI Panels folder:

```bash
curl -fsSL https://raw.githubusercontent.com/5iddhesh/After-Effects-AutoCaption/main/install.sh | bash
```

That's the whole install. Then in After Effects:

1. **Preferences → Scripting & Expressions** → enable **Allow Scripts to Write
   Files and Access Network** (the panel calls ffmpeg, curl and python).
2. Restart After Effects.
3. Open **Window → AutoCaption.jsx**, paste a Groq/OpenAI key, and go.

<details>
<summary>Prefer to do it manually?</summary>

```bash
# 1. Install Homebrew (skip if you already have it) — https://brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Add brew to your PATH (Apple Silicon path shown; Intel uses /usr/local)
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# 3. Install ffmpeg
brew install ffmpeg

# 4. Copy the panel into After Effects (replace 26.0 with your AE version)
cp AutoCaption.jsx \
  "$HOME/Library/Application Support/Adobe/After Effects/26.0/Scripts/ScriptUI Panels/"
```

Or clone and run the installer locally:

```bash
git clone https://github.com/5iddhesh/After-Effects-AutoCaption.git
cd After-Effects-AutoCaption
./install.sh            # add --no-panel to install dependencies only
```

</details>

---

## Usage

1. **Select one audio or video layer** in an active composition.
2. In the panel, pick your **provider**, paste your **API key**, hit **Save**.
3. **Transcribe & Mark Words** — adds one marker per spoken word on the layer.
   Scrub the timeline and fix any misheard words or timings directly on the
   markers (double-click a marker to edit its text/duration).
4. Set caption **style** — placement, words/screen, font, size, colors, stroke,
   spoken-word highlight, and an animation preset.
5. **Generate Captions** — builds styled text layers from the markers. Re-run any
   time; old `AutoCaption` layers are replaced.

**Bring your own transcript instead:** use **Import SRT/JSON…** with an SRT file
or a WhisperX / Whisper verbose-JSON file.

---

## How it works

```
Audio layer ──ffmpeg──▶ 16kHz WAV ──curl──▶ Whisper API (verbose_json, word timestamps)
                                                 │
                                       flatten.py (stdlib)
                                                 │
                                          word ▸ start ▸ end  (TSV)
                                                 │
                                      one layer marker per word   ◀── edit by hand
                                                 │
                                   chunk ▸ styled text layers ▸ highlight + animation
```

The transcription core lives on `$.global.AutoCaptionCore` so it can be tested
headless. Set `$.global.AC_CORE_ONLY = true` before `evalFile` to load the core
without building the UI.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `command not found: brew` | Homebrew isn't on your PATH — run the PATH step above, then open a **new** terminal. |
| `ffmpeg not found.` in the panel | `brew install ffmpeg`, then restart After Effects. |
| `No API key set.` | Paste a Groq/OpenAI key in the panel and hit **Save**. |
| `API HTTP 401` | Wrong/expired key, or an OpenRouter `sk-or-…` key (not supported). |
| `Layer has no source file` | Pre-comp audio — flatten it, or import a transcript via SRT/JSON. |
| Panel doesn't appear | Enable *Allow Scripts to Write Files and Access Network*, then restart AE. |

---

## Privacy

Your audio is uploaded to whichever provider you choose (Groq or OpenAI) for
transcription. Nothing else leaves your machine. API keys are stored locally only.

---

## License

[LICENSE](LICENSE)
