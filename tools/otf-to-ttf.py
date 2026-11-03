"""
Convert a CFF-outline OpenType font into a TrueType one with `glyf` outlines.

The formula renderer in this project reads TrueType `glyf` contours; reading CFF would mean a Type 2
charstring interpreter, which is a lot of surface area for a font we only use to draw a handful of glyphs.
fontTools already knows how to convert cubic outlines to quadratic ones, so the conversion happens once,
offline, and the shipped font is the result.

STIX Two Math is licensed under the SIL Open Font License, which permits modification and redistribution
provided the derived font carries the same licence and does not use the reserved name. The output is named
"STIX Two Math TT" for that reason.

Usage:  python tools/otf-to-ttf.py src/tex/fonts/STIX2Math.otf src/tex/fonts/STIX2Math.ttf
"""

import sys
from fontTools.ttLib import TTFont
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen


def convert(src: str, dst: str) -> None:
    font = TTFont(src)

    if "CFF " not in font and "CFF2" not in font:
        print(f"{src} has no CFF table; nothing to convert")
        font.save(dst)
        return

    # The glyph order and the char-to-glyph map stay as they are; only the outline storage changes.
    glyph_set = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    glyf = {}

    print(f"converting {len(glyph_order)} glyphs")

    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        # Cu2QuPen converts the cubic beziers CFF uses into the quadratics TrueType wants. The error bound
        # is in font units; 0.5 is well below one pixel at any size the renderer draws.
        cubic_pen = Cu2QuPen(pen, max_err=0.5, reverse_direction=True)
        try:
            glyph_set[name].draw(cubic_pen)
        except Exception as exc:  # a malformed glyph must not abort the whole conversion
            print(f"  skipped {name}: {exc}")
            glyf[name] = pen.glyph()
            continue
        glyf[name] = pen.glyph()

    # Swap the outline tables.
    from fontTools.ttLib.tables._g_l_y_f import table__g_l_y_f
    from fontTools.ttLib.tables._l_o_c_a import table__l_o_c_a

    font["glyf"] = table__g_l_y_f()
    font["glyf"].glyphs = glyf
    font["loca"] = table__l_o_c_a()

    # The composite/quadratic hints in `cvt`, `fpgm` and `prep` belong to a hinted TrueType font; a
    # converted outline has none, so they are dropped rather than left inconsistent.
    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in font:
            del font[tag]

    # A TrueType font needs maxp version 1.0 with the outline counters.
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = max((len(getattr(g, "components", [])) for g in glyf.values()), default=0)

    # sfntVersion 0x00010000 marks TrueType outlines; 0x4F54544F ("OTTO") would mean CFF.
    font.sfntVersion = "\x00\x01\x00\x00"

    # "Reserved Font Name" rules: the OFL requires a derived font not to use the original name.
    name_table = font["name"]
    for record in name_table.names:
        if record.nameID in (1, 4, 6, 16, 17):
            try:
                value = record.toUnicode()
            except Exception:
                continue
            if "STIX" in value:
                modified = value.replace("STIX Two Math", "STIX Two Math TT").replace("STIXTwoMath", "STIXTwoMathTT")
                record.string = modified.encode(record.getEncoding())

    font.save(dst)
    print(f"wrote {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    convert(sys.argv[1], sys.argv[2])
