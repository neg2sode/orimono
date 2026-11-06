"""Drum sources for the kit: per-microphone recordings mixed to stereo, then shaped by EQ.

The drum rows come from multi-microphone kits. For each hit this mixes the drum's own close
microphone with some of the overhead microphones, then applies a fixed EQ curve (and, for drums
that ring much longer than wanted, a shorter length). The EQ curves were fitted by measurement
to a reference sound picked by ear, then checked by ear.

All levels inside one row keep their relation, so soft and loud hits stay soft and loud.
Processed hits are cached in ../kit-cache (outside the repo). Sample rates stay as recorded.

Sources (see README for credits):
  DRS Kit, Muldjord Kit       — DrumGizmo team, Lars Muldjord, Bent Bisballe Nyeng, Jes Eiler — CC-BY 4.0
  Big Rusty Drums             — Karoryfer Samples — CC0
  Virtuosity Drums            — Versilian Studios / Karoryfer Samples — CC0
"""
import functools, glob, hashlib, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(PROJECT, "kit-cache")
DRS = os.path.join(PROJECT, "CC-BY-kits/DRSKit/DrumGizmo/DRSKit/Samples")
MUL = os.path.join(PROJECT, "CC-BY-kits/MuldjordKit/DrumGizmo/MuldjordKit/Samples")
BR = os.path.join(PROJECT, "Big-Rusty-Drums/Samples")
VD = os.path.join(PROJECT, "Virtuosity-Drums/Samples")

# Octave-band EQ centres (Hz), one gain per band in each recipe below.
BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
HEADROOM_DB = -9  # the same for every hit, so EQ boosts never clip; the app sets the final level


def _mix(parts, key):
    """parts: [(path, gain dB, 'c' centre | 'l' left | 'r' right | 's' stereo)] -> stereo wav."""
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, "mix-" + hashlib.md5(key.encode()).hexdigest() + ".wav")
    if os.path.exists(out):
        return out
    tmp = []
    for i, (p, g, pos) in enumerate(parts):
        t = f"{out}.{i}.wav"
        ch = int(subprocess.run(["soxi", "-c", p], capture_output=True, text=True).stdout)
        route = [] if ch == 2 else {"l": ["remix", "1", "0"], "r": ["remix", "0", "1"]}.get(pos, ["remix", "1", "1"])
        subprocess.run(["sox", p, "-b", "24", t] + route + ["vol", f"{g}dB"],
                       check=True, stderr=subprocess.DEVNULL)
        tmp.append(t)
    if len(tmp) == 1:
        os.rename(tmp[0], out)
    else:
        subprocess.run(["sox", "-m"] + sum([["-v", "1", t] for t in tmp], []) + [out],
                       check=True, stderr=subprocess.DEVNULL)
        for t in tmp:
            os.remove(t)
    return out


def drumgizmo(base, piece, close, oh_db):
    """DrumGizmo kits: hit n of a piece is {n}-{piece}-{mic}.flac for every microphone."""
    hits = {}
    for f in glob.glob(f"{base}/{piece}/*.flac"):
        m = re.match(rf"(\d+)-{re.escape(piece)}-(.+)\.flac$", os.path.basename(f))
        if m:
            hits.setdefault(int(m.group(1)), {})[m.group(2)] = f
    out = []
    for n, mics in sorted(hits.items()):
        parts = [(mics[c], g, "c") for c, g in close if c in mics]
        if oh_db is not None and "OHL" in mics:
            parts += [(mics["OHL"], oh_db, "l"), (mics["OHR"], oh_db, "r")]
        out.append(_mix(parts, f"{base}|{piece}|{n}|{close}|{oh_db}"))
    return out


def big_rusty(path, mics, gains):
    """Big Rusty: the same file name in each microphone's folder."""
    names = sorted(os.path.basename(f) for f in glob.glob(f"{BR}/{path}/{mics[0]}/*.flac"))
    return [_mix([(f"{BR}/{path}/{m}/{nm}", g, "s" if m == "oh" else "c") for m, g in zip(mics, gains)],
                 f"BR|{path}|{nm}|{mics}|{gains}") for nm in names]


def virtuosity(art, close):
    """Virtuosity: the 'mid' stereo pair, plus the drum's close microphone."""
    out = []
    for f in sorted(glob.glob(f"{VD}/mid/*/mid_{art}_vl*.flac")):
        c = f.replace("/mid/", f"/{close}/").replace(f"mid_{art}", f"{close}_{art}")
        out.append(_mix([(f, -4, "s"), (c, 0, "c")], f"VD|{f}|{close}"))
    return out


def shape(files, gains, ring_ms=None):
    """Apply the EQ curve (and shorter ring) to every hit of a row."""
    out = []
    for src in files:
        key = f"{src}|{gains}|{ring_ms}|{HEADROOM_DB}"
        dst = os.path.join(CACHE, "eq-" + hashlib.md5(key.encode()).hexdigest() + ".wav")
        if not os.path.exists(dst):
            eff = ["vol", f"{HEADROOM_DB}dB"]
            for f, g in zip(BANDS, gains):
                if abs(g) >= 0.5:
                    eff += ["equalizer", str(f), "1o", f"{g:.1f}"]
            subprocess.run(["sox", src, dst] + eff, check=True, stderr=subprocess.DEVNULL)
        out.append(dst)
    return out


# Mic balance: "close" = overheads 14 dB under the close mic (hats and cymbals: 10 dB),
# "balanced" = 6 dB under. Each row: (hits, EQ gains per band, ring length ms or None).
@functools.lru_cache(None)
def recipes():
    return {
        "BD": (drumgizmo(MUL, "KdrumL", [("KdrumL", 0)], -6),
               [-0.1, 0.0, 0.4, 3.6, -1.9, -11.2, -1.6, -0.6, 6], None),
        "SD": (virtuosity("snare_center", "snaremic"),
               [3.5, 2.3, 0.0, -3.3, 0.9, 1.4, 1.3, -0.1, 6], None),
        "XS": (virtuosity("snare_crossstick", "snaremic"),
               [6, 5.9, 0.3, -4.6, -7.2, -2.1, 2.6, -6.5, 3.1], 215),
        "HT": (drumgizmo(MUL, "Tom1", [("Tom1", 0)], -14),
               [-2.0, -1.3, 0.0, -3.2, -4.1, 0.8, 5.5, -1.5, -8.0], 1291),
        "FT": (drumgizmo(DRS, "Tom3", [("Tom3", 0)], -14),
               [3.5, 2.9, 0.0, -6.8, 0.6, 1.2, -1.4, 2.8, 6], 1056),
        "CH": (drumgizmo(DRS, "Hihat_closed", [("Hihat", 0)], -10),
               [-12, -12, -12, -10.4, -7.6, -4.9, -7.6, -4.8, 2.4], None),
        "OH": (drumgizmo(DRS, "Hihat_semi_open", [("Hihat", 0)], -10),
               [-12, -12, -9.1, -1.6, -1.6, 1.4, -0.5, -0.7, 6], None),
        "PH": (drumgizmo(DRS, "Hihat_foot", [("Hihat", 0)], -10),
               [-11.1, -11.6, -12, -11.3, -3.8, -7.0, -11.7, -4.5, 0.7], None),
        "RD": (big_rusty("ride_22/rd", ["cl", "oh"], [0, -10]),
               [-11.3, -11.5, -7.4, -4.6, -8.6, 0.0, -1.1, -4.0, 6], None),
        "CR": (drumgizmo(MUL, "CrashR", [], 0),
               [-12, -12, -12, -4.2, -1.6, 1.9, 0.0, -4.3, 1.6], 2912),
    }


def files(tag):
    hits, gains, ring = recipes()[tag]
    return shape(hits, gains, ring), ring
