"""Trivial additive sine synth for the parsed MIDI structure.

Each note becomes a windowed sine tone; all tones are summed (additive
mixing) into one buffer, which is normalized and written to a 16-bit WAV.
Optionally plays it via `aplay`.
"""

import numpy as np
import wave
import subprocess
import sys

from midi_parse import parse_midi

SR = 44100          # sample rate
DROP_DRUMS = True   # channel 9 = GM percussion; sine drums sound bad


def midi_to_hz(pitch):
    return 440.0 * 2.0 ** ((pitch - 69) / 12.0)


def envelope(n, attack=0.005, release=0.03):
    """Short attack/release window so summed sines don't click."""
    env = np.ones(n)
    a = min(int(attack * SR), n // 2)
    r = min(int(release * SR), n // 2)
    if a > 0:
        env[:a] = np.linspace(0.0, 1.0, a)
    if r > 0:
        env[-r:] = np.linspace(1.0, 0.0, r)
    return env


def render(song, chiptune=True):
    total = int((song["duration"] + 0.5) * SR)
    buf = np.zeros(total, dtype=np.float32)

    for note in song["notes"]:
        if DROP_DRUMS and note.channel == 9:
            continue
        n = max(int(note.dur * SR), 1)
        t = np.arange(n) / SR
        freq = midi_to_hz(note.pitch)

        wave_ = np.sin(2 * np.pi * freq * t)
        if chiptune:
            # a whiff of odd harmonics -> squarer, more "chip" timbre
            wave_ += 0.3 * np.sin(2 * np.pi * 3 * freq * t)
            wave_ += 0.15 * np.sin(2 * np.pi * 5 * freq * t)

        amp = (note.velocity / 127.0) ** 1.5 * 0.25
        tone = (wave_ * envelope(n) * amp).astype(np.float32)

        start = int(note.start * SR)
        buf[start:start + n] += tone  # <-- additive mixing

    # normalize to avoid clipping
    peak = np.max(np.abs(buf))
    if peak > 0:
        buf = buf / peak * 0.9
    return buf


def write_wav(buf, path):
    pcm = (buf * 32767).astype(np.int16)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    midi_path = sys.argv[1] if len(sys.argv) > 1 else \
        f"{__import__('os').path.expanduser('~')}/Downloads/input.mid"
    song = parse_midi(midi_path)
    pitched = [n for n in song["notes"] if not (DROP_DRUMS and n.channel == 9)]
    print(f"{len(song['notes'])} notes ({len(pitched)} pitched after dropping drums), "
          f"{song['duration']:.1f}s @ {song['tempo_bpm']} bpm")
    buf = render(song)
    out = "chiptune.wav"
    write_wav(buf, out)
    print(f"wrote {out}  ({len(buf) / SR:.1f}s)")

    if "--play" in sys.argv:
        print("playing via aplay...")
        subprocess.run(["aplay", "-q", out])
