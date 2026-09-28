# UX-1a：从截图量面板底色，算正文 / 次要文字的对比度（WCAG 2.x 相对亮度）
import sys
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")


def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(rgb):
    r, g, b = (lin(x) for x in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def bg_sample(img, box):
    # 取框内最常见的颜色当底色（文字像素占少数）
    region = img.crop(box).convert("RGB")
    colors = region.getcolors(region.width * region.height)
    return max(colors)[1]


for path, box, label in [
    (sys.argv[1], (1290, 700, 1296, 760), "白底"),
    (sys.argv[2], (1290, 700, 1296, 760), "舱壁"),
]:
    img = Image.open(path)
    bg = bg_sample(img, box)
    for name, col in [("正文 #e8e6e1", (232, 230, 225)), ("次要（改前）#9a978f", (154, 151, 143)), ("次要（改后）#b8b4ab", (184, 180, 171))]:
        print(f"{label} {path.split('/')[-3]}  底色 {bg}  {name}: {contrast(col, bg):.2f}:1")
