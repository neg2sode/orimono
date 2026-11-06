"""Build the drum machine's sample kit from the source libraries.

For every row picked by ear (design plan §4.2):
  * group files into strengths (velocity layers) and takes (round robins),
  * measure each file's real start, its fade-out point and its loudness,
  * keep up to MAX_LAYERS strengths, spread evenly by measured loudness,
  * trim to the real start, cut the silent tail, write 16-bit FLAC
    (lossless, and unlike MP3/AAC it adds no silent padding at the start,
    so hits stay on time),
  * measure each take's lead-in (see measure()),
  * write public/kit/manifest.json for the app.

Needs sox and ffmpeg on PATH. Run from the app folder:  npm run kit
"""
import json, math, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
PROJECT = os.path.dirname(APP)
OUT = os.path.join(APP, "public", "kit")

GSCW = os.path.join(PROJECT, "GSCW DRUMS Library Vol.1")
K1 = os.path.join(GSCW, "G&S CW-Drum Kit-1")
K2 = os.path.join(GSCW, "G&S CW-Drum Kit-2")
VCSL = os.path.join(PROJECT, "VCSL-percussion")
FP = os.path.join(PROJECT, "FreePats-world-percussion", "WorldPercussion SFZ+WAV-20200905", "samples")

MAX_LAYERS = 5
SR = 48000

# tag, name, folder, filename regex, stereo, loudness target (dB, see below), floor ms, max length s, chokes
# ("takes" in the last list means: every file is a take of one single strength.)
# Loudness target: the loudest strength's average level over its first 100 ms is set to this.
# These are starting points for the mix, to be tuned by ear.
ROWS = [
    ("CR", "Crash", f"{K2}/14", r"^V\d+-crash-14", True, -21, 50, 3.0, []),
    ("RD", "Ride", f"{K2}/Ride", r"Ride-22", True, -23, 50, 2.5, []),
    ("OH", "Open hat", f"{K1}/Hats-1", r"^HHats-OP-V", True, -22, 50, 1.6, []),
    ("CH", "Closed hat", f"{K1}/Hats-1", r"^HHats-CL-V", True, -22, 40, 0.6, ["OH"]),
    ("PH", "Pedal hat", f"{K1}/Hats-1", r"^HHats-PDL-V", True, -25, 40, 0.5, ["OH"]),
    ("SH", "Egg shaker", f"{FP}/EggShaker", r"^soft_", False, -24, 40, 0.4, ["takes"]),
    ("TB", "Tambourine", f"{VCSL}/Tambourine 1", r"^Tamb1_Shake", True, -24, 40, 0.8, []),
    ("CB", "Cowbell", f"{VCSL}/Cowbells", r"^Cowbell2_Normal", False, -22, 50, 0.8, []),
    ("CL", "Claves", f"{VCSL}/Claves", r"^Claves1_Hit", False, -22, 40, 0.6, []),
    ("XS", "Cross-stick", f"{K2}/CW snare drum/Snare Side Stick", r"SStick", False, -20, 40, 0.5, []),
    ("CP", "Claps", f"{VCSL}/Claps", r"^Clap_rr", True, -19, 60, 0.6, []),
    ("BG", "Bongo", f"{VCSL}/Bongos", r"^BongoL_Hit1_", False, -18, 50, 0.7, []),
    ("CG", "Quinto", f"{VCSL}/Conga", r"^Quinto_HitN_", False, -18, 50, 0.8, []),
    ("DB", "Darbuka", f"{VCSL}/Darbuka", r"^Darbuka_4_hit", False, -18, 50, 0.7, []),
    ("HT", "High tom", f"{K2}/Tom10", r"TTom 10", False, -17, 50, 1.4, []),
    ("FT", "Floor tom", f"{K2}/Tom13", r"TTom13", False, -16, 50, 1.6, []),
    ("SD", "Snare", f"{K1}/Snare hits-1", r"^SNARE-V", False, -15, 50, 0.8, []),
    ("BD", "Kick", f"{K2}/YMH-kick-drum", r"EQ-KD", False, -13, 60, 0.9, []),
]


def envelope(path):
    """1 ms peak envelope (dBFS) of a file, mixed to mono."""
    ch = int(subprocess.run(["soxi", "-c", path], capture_output=True, text=True).stdout.strip())
    pan = "pan=mono|c0=0.5*c0+0.5*c1," if ch == 2 else ""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-af",
         f"{pan}aresample={SR},asetnsamples={SR // 1000},astats=metadata=1:reset=1,"
         "ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-",
         "-f", "null", "-"], capture_output=True, text=True, check=True)
    env = []
    for line in r.stdout.splitlines():
        if line.startswith("lavfi.astats.Overall.Peak_level="):
            v = line.split("=", 1)[1]
            env.append(-200.0 if "inf" in v else float(v))
    return env


def measure(path):
    env = envelope(path)
    pk = max(env)
    # Real start: first millisecond within 30 dB of the peak, minus 1 ms of lead-in.
    start = max(0, next(i for i, v in enumerate(env) if v > pk - 30) - 1)
    # Fade point: last millisecond within 50 dB of the peak.
    end = max(i for i, v in enumerate(env) if v > pk - 50) + 1
    # Loudness: the loudest 100 ms stretch (robust for shakes that start softly and swell).
    pw = [10 ** (v / 10) for v in env]
    win = min(100, len(pw))
    acc = sum(pw[:win]); best = acc
    for i in range(win, len(pw)):
        acc += pw[i] - pw[i - win]; best = max(best, acc)
    loud = 10 * math.log10(best / win)
    # Lead-in: how long after the real start the sound reaches its loud part (within 12 dB of the
    # peak). Shakes swell before their accent; the app starts such sounds early by this much, so
    # the accent lands on the beat.
    lead = next(i for i, v in enumerate(env) if i >= start and v > pk - 12) - start
    return dict(start_ms=start, end_ms=end, loud=loud, lead_ms=min(lead, 120))


def layer_key(name):
    """File name without its take number: files sharing a key are takes of one strength."""
    return re.sub(r"_?rr\d+", "", name)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    manifest = {"sampleRate": SR, "rows": []}
    total = 0
    for tag, name, folder, pat, stereo, target, floor, maxlen, chokes in ROWS:
        files = sorted(f for f in os.listdir(folder) if f.lower().endswith(".wav") and re.search(pat, f))
        if not files:
            sys.exit(f"{tag}: no files match {pat!r} in {folder}")
        layers = {}
        for f in files:
            m = measure(os.path.join(folder, f))
            key = "all" if "takes" in chokes else layer_key(f)
            layers.setdefault(key, []).append((f, m))
        # Order strengths by measured loudness (file numbering is not always in order).
        ordered = sorted(layers.values(), key=lambda takes: sum(m["loud"] for _, m in takes) / len(takes))
        if len(ordered) > MAX_LAYERS:
            idx = sorted({round(i * (len(ordered) - 1) / (MAX_LAYERS - 1)) for i in range(MAX_LAYERS)})
            ordered = [ordered[i] for i in idx]
        top = sum(m["loud"] for _, m in ordered[-1]) / len(ordered[-1])
        row = {"tag": tag, "name": name, "gainDb": round(target - top, 1), "floorMs": floor,
               "chokes": [c for c in chokes if c != "takes"], "layers": []}
        for li, takes in enumerate(ordered):
            entry = {"loudDb": round(sum(m["loud"] for _, m in takes) / len(takes) - top, 1), "takes": []}
            for ti, (f, m) in enumerate(takes):
                dur = min((m["end_ms"] - m["start_ms"]) / 1000, maxlen)
                fade = min(0.05, dur / 4)
                out = f"{tag}-{li + 1}-{ti + 1}.flac"
                subprocess.run(
                    ["sox", os.path.join(folder, f), "-r", str(SR), "-c", "2" if stereo else "1", "-b", "16",
                     os.path.join(OUT, out), "trim", f"{m['start_ms'] / 1000:.4f}", f"{dur:.4f}",
                     "fade", "0", f"{dur:.4f}", f"{fade:.4f}"], check=True, stderr=subprocess.DEVNULL)
                total += os.path.getsize(os.path.join(OUT, out))
                entry["takes"].append({"file": out, "leadMs": m["lead_ms"]})
            row["layers"].append(entry)
        manifest["rows"].append(row)
        print(f"{tag:3} {len(row['layers'])} strengths x {max(len(l['takes']) for l in row['layers'])} takes, gain {row['gainDb']:+.1f} dB")
    with open(os.path.join(OUT, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"kit: {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
