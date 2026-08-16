"""Write a placeholder PNG with no third-party dependencies.

Used by the smoke test so Phase 1 can be verified before any real keyframe
exists. Pure zlib + struct, so it works in a bare container without Pillow.
"""

from __future__ import annotations

import argparse
import struct
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, width: int = 1280, height: int = 704) -> str:
    """A soft diagonal gradient with a lighter oval — enough structure that a
    generated clip visibly moves rather than looking like a static colour field."""
    rows = bytearray()
    cx, cy = width / 2, height / 2.2
    radius = min(width, height) / 3.2

    for y in range(height):
        rows.append(0)  # PNG filter type 0 for this scanline
        for x in range(width):
            fx, fy = x / width, y / height
            r = int(210 - 70 * fy + 30 * fx)
            g = int(200 - 40 * fy + 20 * fx)
            b = int(190 + 40 * fy)

            dx, dy = (x - cx) / radius, (y - cy) / radius
            if dx * dx + dy * dy < 1.0:
                r = min(255, r + 35)
                g = min(255, g + 30)
                b = min(255, b + 15)

            rows += bytes((max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))))

    png = b"\x89PNG\r\n\x1a\n"
    png += _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += _chunk(b"IDAT", zlib.compress(bytes(rows), 6))
    png += _chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=704)
    args = ap.parse_args()
    print(write_png(args.path, args.width, args.height))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
