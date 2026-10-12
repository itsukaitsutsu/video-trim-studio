# Manual model download guide (slow connection friendly)

The app can auto-download models, but you can also download them in a browser
(or a download manager like IDM) and drop the files into place. Two engines,
two formats — **only download for the engine you use**.

| Engine | Card | Format | Folder |
| --- | --- | --- | --- |
| faster-whisper (CUDA/CPU) | NVIDIA / any CPU | 4 files per model | `work/fw-models/<model name>/` |
| whisper.cpp (Vulkan/CPU) | AMD / Intel / NVIDIA / CPU | one `ggml-*.bin` | `work/whisper-models/` |

Slow connection? Every link below also works through the mirror — just replace
`huggingface.co` with `hf-mirror.com` in the URL.

---

## For NVIDIA — faster-whisper models → `work\fw-models\`

Each model is **4 files**. Example for `medium`:

```
video-trim-studio\
└── work\
    └── fw-models\
        └── medium\            ← folder name MUST match the model dropdown
            model.bin
            config.json
            tokenizer.json
            vocabulary.txt
```

Download from https://huggingface.co/Systran/faster-whisper-medium :

| File | Direct link |
| --- | --- |
| model.bin (~1.5 GB) | https://huggingface.co/Systran/faster-whisper-medium/resolve/main/model.bin |
| config.json | https://huggingface.co/Systran/faster-whisper-medium/resolve/main/config.json |
| tokenizer.json | https://huggingface.co/Systran/faster-whisper-medium/resolve/main/tokenizer.json |
| vocabulary.txt | https://huggingface.co/Systran/faster-whisper-medium/resolve/main/vocabulary.txt |

Other models: replace `faster-whisper-medium` with `faster-whisper-small`,
`faster-whisper-large-v3`, `faster-whisper-large-v3-turbo`, etc.
These files are identical for CUDA and CPU — one download serves both.

**Apply:** create `work\fw-models\<model>\`, put the 4 files inside, reload
the app page, pick that model and transcribe. The job status shows
`loading model 'medium' from …\work\fw-models\medium…` when it uses your local
folder (no HuggingFace download happens).

---

## For AMD — whisper.cpp GGML models → `work\whisper-models\`

One file per model, named exactly `ggml-<model>.bin` (the links below already
have the correct names — just save them into the folder).

```
video-trim-studio\
└── work\
    └── whisper-models\        ← create the folder if missing
```

| Model | Size | Direct link |
| --- | --- | --- |
| tiny | 75 MB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin |
| base | 142 MB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin |
| small | 466 MB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin |
| medium | 1.5 GB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin |
| large-v3 (max accuracy) | 2.9 GB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin |
| large-v3-turbo ← recommended | 1.6 GB | https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin |

**Apply:** save the file into `work\whisper-models\`, reload the app page,
pick **Engine = whisper.cpp** and that model, transcribe. If your binary has
Vulkan support and your GPU is doing the work, the job shows `backend: vulkan`.

---

### Don't mix them

- GGML `.bin` files only work with whisper.cpp (`whisper-models\`).
- The 4-file CTranslate2 sets only work with faster-whisper (`fw-models\`).
- Both are converted from the same OpenAI weights but are different formats —
  there is no converter between them, and you only need the one for your card.
