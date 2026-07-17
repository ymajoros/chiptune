"""Minimal Standard-MIDI-File (SMF) parser -> easily readable note structure.

No external dependencies. Produces a plain dict:

    {
      "ppq": <ticks per quarter note>,
      "tempo_bpm": <initial tempo>,
      "duration": <seconds>,
      "notes": [ Note(...), ... ]        # flattened, sorted by start time
    }

Each Note is (start_sec, dur_sec, midi_pitch, velocity, channel, track).
The structure is deliberately flat so a trivial additive synth can just
iterate over `notes`.
"""

from dataclasses import dataclass, asdict
import struct
import json


@dataclass
class Note:
    start: float      # seconds
    dur: float        # seconds
    pitch: int        # MIDI note number 0..127
    velocity: int     # 1..127
    channel: int
    track: int


def _read_vlq(data, i):
    """Read a MIDI variable-length quantity starting at index i."""
    value = 0
    while True:
        b = data[i]
        i += 1
        value = (value << 7) | (b & 0x7F)
        if not (b & 0x80):
            break
    return value, i


def parse_midi(path):
    with open(path, "rb") as f:
        data = f.read()

    # ---- header chunk ----
    assert data[:4] == b"MThd", "not a MIDI file"
    _, _hlen, fmt, ntracks, division = struct.unpack(">4sIHHH", data[:14])
    if division & 0x8000:
        raise ValueError("SMPTE time division not supported")
    ppq = division
    pos = 14

    # tempo map: list of (abs_tick, microsec_per_quarter)
    tempo_events = []
    # raw note events per track, in ticks
    raw_notes = []

    for track_idx in range(ntracks):
        assert data[pos:pos + 4] == b"MTrk", "bad track header"
        length = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        pos += 8
        end = pos + length
        i = pos
        abs_tick = 0
        running_status = None
        # active notes: (channel, pitch) -> (start_tick, velocity)
        active = {}

        while i < end:
            delta, i = _read_vlq(data, i)
            abs_tick += delta

            status = data[i]
            if status & 0x80:
                i += 1
                running_status = status
            else:
                status = running_status  # running status: reuse previous

            event = status & 0xF0
            channel = status & 0x0F

            if status == 0xFF:  # meta event
                meta_type = data[i]
                i += 1
                mlen, i = _read_vlq(data, i)
                mdata = data[i:i + mlen]
                i += mlen
                if meta_type == 0x51 and mlen == 3:  # set tempo
                    uspq = (mdata[0] << 16) | (mdata[1] << 8) | mdata[2]
                    tempo_events.append((abs_tick, uspq))
            elif status in (0xF0, 0xF7):  # sysex
                slen, i = _read_vlq(data, i)
                i += slen
            elif event in (0x80, 0x90):  # note off / note on
                pitch = data[i]
                vel = data[i + 1]
                i += 2
                key = (channel, pitch)
                if event == 0x90 and vel > 0:
                    active[key] = (abs_tick, vel)
                else:  # note off (or note-on vel 0)
                    if key in active:
                        start_tick, v = active.pop(key)
                        raw_notes.append(
                            (start_tick, abs_tick, pitch, v, channel, track_idx)
                        )
            elif event in (0xA0, 0xB0, 0xE0):  # 2-byte channel messages
                i += 2
            elif event in (0xC0, 0xD0):        # 1-byte channel messages
                i += 1
            else:
                i += 1  # unknown; best-effort skip

        pos = end

    if not tempo_events:
        tempo_events = [(0, 500000)]  # default 120 bpm
    tempo_events.sort()

    # ---- convert ticks -> seconds using the tempo map ----
    def tick_to_sec(tick):
        sec = 0.0
        prev_tick, prev_uspq = tempo_events[0][0], tempo_events[0][1]
        # ensure a tempo anchor at tick 0
        if tempo_events[0][0] != 0:
            prev_tick, prev_uspq = 0, tempo_events[0][1]
        for t, uspq in tempo_events:
            if t >= tick:
                break
            sec += (t - prev_tick) * (prev_uspq / 1_000_000) / ppq
            prev_tick, prev_uspq = t, uspq
        sec += (tick - prev_tick) * (prev_uspq / 1_000_000) / ppq
        return sec

    notes = []
    for start_tick, end_tick, pitch, vel, ch, tr in raw_notes:
        s = tick_to_sec(start_tick)
        e = tick_to_sec(end_tick)
        notes.append(Note(s, max(e - s, 0.01), pitch, vel, ch, tr))

    notes.sort(key=lambda n: n.start)
    duration = max((n.start + n.dur for n in notes), default=0.0)
    tempo_bpm = round(60_000_000 / tempo_events[0][1], 1)

    return {
        "ppq": ppq,
        "tempo_bpm": tempo_bpm,
        "duration": duration,
        "notes": notes,
    }


if __name__ == "__main__":
    import sys
    song = parse_midi(sys.argv[1])
    print(f"ppq={song['ppq']}  tempo={song['tempo_bpm']} bpm  "
          f"duration={song['duration']:.1f}s  notes={len(song['notes'])}")
    # dump the readable structure
    out = {
        "ppq": song["ppq"],
        "tempo_bpm": song["tempo_bpm"],
        "duration": round(song["duration"], 3),
        "notes": [asdict(n) for n in song["notes"]],
    }
    with open("song.json", "w") as f:
        json.dump(out, f, indent=1)
    print("wrote song.json")
