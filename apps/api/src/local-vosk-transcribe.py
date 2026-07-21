#!/usr/bin/env python3
import json
import os
import subprocess
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel


SAMPLE_RATE = 16000


def transcribe(audio_path):
    model_path = os.environ.get("VOSK_MODEL_PATH", "/opt/vosk/model")
    SetLogLevel(-1)
    model = Model(model_path)
    recognizer = KaldiRecognizer(model, SAMPLE_RATE)

    process = subprocess.Popen(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-i",
            audio_path,
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "s16le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    parts = []
    while True:
        data = process.stdout.read(4000)
        if len(data) == 0:
            break
        if recognizer.AcceptWaveform(data):
            text = json.loads(recognizer.Result()).get("text", "")
            if text:
                parts.append(text)

    final_text = json.loads(recognizer.FinalResult()).get("text", "")
    if final_text:
        parts.append(final_text)

    _, stderr = process.communicate()
    if process.returncode != 0:
        raise RuntimeError(stderr.decode("utf-8", errors="replace"))

    return " ".join(parts).strip()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: local-vosk-transcribe.py <audio-path>")

    print(
        json.dumps(
            {
                "text": transcribe(sys.argv[1]),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
