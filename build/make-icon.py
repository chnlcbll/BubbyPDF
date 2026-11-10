"""Draws build/icon.png (512x512): a white sheet with a folded corner resting on a bench rail,
on a teal rounded square. Standard library only. Run: python build/make-icon.py"""
import os
import struct
import zlib

N = 512
SS = 3  # supersampling
M = N * SS
TEAL = (14, 116, 102)
DEEP = (9, 84, 74)
WHITE = (255, 255, 255)
LINE = (246, 196, 178)


STOPS = [(0.0, (249, 115, 22)), (0.5, (219, 39, 119)), (1.0, (126, 34, 206))]  # orange, raspberry, plum


def sunset(u, v):
    t = min(1.0, max(0.0, (u * 0.35 + v * 0.65)))
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if t <= b:
            k = (t - a) / (b - a)
            return tuple(int(ca[i] + (cb[i] - ca[i]) * k) for i in range(3))
    return STOPS[-1][1]


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(u, v):
    """u, v in 0..1 over the icon."""
    if not inside_round_rect(u, v, 0.03, 0.03, 0.97, 0.97, 0.2):
        return None
    # bench rail
    if 0.76 <= v <= 0.81 and 0.16 <= u <= 0.84:
        return WHITE
    if 0.81 < v <= 0.87 and (0.22 <= u <= 0.27 or 0.73 <= u <= 0.78):
        return WHITE
    # sheet with folded top-right corner
    sx0, sy0, sx1, sy1, fold = 0.28, 0.14, 0.72, 0.72, 0.13
    if sx0 <= u <= sx1 and sy0 <= v <= sy1:
        if u - (sx1 - fold) > v - sy0:  # cut corner
            return sunset(u, v)
        if u >= sx1 - fold and v <= sy0 + fold:  # the fold flap
            return LINE
        for ly, lx1 in ((0.38, 0.62), (0.47, 0.62), (0.56, 0.52)):
            if ly <= v <= ly + 0.03 and 0.36 <= u <= lx1:
                return LINE
        return WHITE
    return sunset(u, v)


def main():
    rows = []
    for y in range(N):
        row = bytearray([0])
        for x in range(N):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = color_at((x * SS + sx + 0.5) / M, (y * SS + sy + 0.5) / M)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = SS * SS
            a = acc[3] // n
            if a:
                k = acc[3] / 255
                row += bytes((int(acc[0] / k), int(acc[1] / k), int(acc[2] / k), a))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
    with open(out, "wb") as fh:
        fh.write(png)
    print("wrote", out)


if __name__ == "__main__":
    main()
