"""Mark the tagged players on one still, for the coaching model to follow.

THIS IMAGE IS THE ONLY THING THAT SAYS WHO IS BEING COACHED. The overlay video
carries no boxes, no names and no highlight on anybody -- the pipeline's
per-frame identity claims were removed because a wrong one produces confident
coaching about the wrong person. So everything rests on this mark being
unmistakable at the size a model actually sees it: Gemini resizes an image to
roughly a 768px tile before looking at it, which turns a thin rectangle on a
busy court into a few grey pixels.

Hence a ring rather than a box, a chevron above the head, and a label on a
solid chip -- three redundant signals at three different scales, so the mark
survives the resize even where one of them lands on clutter.
"""
import argparse
import cv2
import numpy as np

# Magenta. Chosen because nothing on a pickleball court is this colour: the
# paint is white or yellow, the surface blue or green, and kit is anything --
# but a saturated magenta is rare enough in the wild that it reads as an
# annotation rather than as part of the scene.
C_MARK = (200, 20, 220)
# Cyan for the partner, on the same reasoning and chosen to survive the same
# resize. It has to differ from magenta in BRIGHTNESS as well as hue: Gemini
# sees this at roughly a 768px tile, and two marks that are only a hue apart
# become two similar smudges at that size -- which is worse than one mark,
# because the partnership read would then be about whichever player the model
# guessed. Magenta is dark-red-dominant, this is light-blue-dominant.
C_PARTNER = (235, 200, 20)
C_TEXT = (255, 255, 255)

# BGR, because OpenCV. Getting this backwards swaps the two players' colours,
# which is exactly the failure this file exists to prevent.
COLOURS = {"YOU": C_MARK, "PARTNER": C_PARTNER}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--out", required=True)
    ap.add_argument("--box", help="x,y,w,h in normalised [0,1] image coordinates")
    ap.add_argument("--label", default="YOU")
    ap.add_argument("--mark", action="append", default=[],
                    help="x,y,w,h:LABEL -- repeatable, one per player to mark")
    args = ap.parse_args()

    # --box/--label is the single-player form and stays supported; --mark is
    # the same thing repeated. Both end up here so the drawing code below has
    # one input shape rather than two.
    marks = [tuple(m.split(":", 1)) for m in args.mark]
    if args.box:
        marks.append((args.box, args.label))
    if not marks:
        raise SystemExit("nothing to mark: pass --box or --mark")

    img = cv2.imread(args.image)
    if img is None:
        raise SystemExit(f"could not read {args.image}")
    h, w = img.shape[:2]

    for box_s, label in marks:
        draw_mark(img, box_s, label, w, h)

    if not cv2.imwrite(args.out, img, [int(cv2.IMWRITE_JPEG_QUALITY), 92]):
        raise SystemExit(f"could not write {args.out}")
    print(f"marked {', '.join(lbl for _, lbl in marks)} -> {args.out}")


def draw_mark(img, box_s: str, label: str, w: int, h: int) -> None:
    colour = COLOURS.get(label.upper(), C_MARK)
    bx, by, bw, bh = (float(v) for v in box_s.split(","))
    x1, y1 = int(bx * w), int(by * h)
    x2, y2 = int((bx + bw) * w), int((by + bh) * h)
    cx = (x1 + x2) // 2
    # Scale every stroke to the image, so the mark looks the same on a 720p
    # frame and a 4K one instead of vanishing on the larger.
    scale = max(1.0, w / 1280.0)

    # An ellipse around the whole body rather than a rectangle. A rectangle is
    # what the removed boxes looked like, and this must not be mistaken for one
    # of them -- there are none in the video, and a reader who thinks there are
    # will go looking for the rest.
    axes = (max(12, int((x2 - x1) * 0.75)), max(18, int((y2 - y1) * 0.60)))
    centre = (cx, (y1 + y2) // 2)
    # Drawn twice: a dark halo underneath so the ring is visible against a
    # light shirt or a pale court as well as a dark one.
    cv2.ellipse(img, centre, axes, 0, 0, 360, (20, 20, 20), int(7 * scale), cv2.LINE_AA)
    cv2.ellipse(img, centre, axes, 0, 0, 360, colour, int(3 * scale), cv2.LINE_AA)

    # A chevron above the head, which survives the resize when the ring has
    # merged into the background.
    #
    # MEASURED FROM THE RING, not from the box. Taking it off the box top put
    # the chevron inside the ellipse and over the player's face -- the ring
    # stands well clear of the box it was built from, so the two numbers are
    # not interchangeable. The mark is supposed to point AT the person without
    # covering the part that identifies them.
    ring_top = centre[1] - axes[1]
    size = int(22 * scale)
    tip_y = ring_top - int(30 * scale)
    # DROPPED ENTIRELY when there is no room above the ring, rather than
    # clamped into the frame. Clamping put the chevron inside the ellipse and
    # over the player -- for somebody at the top of the shot it covered the
    # whole of them, which defeats the point of marking them at all. The ring
    # and the label below it identify the person on their own.
    has_chevron = tip_y >= int(6 * scale)
    if has_chevron:
        tri = np.array([[cx, tip_y + size], [cx - size, tip_y], [cx + size, tip_y]], np.int32)
        cv2.fillPoly(img, [tri], (20, 20, 20), cv2.LINE_AA)
        cv2.fillPoly(img, [tri - np.array([0, int(3 * scale)])], colour, cv2.LINE_AA)

    # And the word, on a solid chip. Placed above the chevron, or below the
    # player when there is no room above -- a label off the top of the frame is
    # the same as no label.
    fs = 0.9 * scale
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
    ly = (tip_y if has_chevron else ring_top) - int(8 * scale)
    if ly - th - 8 < 0:
        # Below the player instead. A label off the top of the frame is the
        # same as no label.
        ly = min(h - int(6 * scale), int(centre[1] + axes[1]) + th + int(16 * scale))
    lx = min(max(int(6 * scale), cx - tw // 2), w - tw - int(12 * scale))
    cv2.rectangle(img, (lx - 6, ly - th - 8), (lx + tw + 6, ly + 6), colour, -1)
    cv2.putText(img, label, (lx, ly), cv2.FONT_HERSHEY_SIMPLEX, fs, C_TEXT, 2, cv2.LINE_AA)


if __name__ == "__main__":
    main()
