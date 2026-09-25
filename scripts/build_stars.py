"""把耶鲁亮星表（BSC5，公有领域）转成紧凑的 JSON，给夜空渲染用。

数据源：CDS VizieR V/50「The Bright Star Catalogue, 5th Revised Ed.」(Hoffleit & Warren 1991)
    https://cdsarc.cds.unistra.fr/ftp/cats/V/50/catalog.gz
字段位置按同目录的 ReadMe（Byte-by-byte Description of file: catalog）：
    RA J2000 76-83，Dec J2000 84-90，Vmag 103-107，B-V 110-114（1 起算，含两端）
被撤销的星（坐标为空）跳过；缺 B-V 的按 0.6（类太阳）处理并计数。

用法：python scripts/build_stars.py    输出 public/data/bsc5.json：[[赤经°, 赤纬°, V 星等, B-V], ...]
"""
import gzip
import json
import pathlib
import urllib.request

URL = "https://cdsarc.cds.unistra.fr/ftp/cats/V/50/catalog.gz"
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "data" / "bsc5.json"


def field(line: str, a: int, b: int) -> str:
    return line[a - 1 : b].strip()


def main() -> None:
    # 请求头里不带任何个人信息
    req = urllib.request.Request(URL, headers={"User-Agent": "voyage-star-catalog-build"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = gzip.decompress(resp.read()).decode("ascii", errors="replace")

    stars = []
    skipped = 0
    no_bv = 0
    for line in text.splitlines():
        line = line.ljust(197)
        rah, ram, ras = field(line, 76, 77), field(line, 78, 79), field(line, 80, 83)
        vmag = field(line, 103, 107)
        if not rah or not vmag:
            skipped += 1
            continue
        ra = (int(rah) + int(ram) / 60 + float(ras) / 3600) * 15
        sign = -1 if field(line, 84, 84) == "-" else 1
        dec = sign * (int(field(line, 85, 86)) + int(field(line, 87, 88)) / 60 + int(field(line, 89, 90)) / 3600)
        bv_s = field(line, 110, 114)
        if bv_s:
            bv = float(bv_s)
        else:
            bv = 0.6
            no_bv += 1
        stars.append([round(ra, 4), round(dec, 4), float(vmag), bv])

    stars.sort(key=lambda s: s[2])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(stars, separators=(",", ":")), encoding="utf-8")
    print(f"写入 {len(stars)} 颗星 → {OUT}（跳过 {skipped} 条已撤销，缺 B-V {no_bv} 颗）")
    print(f"最亮：{stars[0]}，最暗星等 {stars[-1][2]}")


if __name__ == "__main__":
    main()
