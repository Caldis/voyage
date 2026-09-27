# 火车线路烘焙报告（TR01）· JR 大糸線 松本—信濃大町

> 实现代理产出，2026-09-27。脚本在 `apps/voyage/scripts/rail/`，产物在 `apps/voyage/public/data/rail/`。
> 本报告里的数量都出自产物 JSON 的 `stats` / `report` 字段，重跑脚本后以 JSON 为准。
> 标「未核实」的是没找到可靠出处的事实，没有猜。

## 0. 结论

- 中心线：OSM 量出 **35.08 km**，营业キロ是 35.1 km。20 个车站投影到里程后，和营业キロ的偏差**全部在 ±0.1 km 以内**（最大是北松本 +0.09 km）。这条走廊可以直接当 TR02 的 s 轴。
- 线路标签很全：电化 `contact_line` / 1500 V / `frequency=0` 覆盖 99.6% 的长度，轨距 1067 覆盖 100%。只有松本站场里的 125 m 没标电化。
- 中景数据**很不均匀**：
  - 建筑只在松本站前、豊科、穂高、细野—信濃松川、信濃大町有；平原中段大片空白。
  - 土地利用在 ±500 m 带内的覆盖率大多不到 20%，29–32 km 是 0。
  - 这些缺口正是 TRAIN.md §8 预见的风险，要由 TR05 用国土数值情报兜底或程序化补，**本期没有补**。
- 地形：国土地理院 DEM5A 覆盖了 99.9% 的中心线点；剩下的落在 DEM5A 的空洞里，改用 DEM10B（`dem_png`）补上。走廊高程网格没有空格。
- 事实核对：
  - 营运最高速度 95 km/h（二手出处）。
  - 定尺钢轨还是长轨化：**未核实**。
  - 最大超高：解释基准只给了公式，没有固定值；105 mm 这个数**未核实**。
  - 站间距：有出处，见 §5。

## 1. 数据来源与许可

| 数据 | 来源 | 许可与署名 | 用法 |
| --- | --- | --- | --- |
| 线路、车站、道口、桥、站台、建筑、土地利用、道路、水系、电力线 | OpenStreetMap，Geofabrik 中部包 `chubu-260926.osm.pbf`（2026-09-26 数据，511 MB，MD5 `4533e2cd003378ec1ef42f8ac5958aeb` 与官方 .md5 一致） | **ODbL 1.0**，署名「© OpenStreetMap contributors」。烘焙产物是衍生数据库，对外发布时同样按 ODbL 提供 | `extract_osm.py` 用 pyosmium 离线读取，**没有用公共 Overpass** |
| 高程 | 国土地理院 标高タイル：DEM5A（`dem5a_png`，z15）为主，缺值时依次用 DEM5B、DEM5C、DEM10B（`dem_png`，z14） | [国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)（与 CC BY 4.0 兼容）。加工品署名「地理院タイル（標高タイル）を加工して作成」 | `dem.py`：瓦片缓存到本机，每张只请求一次，请求间隔 50 ms |
| 车站营业キロ、营运最高速度 | [Wikipedia「大糸線」](https://ja.wikipedia.org/wiki/%E5%A4%A7%E7%B3%B8%E7%B7%9A) 路線データ与駅一覧 | CC BY-SA，只引用事实数字 | 用来对照 OSM 量出的里程 |
| 超高规定 | 国土交通省「鉄道に関する技術上の基準を定める省令等の解釈基準」（国鉄技第 157 号，[PDF](https://www.mlit.go.jp/common/001968198.pdf)）Ⅲ－４ 第 15 条（カント）関係 | 政府公开文件 | 只引用条文 |

**为什么不用现有管线的 AWS Terrain Tiles**：日本境内 AWS Terrain 的底层数据也来自地理院，但重采样到了 Web 墨卡托瓦片，z15 下约 3–4 m 一个像素，而且经过了混合与重投影；路堤、路堑、河岸这种几米的高差会被抹平。火车近景要的正是这些高差，所以直接用地理院原始的 5 m 网格。远景仍用现有管线（TR03 决定），两者不冲突。

外部请求的 User-Agent 是通用值 `voyage-rail-bake/1.0 (+offline data bake; OSM/GSI)`，不含个人信息。

## 2. 产物格式

两个文件：`oito-matsumoto-shinanoomachi.json`（元数据，57 KB）和 `oito-matsumoto-shinanoomachi.bin`（小端二进制，2.71 MB，gzip 后约 1.65 MB）。

读法：`json.arrays.<名字> = {type, offset, length, desc}`，对应 `new Float32Array(buf, offset, length)` 这类视图。每个数组按 8 字节对齐，每个数组的含义都写在自己的 `desc` 里。`scripts/rail/verify.mjs` 就是按前端的方式读的，可以当参考实现。

坐标约定：
- `x` / `y`：以松本站 OSM 节点为切点的局部 ENU 平面，单位米，x 向东、y 向北。35 km 内与真实距离的偏差小于 0.5 m。
- `z`：国土地理院标高，单位米，以东京湾平均海面为零点。它**不是** ENU 的 up 分量；地球曲率带来的下沉由前端自己处理。
- `s`：沿本线中心线量的里程，单位米。s = 0 是松本站节点的投影，往信濃大町方向增大。
- `d`：横向偏移，单位米。正值在行进方向（往信濃大町）的左侧。

| 数组组 | 内容 |
| --- | --- |
| `center.*`（17,540 点，每 2 m 一点） | `x`、`y`、`s`；`zGround`（DEM 地表，桥下是河床）；`zRail`（轨面近似）；`grade`（‰）；`heading`；`curvature`（1/m）；`flags`（位标志：桥 1 / 隧道 2 / 路堤 4 / 路堑 8 / 站台 16 / 道口 32 / 电化 64 / 多股道 128 / 属于 route 关系 256）；`tracks`（法线 ±12 m 内的股道数） |
| `grid.z` | 走廊高程网格：3,508 行（每 10 m 一行）× 101 列（d 从 −500 到 +500，每 10 m 一列），int16，单位 0.1 m |
| `masts.*`（855 根） | 接触网支柱的 `s`、`d`、`source`。**全部是程序生成的示例**（source = 0），见 §4 |
| `buildings.*`（5,800 栋） | 多边形（`verts` / `ringStart` / `ringHole` / `featRing`）、`cls`、`s`、`d`、`levels`、`height`、`roof`；按 s 排序，方便按块流式加载 |
| `landuse.*`（2,119 块） | 多边形已裁到走廊内，简化容差 0.3 m；`cls` 是类别下标 |
| `road.*` / `water.*` / `power.*` / `barrier.*` | 折线（`verts` / `featStart`）、`cls`、`s`；道路另有 `struct`（桥 / 隧道）和 `lanes`，电力线另有 `voltage` |
| `powerPts.*`（297 个） | 电力铁塔 / 电杆的点 |

JSON 里直接放的小列表有：`stations`（含站台区间）、`platforms`、`levelCrossings`、`bridges`、`tunnels`、`embankments`、`cuttings`、`overpasses`（跨线桥）、`underpasses`（线下通道）、`waterCrossings`（跨水）。

几个处理细节：
- **轨面 `zRail`**：DEM 是地表。在桥上，地表是河床，所以桥段（两端各加 6 m）改用两端桥台的高程线性插值，再做 σ = 30 m 的平滑。
- **`grade`**：对 `zRail` 再做 σ = 50 m 的平滑后求导。它是**由 DEM 推出来的**，不是设计纵断面。
- **`curvature`**：由 OSM 折线求导，σ = 15 m 平滑，不是设计值。OSM 折线在站场的咽喉区会有小折角，局部曲率偏大。
- **超高**：没有烘焙。OSM 里没有 `cant` 标签，这条线也没有公开的超高资料（见 §5）。TR02 要按曲率自己估算，并标明是估算。

## 3. 各类要素数量与缺失

### 3.1 线路本身

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 路径 | 84 条 way、466 个节点，35,080 m | 在铁路图上从松本站到信濃大町站求最短路。`route` 关系成员的权重是 1，非成员是 2，侧线 ×3，站场 ×10。途经的 way 全都叫「JR大糸線」 |
| route 关系 | 3 个 | `JR大糸線`（248 条 way）、两个方向的 `JR大糸線 (松本 => 南小谷)` / `(南小谷 => 松本)`（各 141 条） |
| 电化 | `electrified=contact_line`、`voltage=1500`、`frequency=0`，共 34,955 m（99.6%） | 余下 125 m 在松本站场里，没标 |
| `maxspeed` | **全线未标** | 最高速度的出处见 §5 |
| 桥 | 24 处（`bridge=yes`，共 1,175 m），**全部没有桥名** | 跨水点与桥的对照见 3.3 |
| 隧道 | 0 | OSM 里这一段没有 `tunnel`；要做 TR10，得等第二条线 |
| 路堤 / 路堑 | 0 | OSM 没标 `embankment` / `cutting`，不是没有路堤。高差可以从 `grid.z` 与 `zRail` 的差看出来 |
| 多股道 | 全长的 13%（`tracks ≥ 2`） | 没有逐段核对是站场、交会站还是与其他线并行；股道数分布：1 股 15,264 点，2 股 1,701 点，3 股 338 点，4 股及以上 237 点 |
| 纵断面 | 轨面 536.0–714.8 m；坡度绝对值最大 22.1‰（s ≈ 30.6 km，信濃常盤附近），99 分位 18.7‰；坡度超过 10‰ 的长度约 13.8 km，超过 20‰ 的约 0.1 km | 由 DEM 推出，不是设计值 |
| 最小半径 | 约 242 m（s ≈ 32.8 km）；半径 < 400 m 的长度约 1.2 km，< 600 m 的约 2.7 km | 由 OSM 折线推出 |

### 3.2 车站、站台、道口

- **车站**：20 / 20 都在 OSM 里找到了 `railway=station` 节点。
- **站台**：离中心线 25 m 内共 19 段站台几何。下面 9 个站离中心线 25 m 内**没有 `railway=platform` 几何**：島高松、梓橋、一日市場、中萱、南豊科、柏矢町、安曇沓掛、信濃常盤、南大町。这 9 个站的站台位置没有补。
- **道口**：
  - 走廊里有 104 个 `railway=level_crossing` 节点。站场里同一条路跨几股道时每股一个节点，沿 s 相距 10 m 以内的合并后是 **91 处道口**，其中 12 处由多个节点合成。
  - 标了细节标签的很少：`crossing:barrier` 10 处，`crossing:bell` 9 处，`crossing:light` 9 处，`name` 3 处。其余只有 `railway=level_crossing`。
- **道路与线路平面相交、但 12 m 内没有道口节点的**：11 处，列在 JSON 的 `report.roadGradeCrossingsWithoutNode`。按道路类型分：
  - `path` 4 处；
  - `track` 3 处；
  - `cycleway` 1 处；
  - `tertiary` 1 处（s = 24,911 m，way 153795080）；
  - `unclassified` 1 处（s = 31,340 m）；
  - `residential` 1 处（s = 31,594 m）。

  可能是漏标的道口，也可能是道路其实从桥下或涵洞穿过、只是没标 layer。**没有核实，也没有当成道口烘焙进去。**
- **有道口节点、但附近没有道路相交的**：信濃大町站南侧站场里 2 组（4 个节点，s ≈ 34,727 m、34,867 m）。这两组节点在站场侧线上，道路可能只和侧线相交，所以和本线中心线对不上。

### 3.3 跨线桥与跨水

- **跨线桥**（道路 `bridge=yes` 跨过本线）：16 条 way。
  - 其中有长野自動車道（s ≈ 3.36 km）、松本バイパス（1.61 km）、国道 147 号（20.50 km、29.01 km、34.82 km）。
  - 还有松本站的自由通路（s ≈ 0 km）。
- **线下通道**：22 条。9 条是道路自己标了 `tunnel`，13 条是道路从铁路桥下穿过。
- **跨水**：31 处。有名字的 10 条河、堰里，9 条落在铁路桥上：女鳥羽川、奈良井川、梓川、捨ヶ堰、新田堰、万水川、烏川、穂高川、高瀬川；大門沢川标的是暗渠（`tunnel=culvert`）。
  - 5 处没标暗渠的小溪、水沟**不在铁路桥上**（s ≈ 7.41、13.03、24.91、27.87、32.59 km）。多半是 OSM 没标的涵洞，没有核实。

### 3.4 走廊两侧（±1.5 km，面积 112 km²）

**建筑**：走廊里有 5,800 栋，bbox 里一共 12,341 栋。
- 属性覆盖很低：`building:levels` 213 栋（3.7%），`height` 0 栋，`roof:shape` 49 栋。
- 类型以 `yes` 为主（5,178 栋）；其次是 `house` 140、`greenhouse` 127、`industrial` 73、`retail` 70、`school` 60。
- 离线路 300 m 以内的建筑，按公里数：

| km | 0 | 1–5 | 6 | 7–10 | 11 | 12–15 | 16 | 17–21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29–32 | 33 | 34 | 35 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 栋数 | 268 | ≤ 4 | 18 | ≤ 7 | 114 | ≤ 5 | 12 | ≤ 1 | 47 | 231 | 212 | 494 | 279 | 117 | 23 | 0 | 7 | 97 | 28 |

也就是说，**1–10 km、12–21 km、29–33 km 基本没有建筑轮廓**。这几段现实中有没有房子**没有核实**（没看航拍）；按常识，安昙野平原上有散落的农家，所以更可能是 OSM 没画，不能当成「这里没有房子」来用。

**土地利用**：2,119 块。
- 主要类别：`landuse=farmland` 1,107 块、13.9 km²；水面 `natural=water;water=river` 3.6 km²；`natural=wood` 2.5 km²。
- 标了 `crop=rice` 的只有 5 块。水田与旱地在 OSM 里分不开，TR05a 要靠别的来源区分。
- 走廊总覆盖率的上限只有 22.5%（各类面积相加，没有去重）。
- ±500 m 带内按公里的覆盖率：12–13 km、23–27 km 在 40–67%；**18–19 km 和 29–32 km 是 0–0.1%**；其余大多在 20% 以下。

**道路**：13,144 条。`unclassified` 3,527、`residential` 3,029、`service` 2,038、`footway` 1,596、`track` 1,229、`tertiary` 668，其余更少。

**水系**：1,171 条。`stream` 719、`canal` 157、`ditch` 134、`drain` 106、`river` 55。

**电力**：
- `power=line` 35 条，都是输电线；`power=minor_line`（配电线）**0 条**。
- 铁塔 275 座，`power=pole` 只有 21 根。
- 这和 TRAIN.md §3.2 的预估一致：配电杆要按道路程序化放置。

**墙 / 围栏**：135 条。`wall=noise_barrier`（隔音墙）0 条。

**接触网支柱**：OSM 里 `railway=catenary_mast` 是 **0**。
- 产物里的 855 根全部是**程序生成的示例**，用来给出节奏，位置不是真实的。
- 生成规则：径间上限 50 m（JRTT）；弯道按 √(8·R·0.2 m) 缩短（估）；随机缩短 0–12%；避开道口 ±6 m；两站之间随机选一侧。

### 3.5 高程

- 中心线 17,540 点：DEM5A 17,520 点；其余 20 点落在 DEM5A 的空洞里（DEM5A 在水面上通常没有值），用 DEM10B 补上。
- 走廊网格 354,308 格：计数器是中心线与网格累计的：DEM5A 共 370,712 次（含中心线 17,520 次），DEM10B 补了 1,136 次，**无数据 0 格**。
- DEM5B / DEM5C 在这一带请求到的瓦片是 404，实际取样全部来自 DEM5A 和 DEM10B。
- `zGround` 与 `zRail` 之差的绝对值，99 分位是 6.0 m。主要来自桥下河床，以及平滑掉的路堤、路堑边缘。

## 4. 生成的（非真实）内容

| 内容 | 说明 |
| --- | --- |
| `masts.*` 中 source = 0 的全部 855 根 | 程序生成的示例，见 §3.4 |
| `center.curvature` / `grade` / `zRail` | 由 OSM 折线和 DEM 推算，不是设计值 |
| 没烘焙的（以后的任务要补、要标注） | 超高、钢轨接缝位置、站台缺失的 9 个站、建筑空白段、土地利用空白段、配电杆 |

## 5. TRAIN.md「待核」事实的核对

| 事实 | 结论 | 出处 / 说明 |
| --- | --- | --- |
| 营运最高速度（松本—信濃大町） | **95 km/h**（信濃大町—南小谷是 85 km/h） | [Wikipedia「大糸線」](https://ja.wikipedia.org/wiki/%E5%A4%A7%E7%B3%B8%E7%B7%9A) 路線データ。这是二手出处；JR 东日本的一手资料没有找到。OSM 没有 `maxspeed`。TRAIN.md 第一期按恒速 90 km/h 设计，没有超过这个上限 |
| 是否仍有定尺钢轨（25 m）/ 已长轨化 | **未核实** | 检索「大糸線 ロングレール」只找到 JR 西日本段（真那板山隧道）的长轨记载，没有找到本段（JR 东日本管内）的资料。「ガタンゴトン」要不要做、按什么间距做，TR07 要按「示意」处理，或者等拿到行车录音再核对。定尺 25 m 这个一般事实有出处（[民鉄協「レール」](https://www.mintetsu.or.jp/knowledge/term/16489.html)），但它不等于本段现在的状况 |
| 接缝是相对式还是相互式 | **未核实** | 没有找到本线资料 |
| 最大超高 | **规范只给公式，没有固定值；「在来线最大 105 mm」未核实** | 解释基准 Ⅲ－４ 第 15 条：标准值 **C = G·V² / (127·R)**（G：轨距 mm；V：通过该曲线的列车平均速度 km/h；R：半径 m），且 **C ≤ G² / (6·H)**（H：轨面到车辆重心的高度 mm）。原文里没有 105 mm 这个固定数；它可能出自各铁路公司的实施基准，没有找到原文。本线各曲线的实际超高**未核实**，OSM 也没有 `cant` 标签 |
| 站间距 | 营业キロ：最短 0.7 km（松本—北松本），最长 3.1 km（信濃常盤—南大町），平均 1.85 km（19 个区间） | Wikipedia 駅一覧的营业キロ。OSM 量出的车站里程与之相差不超过 ±0.09 km，逐站对照见 `node scripts/rail/verify.mjs` 的输出 |
| 线路形态 | 全线单线；直流 1,500 V 电化；轨距 1,067 mm | Wikipedia 路線データ；OSM 标签一致（`voltage=1500`、`frequency=0`、`gauge=1067`） |
| 接触网径间约 50 m | 沿用 TRAIN.md 引的 JRTT；本线实测**未核实**（OSM 没有支柱数据） | [JRTT「電車線」](https://www.jrtt.go.jp/construction/technology/catenaries.html) |

## 6. 怎么重跑

```bash
# 建环境（Python 3.12；3.14 没有 shapely / osmium 的 wheel）
uv venv --python 3.12 apps/voyage/scripts/rail/.venv
uv pip install --python apps/voyage/scripts/rail/.venv/Scripts/python.exe -r apps/voyage/scripts/rail/requirements.txt

# 缓存目录（原始包约 500 MB）；不设时默认是 scripts/rail/cache/（已被忽略）
export VOYAGE_RAIL_CACHE=D:/Code/opus-test/tmp/rail-cache   # 仓库里被 .gitignore 忽略的 tmp/，多个 worktree 共用

cd apps/voyage/scripts/rail
.venv/Scripts/python extract_osm.py   # 第 1 步：读 Geofabrik 包，没有就自动下载；约 13 分钟（见 §7）
.venv/Scripts/python bake.py          # 第 2 步：烘焙 + DEM 取样；首次要下约 90 张地理院瓦片，约 2 分钟；有缓存时约 1 分钟
node verify.mjs                       # 第 3 步：像前端那样读产物，打印统计并自检
```

## 7. 踩到的坑

- **Geofabrik 下载慢，还会中途断**：
  - 现象：约 170 KB/s；Git Bash 里的 curl 偶发 `schannel: failed to receive handshake`，并且带着 `-s` 静默失败，留下空目录。
  - 修法：用 Windows 的 `curl.exe --retry 10 --retry-all-errors -C -` 续传；下载完和官方 .md5 对一遍。
  - 以后怎么识别：下完先看文件大小，再核 MD5。
- **地理院 DEM10B 的 PNG 图层名是 `dem_png`，不是 `dem10b_png`**：
  - 现象：`dem10b_png` 全部 404，DEM5A 的空洞（河面）补不上，网格里出现 1,116 个无数据格。
  - 修法：改成 `dem_png`（z14）。
  - 以后怎么识别：看 `report.demGrid.hits` 里最后一级的命中数是不是 0。
- **Python 里的 `Path.write_text` 在 Windows 上会写成 CRLF**：
  - 现象：产物 JSON 带 `\r\n`，提交时 git 提示换行会被转换。
  - 修法：编码后用 `write_bytes` 写入，固定 LF。
- **scratchpad 里的脚本不能叫 `inspect.py`**：它会遮蔽标准库，numpy 导入时报 `module 'inspect' has no attribute 'cleandoc'`。
- **pyosmium 在 Python 里逐个对象过滤很慢**：中部包 8,000 万个对象，第一版要 20 分钟（1,169 s）。加了 `EmptyTagFilter` 后，没有标签的节点不再交给 Python，降到 13 分钟（776 s），输出的各类数量完全一致。剩下的时间估计花在逐条 way 的 bbox 判断和多边形组装上（没有剖析）。
- **可重复性**：同一份输入重跑 `bake.py`，产物 `.bin` 逐字节一致（MD5 相同）。接触网支柱的随机数种子是固定的（`SEED = 20260927`）。

## 开发体验反馈

- **哪里慢**：
  - Geofabrik 中部包下载了约 25 分钟，占总时长的三成多，中途还遇到 TLS 握手失败。
  - osmium 全量扫描要 13–20 分钟；调 `bake.py` 只需约 1 分钟，因为读的是中间 JSON。
- **哪里卡**：
  - 地理院 DEM10B 的图层名（`dem_png`）和其他 DEM 的命名规律不一样，第一次跑时静默 404。靠报告里的命中计数才发现。
  - 回报进度的消息要用 `SendMessage`，需要先用 ToolSearch 加载，简报里没提。
  - 带 heredoc 的复合命令会被 worktree 隔离检查拒绝，只能拆开写。
- **怎么绕过的**：
  - 原始包放在 `tmp/rail-cache`（已被忽略），用 `VOYAGE_RAIL_CACHE` 指过去，多个 worktree 共用，不重复下载。
  - 提取和烘焙拆成两步，中间 JSON 落盘，烘焙可以反复调。
- **希望有**：
  - 仓库里有一个共享的「大文件缓存目录」约定（例如 `tmp/cache/<用途>/`），写进 AGENTS.md，别的数据任务可以直接复用。
  - 简报模板里写一句「中途回报用 SendMessage（先 ToolSearch 加载）」。
