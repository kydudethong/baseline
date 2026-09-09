"""The line mask, on lines that are not white.

Every image here is synthetic, so the numbers are checkable rather than
impressionistic: a known surface colour, lines drawn at known pixel
coordinates, and assertions about how much of *those* pixels the mask
recovers and how much of everything else it wrongly claims.
"""
import cv2
import numpy as np
import pytest

from rally_seg.config import CourtConfig
from rally_seg.detect.court import line_mask, parse_hex_color, white_line_mask

H, W = 360, 640
LINE_W = 3


def court_image(surface_bgr, line_bgr, distractor_bgr=None):
    """A surface with two horizontal and two vertical lines, and optionally a
    large block of a fourth colour standing in for a shirt or a fence."""
    img = np.zeros((H, W, 3), np.uint8)
    img[:, :] = surface_bgr
    truth = np.zeros((H, W), np.uint8)
    for y in (90, 270):
        cv2.line(img, (60, y), (W - 60, y), line_bgr, LINE_W)
        cv2.line(truth, (60, y), (W - 60, y), 255, LINE_W)
    for x in (60, W - 60):
        cv2.line(img, (x, 90), (x, 270), line_bgr, LINE_W)
        cv2.line(truth, (x, 90), (x, 270), 255, LINE_W)
    if distractor_bgr is not None:
        cv2.rectangle(img, (300, 300), (400, 350), distractor_bgr, -1)
    return img, truth


def recall(mask, truth):
    """Fraction of real line pixels the mask found, allowing one pixel of
    slop -- an edge-detected line lands beside the drawn one as often as on
    it, and a one-pixel offset is not a miss."""
    found = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    return float((found[truth > 0] > 0).sum()) / float((truth > 0).sum())


def false_area(mask, truth):
    """Fraction of the frame claimed as paint that is not near any line."""
    near = cv2.dilate(truth, np.ones((7, 7), np.uint8))
    return float(((mask > 0) & (near == 0)).sum()) / float(H * W)


def cfg_for(hex_value=""):
    c = CourtConfig()
    c.line_color_hex = hex_value
    return c


BLUE = (200, 90, 20)      # BGR
GREEN_COURT = (70, 120, 60)
YELLOW = (40, 210, 235)
DARK_COURT = (60, 55, 55)
WHITE = (245, 245, 245)


def test_white_lines_still_work_with_no_colour_set():
    img, truth = court_image(GREEN_COURT, WHITE)
    mask = line_mask(img, cfg_for())
    assert recall(mask, truth) > 0.8
    assert false_area(mask, truth) < 0.02


def test_blue_lines_are_invisible_to_the_white_path():
    """The point of the whole change: the old mask cannot see these at all,
    and no threshold tweak would help, because 'unsaturated' excludes them
    by construction rather than by degree."""
    img, truth = court_image(GREEN_COURT, BLUE)
    assert recall(line_mask(img, cfg_for()), truth) < 0.1


def test_blue_lines_are_found_when_the_colour_is_given():
    img, truth = court_image(GREEN_COURT, BLUE)
    mask = line_mask(img, cfg_for("#145AC8"))
    assert recall(mask, truth) > 0.8
    assert false_area(mask, truth) < 0.02


def test_yellow_on_dark_is_found():
    img, truth = court_image(DARK_COURT, YELLOW)
    mask = line_mask(img, cfg_for("#EBD228"))
    assert recall(mask, truth) > 0.8
    assert false_area(mask, truth) < 0.02


def test_a_sampled_colour_need_not_be_exact():
    """The eyedropper samples one pixel off a compressed frame, so the value
    it returns is near the paint, not equal to it. A tolerance that only
    accepted exact matches would be useless in the field."""
    img, truth = court_image(GREEN_COURT, BLUE)
    off_by_a_bit = "#2050B8"   # ~14 off in each channel
    assert recall(line_mask(img, cfg_for(off_by_a_bit)), truth) > 0.7


def test_a_large_block_of_the_line_colour_is_rejected():
    """A player in a blue shirt on a court with blue lines. The thinness test
    is what has to catch this -- the colour test cannot, by definition."""
    img, truth = court_image(GREEN_COURT, BLUE, distractor_bgr=BLUE)
    mask = line_mask(img, cfg_for("#145AC8"))
    block = np.zeros((H, W), np.uint8)
    cv2.rectangle(block, (300, 300), (400, 350), 255, -1)
    inner = cv2.erode(block, np.ones((9, 9), np.uint8))
    claimed = float(((mask > 0) & (inner > 0)).sum()) / float((inner > 0).sum())
    assert claimed < 0.05, "the interior of a solid block should not read as paint"


def test_white_given_explicitly_agrees_with_the_white_path():
    """Clicking a white line should not put the fitter on a different code
    path with different behaviour from leaving the colour unset."""
    img, truth = court_image(GREEN_COURT, WHITE)
    default = recall(line_mask(img, cfg_for()), truth)
    sampled = recall(line_mask(img, cfg_for("#F5F5F5")), truth)
    assert abs(default - sampled) < 0.15


def test_white_line_mask_alias_is_the_same_function():
    img, _ = court_image(GREEN_COURT, WHITE)
    c = cfg_for()
    assert np.array_equal(white_line_mask(img, c), line_mask(img, c))


@pytest.mark.parametrize("value,expected", [
    ("#145AC8", (200, 90, 20)),
    ("145AC8", (200, 90, 20)),
    ("#abc", (204, 187, 170)),
    ("", None),
    ("   ", None),
    ("not-a-colour", None),
    ("#12345", None),
    ("#zzzzzz", None),
])
def test_hex_parsing_is_forgiving_and_never_raises(value, expected):
    """A malformed colour costs the run its colour hint, not the run."""
    assert parse_hex_color(value) == expected
