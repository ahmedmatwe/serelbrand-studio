#!/usr/bin/env python3
"""
Word timestamps for a narration file (free, local, CPU): faster-whisper.
Usage: align.py <audio> [language]  →  prints JSON {"words":[{"w":..,"s":..,"e":..}], "duration": ..}
The TypeScript side aligns these recognised words to the exact script text (src/media/align.ts),
so captions, cuts and shots follow what the narrator REALLY says, when they say it.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: align.py <audio> [lang]"}))
        return 2
    path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "ar"
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # not installed → caller falls back to proportional timing
        print(json.dumps({"error": f"faster-whisper missing: {e}"}))
        return 3
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8",
                         cpu_threads=os.cpu_count() or 4)
    segments, info = model.transcribe(path, language=lang, word_timestamps=True, beam_size=5,
                                      vad_filter=False, condition_on_previous_text=False)
    words = []
    for seg in segments:
        for w in seg.words or []:
            t = (w.word or "").strip()
            if t:
                words.append({"w": t, "s": round(float(w.start), 3), "e": round(float(w.end), 3)})
    print(json.dumps({"words": words, "duration": round(float(info.duration), 3)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
