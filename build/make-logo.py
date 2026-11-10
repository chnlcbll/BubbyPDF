"""Cut the BubbyPDF logo out of its white background.

usage: python make-logo.py <raw rgb24 file> <width> <height> <out.png>
Only white that is connected to the image border becomes transparent, so the white page
inside the logo stays white. Edge pixels get partial transparency (with the white removed
from their colour) so the logo has no white fringe on dark backgrounds.
"""
import struct
import sys
import zlib
from collections import deque


def main(src, w, h, out):
    w, h = int(w), int(h)
    px = open(src, 'rb').read()
    lum = lambda i: min(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])
    bg = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append(y * w + x)
    for y in range(h):
        for x in (0, w - 1):
            q.append(y * w + x)
    while q:
        i = q.popleft()
        if bg[i] or lum(i) < 238:
            continue
        bg[i] = 1
        x, y = i % w, i // w
        if x > 0: q.append(i - 1)
        if x < w - 1: q.append(i + 1)
        if y > 0: q.append(i - w)
        if y < h - 1: q.append(i + w)
    # bounding box of the logo
    xs = [i % w for i in range(w * h) if not bg[i]]
    ys = [i // w for i in range(w * h) if not bg[i]]
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    side = int(max(x2 - x1, y2 - y1) * 1.08)
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    ox, oy = cx - side // 2, cy - side // 2
    rows = []
    for yy in range(side):
        row = bytearray([0])
        for xx in range(side):
            x, y = ox + xx, oy + yy
            if not (0 <= x < w and 0 <= y < h):
                row += b'\0\0\0\0'; continue
            i = y * w + x
            r, g, b = px[i * 3], px[i * 3 + 1], px[i * 3 + 2]
            if bg[i]:
                row += b'\0\0\0\0'; continue
            near = any(0 <= x + dx < w and 0 <= y + dy < h and bg[(y + dy) * w + x + dx]
                       for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2))
            a = 1.0
            if near:
                m = min(r, g, b)
                a = max(0.0, min(1.0, (255 - m) / 70.0)) if m > 185 else 1.0
            if a <= 0.01:
                row += b'\0\0\0\0'; continue
            un = lambda c: int(max(0, min(255, (c - (1 - a) * 255) / a)))
            row += bytes((un(r), un(g), un(b), int(a * 255)))
        rows.append(bytes(row))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', side, side, 8, 6, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
    open(out, 'wb').write(png)
    print('logo', side, 'px, box', (x1, y1, x2, y2))


if __name__ == '__main__':
    main(*sys.argv[1:5])
