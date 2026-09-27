# 地面影像：能不能换成 / 混用更高清的卫星或航空影像

> 研究代理产出（R-IMAGERY），2026-09-27。本文只是研究文档，没有改 `src/`。
> 标「估」的数字是估算（脚本 `tmp/imagery-test/calc.py`），标「实测」的数字来自 `tmp/imagery-test/` 里的脚本和瓦片，标「原文」的是条款或官方页面上的原话（附链接）。查不到原文的写「未核实」。
> 测试瓦片、拼图和脚本都在 `D:\Code\opus-test\tmp\imagery-test\`（已被 `.gitignore` 的 `tmp/` 覆盖，不提交）。请求头只用了通用 UA `voyage-imagery-research/0.1`，没有带任何个人信息。

用户原话：「对于地面的贴图，我们有没有可能用一些地图软件的卫星图直接贴？例如之前做过的 OSM 里面的那个卫星图层的方式能用在这吗？这样的话我们的地面贴图不是会清晰很多吗？」

---

## 0. 结论先行

1. **技术上能用，但在巡航高度直接换源，画面不会明显变清晰。** 瓶颈是 clipmap 的纹素密度，不在影像源。
   - 巡航 10.7 km、标准坐姿视角下，窗里能看到的地面在俯角 3.3°–25° 之间，水平距离约 23–265 km，落在 clipmap 的第 3–6 级。这几级每个纹素 53–500 m（估）。
   - 同一位置上，一个屏幕像素的横向足迹比纹素细 **2.4–3 倍**（画布高 1200），默认 DPR 1.5 时细 **3.6–4.4 倍**（估，§1）。也就是说，现在的纹理本来就比屏幕粗 3 倍左右，Sentinel-2 的 10 m 在这些级别上完全够用。
   - 高清源能起作用的只有最细的 0–2 级（纹素 7.8–31 m，距离 < 14 km）。巡航时只在「看机翼」视角的画面下沿看得到；低空（离地 2.5–4 km）时是画面下半部分。
   - 另外，Esri World Imagery 在 z11 及更粗的级别（第 3 级往上）用的是 15 m 的 TerraColor（原文，§2.1），比 EOX 的 10 m 还粗。
2. **成本最低、马上见效的一步：把 EOX Sentinel-2 cloudless 从 2020 版换成 2024 版（或 2025 版）。** 许可相同（CC BY-NC-SA 4.0，原文），URL 只改一个年份。实测在 z12 / z14 上的相对梯度能量约是 2020 版的 **1.8 倍**，边缘明显更锐，也没有新的请求量和许可风险（§3）。→ **G01**
3. **高清源值得接，但要当作「低空和近处的细节层」来做，放在 clipmap 最细的 0–1 级（可选第 2 级）**，远处仍用 EOX。
   - 日本航线首选 **国土地理院 シームレス空中写真**：不需要 key，`Access-Control-Allow-Origin: *`，允许商用，实时读取时只需注明出处（原文）。缺点是拼接缝和色调跳变明显，需要做色调迁移。
   - 其他地区（包括长江中下游）只能用 **Esri World Imagery**，技术上直接可用（无 key、CORS `*`），但许可是灰区：旧的 `server.arcgisonline.com` 端点受 Esri Master License Agreement 约束，Esri 自己写着「不用于导出离线」（原文）。正规做法是走 ArcGIS Location Platform：要注册账号、用 access token，每月 200 万张瓦片免费（原文）。**这一步要用户拍板。**
   - Google（包括直接取 `mt.google.com`）、Mapbox、Bing 都不适合本项目（§2 的表）。
4. **混用的做法**：在 Worker 里做「高清源的高频 + EOX 的低频」，把合成结果写进同一张影像纹理。着色器、sampler、冷编译都不动。云、拼接缝、占位图标成缺瓦片（A < 0.5），让现有的回退逻辑退到粗一级 EOX（§4）。
5. **想让巡航画面整体变清晰，要改 clipmap 本身**：clipmap 中心往窗外一侧偏移，最细几级改用 2048²，再配各向异性过滤（纹理 RGB 用 textureGrad 取样，A 通道仍按第 0 级读）。这会动着色器，所以要按铁律「锯齿 / 闪烁优先」量闪烁和冷编译。→ **G06**。做完之后，高清源的价值才会在巡航时也显现出来。

**推荐顺序**：G01（换 EOX 2024）→ G02（影像源抽象 + 负缓存 + 节流）→ G03（日本用 GSI 混入 0–1 级，色调迁移）→ 用户决定 Esri 之后做 G04（其他地区）→ G06（clipmap 密度 + 各向异性，最大的一步）。

---

## 1. 清晰度到底差多少

### 1.1 现有参数（按代码核对）

| 量 | 值 | 出处 |
| --- | --- | --- |
| 竖直视场 | 50°（`tan 25°`） | `research/PARAMS.md`；`src/render/scene.ts`（`uTanHalfFov`） |
| 像素角 | 画布高 1200：0.777 mrad；DPR 1.5 下画布高 1800：0.518 mrad | `2·tan25°/uResolution.y`（`terrain-shading.glsl.ts` 的 `groundHit`） |
| clipmap | 7 级，边长 8 → 512 km，每级 1024²；第 L 级纹素 = 7.8 m × 2^L | `src/ground/clipmap.ts:15-18` |
| 选级规则 | `lod = max(log2(距离·2/(0.85·8 km)), log2(横向足迹·1024/(1.5·8 km)))`，相邻两级线性混合 | `src/render/ground.glsl.ts:23` `groundLod` |
| 影像缩放级 | 按纹素选：第 0 级 z14，第 1 级 z13，第 2 级 z12……，`IMAGERY_MAX_ZOOM = 14` | `clipmap.ts buildImagery`、`tiles.ts:18` |
| 纹理过滤 | `LinearFilter`，**没有 mipmap**；着色器一律 `textureLod(…, 0.0)` | `clipmap.ts` 构造函数、`ground.glsl.ts` |
| 视线方向 | 相机看向窗板中心，标准坐姿基本是水平视线，画面竖直覆盖 ±25°；「看机翼」预设头抬高 0.14 m、离窗 0.26 m，视线下俯约 28°，画面覆盖俯角约 3°–53°（估） | `src/view-presets.ts` |

### 1.2 屏幕像素足迹和纹素对比（估，`calc.py`，球面几何）

横足迹指像素在地面上垂直于视线方向的宽度，纵足迹指沿视线方向的长度（纵 ≈ 横 / sin 入射角）。「纹素」按 `groundLod` 的连续级别计算。

**巡航 10.7 km，画布高 1200（1600×1200，DPR 1）**

| 俯角 | 水平距离 | 横足迹 | 纵足迹 | 所在级 | 纹素 | 纹素 / 横足迹 |
| --- | --- | --- | --- | --- | --- | --- |
| 3.5° | 265 km | 207 m | 10.6 km | 6 | 500 m | 2.4 |
| 5° | 140 km | 109 m | 1.7 km | 5.4 | 321 m | 3.0 |
| 8° | 80 km | 63 m | 493 m | 4.6 | 183 m | 2.9 |
| 12° | 51 km | 41 m | 204 m | 3.9 | 118 m | 2.9 |
| 17° | 35 km | 29 m | 100 m | 3.4 | 81 m | 2.8 |
| 25°（标准视角画面下沿） | 23 km | 20 m | 47 m | 2.8 | 53 m | 2.7 |
| 35° | 15 km | 15 m | 25 m | 2.2 | 35 m | 2.4 |
| 50°（看机翼视角下沿） | 9 km | 11 m | 14 m | 1.4 | 21 m | 1.9 |
| 90°（正下方，窗里看不到） | 0 | 8.3 m | 8.3 m | 0 | 7.8 m | 0.9 |

- DPR 1.5（画布高 1800）时，最后一列整体乘约 1.5，是 **3.6–4.4**。
- **低空 4 km**：俯角 8° / 17° / 25° / 35° / 50° 处，纹素分别是 67 / 30 / 20 / 13 / 7.8 m，横足迹分别是 23 / 11 / 7.4 / 5.4 / 4.1 m，比值同样是 2.4–2.9（DPR 1）。
- **低空 2.5 km**（T18 陆地高度下限大约就在离地这个量级）：俯角 12° / 25° / 50° 处，纹素分别是 27 / 12 / 7.8 m，横足迹分别是 9.4 / 4.6 / 2.5 m。俯角大于 35° 后已经在第 0 级，比值升到 3–4，**第 0 级的 7.8 m 纹素本身成了上限**。

### 1.3 各级分别在看什么（估）

按 `groundLod` 的距离项，每一级的外边界是 3.4 km × 2^L。换算成俯角：

| 级 | 纹素 | 源缩放 | 10.7 km 时的俯角 | 4 km 时 | 2.5 km 时 |
| --- | --- | --- | --- | --- | --- |
| 0 | 7.8 m | z14 | > 72°（窗里看不到） | > 50°（看机翼视角的下沿） | > 36° |
| 1 | 15.6 m | z13 | 58–72°（看不到） | 30–50° | 20–36°（标准视角下沿） |
| 2 | 31 m | z12 | 38–58°（看机翼视角的下半） | 16–30°（标准视角下半） | 10–20° |
| 3 | 62 m | z11 | 22–38° | 8–16° | 5–10° |
| 4–6 | 125–500 m | z10–z8 | 3.3–22°（标准视角的全部地面） | < 8° | < 5° |

### 1.4 结论

- **巡航、标准视角**：看到的全是第 3–6 级，纹素 62–500 m，源缩放 z11 及更粗。在这个尺度上，Sentinel-2 的 10 m 是降采样后使用，**影像源不是瓶颈**，瓶颈是 clipmap 纹素，比屏幕粗约 3 倍。换成 0.5 m 的影像，这部分画面只会多一些由拍摄季节和阴影带来的反差，分辨率不会变。
- **巡航、看机翼视角的下半部分，以及低空 2.5–4 km 的画面下半部分**：会用到第 0–2 级，纹素 7.8–31 m。Sentinel-2 在第 0 级（z14，7.8 m/px）上其实是把 10 m 放大后再用，本身已经发糊。这里换成高清源会**明显更清晰**（实测见 §3）。
- **为什么纹素比屏幕粗 3 倍**：clipmap 以飞机正下方为中心，每级的方块有一半落在身后和另一侧的窗外，细级别的覆盖半径只有边长的 0.425 倍（`0.85·GROUND_BASE` 那一项）。另外，因为没有 mipmap 和各向异性过滤，粗的距离级别同时在帮忙压住沿视线方向的欠采样：斜看时纵足迹是纹素的 2–20 倍，每个像素只取一次双线性样本。单纯把纹素调细，沿视线方向的闪烁会变严重。所以 G06 要把「提高纹素密度」和「各向异性过滤」放在一起做。
- 用户说的「OSM 里那个卫星图层」就是 `apps/roadmap/src/basemap/googleStyle.ts:440` 用的 Esri World Imagery（`server.arcgisonline.com/.../World_Imagery/MapServer/tile/{z}/{y}/{x}`）。roadmap 是平面地图，屏幕像素和影像像素一比一对应，所以看起来很清晰；舷窗是斜看几十到几百公里外，情况完全不同。

---

## 2. 候选影像源

### 2.1 逐个核对（原文 + 实测）

**EOX Sentinel-2 cloudless（现用 2020 版）**

- 许可（原文，来自 `https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml` 各图层的 Abstract）：
  - 2020 版：「EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020) released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License. For commercial usage please see https://cloudless.eox.at」。
  - 2018、2019、2021–2025 各版的写法相同，都是 CC BY-NC-SA 4.0。
  - 2016 版（图层名 `s2cloudless`）和 2017 版是「Creative Commons Attribution 4.0 International License」，可以商用，但数据旧。
- 可用图层（实测，GetCapabilities）：`s2cloudless-2017` 到 `s2cloudless-2025` 都有 `_3857` 版本。z14–z17 都能返回 200，但原生分辨率是 10 m，z14 以上只是放大。
- CORS（实测）：回显 Origin，`access-control-allow-origin: http://127.0.0.1:5181`；`cache-control: max-age=604800`。
- 限流：T19a 实测 60× 时每分钟约 7000 次请求会被拒（README「地面与数据」）。官方额度未核实。

**Esri World Imagery**

- 分辨率与来源（原文，`services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json` 的 description）：「The map includes 15m TerraColor imagery at small and mid-scales (~1:591M down to ~1:288k) for the world. The map features Vantor imagery at 0.3m resolution for select metropolitan areas around the world, 0.5m resolution across the United States and parts of Western Europe, and 1m resolution imagery across the rest of the world.」
  - 1:288k 大约对应 z11，所以 **z11 及更粗的级别是 15 m TerraColor**。
  - copyrightText 原文：「Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community」。roadmap 里的署名还写着「Maxar」，这家公司已经更名为 Vantor，下次动 roadmap 时顺手改。
- 许可（原文，ArcGIS Online 条目 `10df2279f9684e4a9f6a7f08febac2a9` 的 licenseInfo）：「This work is licensed under the Esri Master License Agreement. … Export: This layer is not intended to be used to export tiles for offline. If you would like to export imagery for offline use in ArcGIS applications, you may use the World Imagery (for Export) layer」。
- **是否允许不带 key 直接取 `server.arcgisonline.com`：未核实到 Esri 的原文授权。**
  - 实测不带 key 能取到，CORS 是 `*`，`Cache-Control: max-age=86400`。
  - 社区资料的说法是「非商用免费、商用需授权」，例如 [Esri Community 帖子](https://community.esri.com/t5/arcgis-online-questions/terms-of-use-for-http-services-arcgisonline-com/td-p/601874)和 [OSM wiki: Esri](https://wiki.openstreetmap.org/wiki/Esri)。OSM wiki 的转述是「Free use for non-revenue applications requires an ArcGIS Developer account, attribution to Esri and data providers」。这一条是转述，不是 Esri 原文。
  - 结论：旧端点属于灰区，**要用户拍板**。
- 正规途径 ArcGIS Location Platform（原文，[location.arcgis.com/pricing](https://location.arcgis.com/pricing/)）：Basemap tiles「2M free then $0.15 per 1,000 tiles」。按量计费的对象包括 `ibasemaps-api.arcgis.com`（影像瓦片），需要注册账号并使用 access token。
- 署名：要列出数据提供方，另外要有「Powered by Esri」（出自 [Esri and data attribution](https://developers.arcgis.com/documentation/esri-and-data-attribution/)。页面没能抓全，这一句来自搜索摘要，原文未核实）。
- 缺数据（实测）：大洋上 z14、长江 z19 返回的都是 **200 OK + 2521 字节的同一张占位图**（md5 前缀 `f27d9de7`）。**不是 404**，必须在 `loadBitmap` 里识别，否则会把占位图当成地面贴上去。

**国土地理院「全国最新写真（シームレス）」`seamlessphoto`**

- URL（原文，[地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)）：`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`，一览表写的是 z14–18，覆盖日本全国。
  - 实测 z8–z14 也返回 200（低级别由其他源拼成）。z18 约 0.5 m/px（35°N，估）。
  - 来源（原文转述）：电子国土基本图オルソ画像、震后正射影像、林野厅航空照片、地方自治体照片等拼接而成，个别区域用 Landsat-8 和 GRUS。
- 利用条件（原文，同上页面）：「地理院タイルをウェブサイトやソフトウェア、アプリケーション上でリアルタイムに読み込んで利用する場合、地理院タイルは出典の明示のみで申請不要でご利用いただけます」。出处写法：「出典は、『国土地理院』または『地理院タイル』等と記載していただき、地理院タイル一覧ページへのリンクを付けてください」。
- 规约（[国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)）：采用 Public Data License 1.0，和 CC BY 4.0 兼容。允许商用；加工后要写明「编辑・加工した」，并且不能让人误以为是国土地理院制作的。
- CORS（实测）：`Access-Control-Allow-Origin: *`，走 CloudFront。
- 缺数据（实测）：日本以外、海上、超出最大级时返回 **404**。注意：现在的 `loadBitmap` 不缓存失败结果，每次重建都会重试，出了日本就会反复请求 404。要加负缓存（§4.4）。
- 服务器负载 / 批量下载的限制：规约里没有写（未核实另有规定），按礼貌节流处理。

**Mapbox Satellite**

- 分辨率（原文，[Mapbox Satellite 文档](https://docs.mapbox.com/data/tilesets/reference/mapbox-satellite/)）：z9–12「primarily Maxar satellite imagery and NASA/USGS Landsat 5 & 7」；z13–16「global coverage to zoom 16 (1–2 m resolution)」，来自 Maxar Vivid。
- 计费（原文，[mapbox.com/pricing](https://www.mapbox.com/pricing)）：Raster Tiles API「Up to 750,000」次 / 月免费，超出后每千次 $0.25。需要 access token，也就需要账号。
- 缓存：只能按 HTTP `Cache-Control` 缓存，禁止代理和中间缓存（来自搜索摘要，Raster Tiles API 页面的「Restrictions and limits」原文未核实）。署名要求：「When using this tileset publicly … you must provide proper attribution」（原文）。
- 评估：要绑账号和 token。清晰度和 Esri 同一量级，也是 Maxar 系；东亚一带没有 Esri 那样的社区高清补充（未核实）。**没有比 Esri 更好的理由。**

**Bing / Azure Maps**

- Bing Maps for Enterprise（原文转述，[Bing Maps 博客 2025-06](https://blogs.bing.com/maps/2025-06/Bing-Maps-for-Enterprise-Basic-Account-shutdown-June-30,2025)、[迁移说明](https://learn.microsoft.com/en-us/azure/azure-maps/migrate-bing-maps-overview)）：免费 / Basic 账号在 **2025-06-30** 停用，Enterprise 账号在 **2028-06-30** 退役，之后迁到 Azure Maps。
- Azure Maps 的影像瓦片（`microsoft.imagery`）要 Azure 订阅。搜索摘要说「15 张瓦片 = 1 次交易」，免费额度的原文未核实。
- **不适合**：已经在退役，还要 Azure 订阅。

**Google（Map Tiles API 2D 卫星、Photorealistic 3D Tiles）**

- 计费（原文，[Google Maps Platform 价格表](https://developers.google.com/maps/billing-and-pricing/pricing)）：2D Map Tiles 属 Essentials，每月免费「100,000」次，之后每千次「$0.60」；Photorealistic 3D Tiles 属 Enterprise，每月免费「1,000」次，之后每千次「$6.00」。
- 配额（原文，[usage-and-billing](https://developers.google.com/maps/documentation/tile/usage-and-billing)）：「Maximum 15,000 2D Tile … queries per project per day」；3D 是「Maximum 10,000 root tileset queries per day」。
- 条款（原文，[Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies)）：「You must not pre-fetch, index, store, or cache any Content except under the limited conditions stated in the terms」；禁止「Offline uses」；画面上要显示 Google Maps 徽标，或文字署名「Google Maps」。
- **为什么不能直接取 `mt.google.com`**：Google Maps Platform 服务条款 3.2.3（原文，[cloud.google.com/maps-platform/terms](https://cloud.google.com/maps-platform/terms)，Last modified 2026-08-26）：
  - (a) No Scraping：「Customer will not export, extract, or otherwise scrape Google Maps Content for use outside the Services … (ii) bulk download Google Maps tiles」。
  - (b) No Caching：「Customer will not cache Google Maps Content except as expressly permitted」。
  - `mt.google.com` 不是公开 API，没有 key 也就不在「Services」之内。
- **混用本身也违规**：同一节 (e) No Use With Non-Google Maps：「Customer will not use the Google Maps Core Services with or near a non-Google Map in a Customer Application」。把 Google 影像和 EOX 拼在同一片地面上，正好撞上这一条（Map Tiles API 是否属于 Core Services 的精确界定未核实，但风险明显）。
- 3D Tiles 已经记在 `ROADMAP.md`「付费数据」一节，维持原判：可以做成可选图层，但要绑卡、带 key，窗里要显示徽标。

**天地图（中国航线）**

- URL（原文，[天地图地图服务](http://lbs.tianditu.gov.cn/server/MapService.html)）：`http://t0.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=您的密钥`（球面墨卡托），子域名 t0–t7。
  - 官方页面的示例写的是 `TILEROW={x}&TILECOL={y}`，按 WMTS 规范行应该对应 y，以实测为准。
- 许可（原文，[开发许可说明](http://lbs.tianditu.gov.cn/authorization/authorization.html)）：「即日起天地图API及服务接口调用都需要申请开发许可（Key）」「天地图2020版将实现API服务调用配额管理」。
- 具体配额：网上流传「个人每日 1 万次」，**官方原文未核实**。CORS 未实测，因为没有 key。
- 评估：要注册 key（需要实名，涉及用户个人信息），配额偏紧，境外航线覆盖差。**排在 Esri 之后，只在用户明确要求中国区高清时再考虑。**

**其他 CC / 开放源**

- Copernicus Sentinel-2 原始 L2A 也是 10 m，自己做无云镶嵌没有意义，EOX 已经做好了。
- 欧美各国有开放的高清正射影像（如美国 NAIP、瑞士 SWISSIMAGE、法国 BD ORTHO）。项目现在的航线都在东亚，这些**没有逐条核实，暂不展开**。

### 2.2 对比表

| 源 | 能用的最高分辨率 | 覆盖 | 许可 | 需要 key | 额度 | CORS | 署名 | 适合本项目？ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EOX S2 cloudless 2024/2025 | 10 m（z14 起放大） | 全球陆地 | CC BY-NC-SA 4.0（原文） | 否 | 未公布，60× 会被限流（实测） | 回显 Origin（实测） | EOX + Copernicus | **是：直接替换 2020（G01）** |
| EOX S2 cloudless 2016 | 10 m | 全球 | CC BY 4.0（原文，可商用） | 否 | 同上 | 同上 | 同上 | 仅在将来要商用时考虑 |
| 国土地理院 seamlessphoto | 约 0.5 m（z18） | 日本 | PDL1.0 / CC BY 4.0 兼容，可商用（原文） | 否 | 未写明（未核实） | `*`（实测） | 「国土地理院」+ 链接 | **是：日本 0–1 级（G03）** |
| Esri World Imagery（旧端点） | 0.3–1 m（z≥12）；z≤11 是 15 m TerraColor（原文） | 全球 | Esri MLA；旧端点无 key 是否获授权未核实 | 旧端点否 | 未公布 | `*`（实测） | Esri, Vantor, Earthstar Geographics, GIS User Community | 灰区，**等用户拍板** |
| Esri 经 Location Platform | 同上 | 全球 | Esri 条款，token | 是（账号） | 200 万张 / 月免费，之后 $0.15/千张（原文） | 未实测 | 同上 + Powered by Esri | 用户同意注册后的正规路线（G04） |
| Mapbox Satellite | 1–2 m（z13–16，原文） | 全球 | Mapbox ToS | 是 | 75 万 / 月免费，之后 $0.25/千张（原文） | 未实测 | Mapbox + 来源 | 否（不比 Esri 好，还要账号） |
| Bing / Azure Maps | 未核实 | 全球 | Azure 条款 | 是（订阅） | 未核实 | 未实测 | — | 否（在退役） |
| Google 2D 卫星 | 未核实 | 全球 | GMP 条款：禁缓存，禁与非 Google 地图混用（原文） | 是（绑卡） | 10 万 / 月免费；每天 1.5 万张（原文） | — | 徽标 | **否**（禁混用，徽标破坏沉浸感） |
| Google `mt.google.com` 直取 | — | — | 违反 3.2.3(a)(b)（原文） | — | — | — | — | **绝对不行** |
| 天地图 img_w | 未核实 | 中国为主 | 需 key，有配额（原文） | 是（实名） | 未核实 | 未实测 | 天地图 | 暂缓 |

---

## 3. 实测对比

脚本：`tmp/imagery-test/fetch_compare.py`（取瓦片、拼图）、`metrics.py`（统计）、`calc.py`（§1 的估算）。

每个场景取 z12 / z14 / z16 三级，每级 2×2 张瓦片，中心裁 384 px，原始像素 1:1 显示，总共 180 张瓦片。
- z14 那一行就是「第 0 级里装的东西」，z12 那一行是第 2 级。
- 部分格子右侧或上方有黑条，那是脚本只取了 2×2 张瓦片、中心离瓦片边太近造成的，不是数据缺失。

| 拼图 | 场景 |
| --- | --- |
| `D:\Code\opus-test\tmp\imagery-test\compare_kanto.jpg` | 关东平原，茨城筑波（36.08, 140.08），羽田—新千岁航线下方 |
| `D:\Code\opus-test\tmp\imagery-test\compare_fuji.jpg` | 富士山南麓，富士市（35.20, 138.68） |
| `D:\Code\opus-test\tmp\imagery-test\compare_suruga.jpg` | 骏河湾沿岸，静冈清水港（35.02, 138.49） |
| `D:\Code\opus-test\tmp\imagery-test\compare_yangtze.jpg` | 长江九江湖口（29.73, 116.20），`yangtze` 预设附近；GSI 不覆盖 |

### 3.1 统计（实测，`metrics.py`）

- 相对梯度 = 线性亮度的平均梯度 ÷ 平均亮度，数值越大边缘越锐。
- Esri 和两版 EOX 用四个场景共有的 16 张瓦片统计；GSI 只统计三个日本场景的 12 张，**和其他三列不严格可比**。

| 级 | EOX 2020 | EOX 2024 | Esri | GSI（仅日本） |
| --- | --- | --- | --- | --- |
| z12 相对梯度 | 0.49 | **0.89** | 0.48 | 0.62 |
| z14 相对梯度 | 0.23 | 0.41 | **0.54** | 0.45 |
| z16 相对梯度 | 0.07（放大糊） | 0.11 | **0.46** | 0.36 |
| z14 平均 sRGB | (68,82,62) | (75,83,64) | (95,100,85) | (116,120,111) |

### 3.2 肉眼观察

- **清晰度**：
  - z14（第 0 级）上，Esri 和 GSI 的建筑轮廓、道路、铁路都是清楚的线，EOX 2020 是一团团色块。EOX 2024 介于两者之间。
  - z12（第 2 级）上，**EOX 2024 最锐**。Esri 在 z12 反而发软，长江那张还有明显的直线拼接缝。
  - z16 上，EOX 只是放大后的模糊图。
- **色调**：
  - EOX 两版都偏暗、偏绿（夏季合成）。2024 比 2020 反差大，森林更深。
  - Esri 在关东是冬季枯黄色（农田成片棕色），整体亮约 30%。
  - GSI 在 z12 严重偏蓝白（富士、清水城区像覆了一层霜），z14 偏灰、发雾，不同航拍批次之间的色调跳变很明显。关东 z14 左侧有一条发白的拼接带。
- **云**：Esri 富士 z12 左侧有一小朵积云。EOX 本来就是无云合成。GSI 这几张没看到云。
- **建筑影子**：Esri 的清水港 z14、z16 有朝西北方向的长阴影（冬季上午太阳，推断），高楼的影子能拉到几十米长。GSI 的阴影短一些。EOX 在 10 m 尺度上基本看不到影子。
- **季节 / 水位**：
  - 长江 EOX 2024 是枯水期，露出大片滩涂，水色偏青；2020 版水面更大。Esri 的江面由几块不同颜色的水拼成（直线边界）。
  - 骏河湾海面上，GSI 有太阳耀斑和波纹斑块，还有拼接块。**海面不能用航拍影像**：本项目的海面是程序化的，水体遮罩覆盖的地方本来就不用影像颜色，但岸边一带要小心。
- **分类阈值**：`ground-detail.glsl.ts` 的 `landClasses` 阈值是按 EOX 取值定的（城区 ≈ (96,103,78)、树林 ≈ (29,52,32)、农田 ≈ (66,92,51)）。Esri 和 GSI 的平均色明显偏亮、偏灰，直接换源会把大片农田分成城区，夜里城市灯点和路灯亮起的判据（「夜光² × 影像建成区」）也会跟着偏。**这是混用必须做色调迁移的第二个理由**（第一个是拼接缝）。

---

## 4. 混用方案

### 4.1 放在哪几级

- **默认只放第 0–1 级（z14 / z13）**。这两级 EOX 是放大后使用的，高清源收益最大。第 2 级（z12）按 §3 的实测，EOX 2024 不比 Esri 差，先不放，A/B 之后再定。
- 第 3 级及以上一律 EOX：Esri 在 z≤11 是 15 m，数据本身更粗。
- 按高度和视角开关：离地低于约 6 km，或者当前是看机翼视角时，才请求高清源（估：巡航标准视角下第 0–1 级根本不在画面里，请求了也是浪费）。
- G06 做完、纹素变细之后，再把范围扩到第 2–3 级。

### 4.2 合成：高频取高清，低频取 EOX（只换数据，不换着色器）

在 `road-raster.worker.ts`（已有 OffscreenCanvas、和夜光 / 道路一起合成）里对每一级做：

1. `H` 是高清源画到本级 1024² 上的结果，`E` 是同一范围的 EOX。`E` 用第 L+2 级的缩放级取（z12 / z11），**这些瓦片在粗两级重建时已经进了 LRU**，基本不产生新请求。
2. 在对数亮度或 linear RGB 里做频率分离：`out = E_low + (H − H_low)·k`。`X_low` 是 σ ≈ 8 纹素的模糊（约 60 m，盒滤波三次近似，O(N)）。k 取 0.8–1.0，用来收高清源的额外反差（航拍的反差和阴影比 EOX 强）。
   - 结果：色调、季节、拼接缝都跟 EOX 走，60 m 以下的细节来自高清源。
   - `landClasses` 看到的平均色和现在一样，分类和夜间灯点判据不变。
3. **遮罩**（写成「缺影像」，A < 0.5，沿用现有回退语义）：
   - 占位图：按字节长度和哈希判断，如 Esri 那张 2521 B 的图。
   - 云：`H_low` 比 `E_low` 亮很多且饱和度低，比如亮度比 > 1.6 且饱和度 < 0.15（估，要调）。
   - 拼接缝：`H` 在 1–2 纹素宽的直线上梯度异常。先不做，频率分离后缝已经被低频抹平，只留高频的台阶，观察后再定。
   - 遮罩边缘要羽化几个纹素，缺影像比例按现有编码 `A = 比例/2` 写入，着色器里的 `min(A·2,1)` 自然就过渡到粗一级。
4. **A 通道不能被破坏**：道路照亮宽度（T08 / T43）照旧在合成之后按现有逻辑编码（`128 + 宽度·127/ROAD_W_MAX`）。缺影像的地方和现在的缺瓦片一样，不写宽度。合成只改 RGB。
5. 着色器、sampler 数量、冷编译都**零改动**。`outside-*` 程序的 sampler 用量仍是 14/16。

### 4.3 影子

- 航拍自带的阴影方向是固定的，而本项目的太阳是动态的，日落时会对不上。
- 第 0–1 级在画面上只占下沿，阴影是 1–3 个纹素宽的暗斑，读起来更像「城市纹理」，而不是「影子方向错了」（估）。MSFS 也是用自带阴影的 Bing 影像。
- 频率分离里的 k < 1 已经压了一部分。先不专门处理，美术总监看过 A/B 截图后再定是否加「暗部提升」。

### 4.4 请求量、限流、缓存

- **估算（1×，巡航约 15 km/min）**：第 0 级每张 z14 瓦片约 2 km 宽，本级 8 km 宽，所以每分钟新增约 15/2 × 5 ≈ 38 张。第 1 级约 19 张。合计约 **60 张 / 分钟，约 3600 张 / 小时**。
  - Esri 正规途径每月 200 万张免费，约合 550 小时的 1× 飞行（估）。
  - 低空时地速更低，请求更少。
- **60× 连续航程**：`setMinLevel` 在 ≥ 30× 时已经停用第 0–2 级，高清请求自然为 0。另外建议：
  - 时间流速 > 2× 时不请求高清源，第 0–1 级退回纯 EOX。
  - 每个 host 一个令牌桶，比如 Esri 每分钟 ≤ 300 张、并发 ≤ 6，GSI 同量级。
  - T19a 的脚本按 host 统计 `requestsPerRealMin`，验收时一起看。
- **负缓存**：现在失败的请求不缓存，下一次重建会重试。这是为了应对网络抖动和限流，是对的；但 404（GSI 出了日本）和 Esri 占位图是「确定没有」，应该缓存成 `null`。按 HTTP 状态区分：404 缓存，429 / 5xx / 网络错误不缓存。否则一出日本，每次重建都会白发几十个 404。
- **本地持久缓存（IndexedDB）**：
  - EOX（CC BY-NC-SA，允许复制）和 GSI（PDL1.0）可以做，重复飞同一航线时能减少请求。
  - **Esri 不做**：licenseInfo 原文是「not intended to be used to export tiles for offline」，只依赖浏览器 HTTP 缓存（`max-age=86400`）。
  - Google / Mapbox 本来就只能按 `Cache-Control` 缓存。
- **预取**：按航向提前取前方一个级别宽度的瓦片，可以放到 G02 里。当前「粗级先建」的策略已经保证远景先出来，预取的优先级低。

### 4.5 对冷编译和 sampler 的影响

- G01–G04 只改数据：`tiles.ts`、`clipmap.ts`、`road-raster.worker.ts`，**不碰着色器**，冷编译和 sampler 都不变。
- G06（各向异性）要改 `groundSampleImpl`：RGB 改用 `textureGrad` 取样，A 仍用 `textureLod(…,0)`。
  - 因为 A 通道里是编码值，mipmap 平均后会变成垃圾，所以影像纹理即使生成了 mipmap，A 也只能读第 0 级。这一条要写进坑点。
  - `sampleGroundAlbedo` 调用点不多，但 `usableLevel` 循环在里面，按硬约束速查表要实测冷编译。
  - sampler 数不变（同一张纹理）。

---

## 5. 分期任务清单

| 编号 | 目标 | 归属模块 | 依赖 | 验收场景 / 标准 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| **G01** | 影像从 EOX 2020 换成 2024（或 2025，二选一，A/B 截图后定），同步 `index.html` 的署名和 README「数据来源与许可」 | `src/ground/tiles.ts`（`IMAGERY_URL`）、`index.html`（credits）、README | 无 | 回归 11 个场景前后对比；`uDebug = 21` 分类图在 fuji、yangtze-low、kanto 上没有大面积跳类（`landClasses` 阈值必要时微调）；夜间城市灯点分布不明显变化；控制台无 error | 小（半天） |
| **G02** | 影像源抽象：`ImagerySource { url, maxZoom, levels, placeholder 判定, 负缓存规则, host 令牌桶, 署名 }`；404 和占位图负缓存；每 host 限速；按 host 统计请求数（调试小地图或 `__voyage`） | `src/ground/tiles.ts`、`clipmap.ts`（取瓦片处） | G01 | 1× 和 60× 各飞 10 分钟：`handoff/T19a-voyage.mjs` 的 `requestsPerRealMin` 分 host 输出，60× 下总量不高于现状（约 550/分）；拦掉部分瓦片时回退正常 | 小–中 |
| **G03** | 日本：GSI seamlessphoto 进第 0–1 级，Worker 里做「高频 GSI + 低频 EOX」合成、云 / 占位遮罩（写成缺影像 A < 0.5），A 通道道路宽度编码不变；只在离地 < 6 km 或看机翼视角、时间流速 ≤ 2× 时请求 | `road-raster.worker.ts`、`road-raster.ts`、`clipmap.ts`、`tiles.ts` | G02 | fuji 低空 4 km、看机翼视角；kanto 2.5–4 km：截图 A/B（同机位、同时刻），第 0–1 级区域明显更清楚，**级别边界处无色调跳变**，没有直线拼接缝；`uDebug = 21` 分类与 G01 一致；T08-flicker / T43-crawl 的闪烁指标不变差；PERF-9 长任务统计（`T08-shots.mjs --longtask`）不变差；出了日本无重复 404 | 中（2–3 天） |
| **G04** | （**用户先拍板**：用 Esri 旧端点，还是注册 Location Platform 拿 token）其他地区用 Esri 进第 0–1 级，复用 G03 的合成；token 不入库（`.env.local`，`import.meta.env`）；署名写全（含「Powered by Esri」） | 同 G03 + `index.html` | G03、用户决定 | yangtze-low、长江沿线 4 km：同 G03 的标准；占位图区域（海上、偏远地区高缩放）回退到 EOX，没有灰色「Map data not yet available」贴片 | 小（G03 之后） |
| **G05** | 高清区与 EOX 区的过渡复查：第 0/1 级、第 1/2 级边界的锐度突变（高清区清楚、粗一级突然糊）要用 `groundLod` 的混合区平滑掉，必要时把高清的高频按距离渐隐 | `road-raster.worker.ts`（渐隐写在数据里），或 `ground.glsl.ts`（最后手段） | G03 | 低空斜看的截图里找不到一圈「清晰 / 模糊」的环形边界；美术总监过目 | 小 |
| **G06** | **clipmap 纹素密度**（巡航画面整体变清晰的真正手段）：①clipmap 中心往窗外一侧偏移（本侧距离覆盖翻倍）；②提高分辨率到 2048²。注意 `DataArrayTexture` 的每层尺寸必须一致，两条路：全部 7 级都升到 2048²（影像 + 水体从约 59 MB 升到约 235 MB，加 mipmap 再多 1/3，估）；或者给细级别另开一张数组纹理，但这要多占 2 个 sampler，`outside-*` 现在是 14/16，会顶满上限。倾向于前者，先实测显存和上传尖峰；③影像纹理生成 mipmap，RGB 用各向异性 `textureGrad` 取样，A 仍读第 0 级；④`groundLod` 的距离系数相应放宽，目标是纹素 / 横足迹从 ~3 降到 ~1.5 | `clipmap.ts`、`ground.glsl.ts`、`terrain-shading.glsl.ts` | 独立于 G02–G05，但最好在 G03 之后（高清源这时才在巡航画面里显出来） | 巡航 10.7 km 标准视角和看机翼视角：纹素 / 横足迹实测（`uDebug = 22` 足迹图）；**闪烁**：T08-flicker、T43-crawl 不变差（铁律：锯齿 / 闪烁最高优先）；冷编译按速查表（单任务 ≤ 10%）；PERF-8 纹理上传尖峰（2048² 一层 16 MB）要分帧；60× 下请求量不升 | 大（先做 1 天实验：只做①，测收益和闪烁，再决定②③） |
| **G07** | （可选）IndexedDB 持久缓存 EOX / GSI 瓦片（**不含 Esri**），按容量 LRU 淘汰 | `tiles.ts` | G02 | 同一航线第二次飞：请求量下降 > 80%；清缓存 / 隐私窗口下照常工作（try/catch） | 小 |
| **G08** | （G06 之后再评估）低空细节变体（T02 `GROUND_DETAIL`）的程序化田块 / 街区纹理和真实高清影像是否打架：有高清数据的区域程序化细节减弱 | `ground-detail.glsl.ts` | G03、G06 | 2.5 km 看机翼视角下，没有「真实田埂 + 程序化田埂」两套纹理叠在一起 | 小–中 |

**不建议做**：Google 2D 卫星（条款禁止和非 Google 地图混用，还要徽标）；直接取 `mt.google.com`（违反条款）；Mapbox（没有比 Esri 更好的理由，还要账号）；Bing（在退役）；天地图（要实名 key、配额紧，除非用户明确要中国区高清）。

**等用户决定的事**：
1. Esri 是用旧端点（无 key，许可是灰区，项目本来就是非商用练手），还是注册 ArcGIS Location Platform 用 token（正规，免费额度足够）。
2. G01 选 2024 还是 2025（两者差一年季节；2025 是否全球覆盖完整未核实，A/B 截图后定）。

---

## 6. 需要写进 README 的坑点（实现时落盘，本研究先记在这里）

- **Esri 缺数据返回 200 + 占位图，不是 404**：2521 字节、同一哈希（实测 md5 前缀 `f27d9de7`，大洋 z14、长江 z19）。不识别的话会把灰色「Map data not yet available」贴到地上。
- **GSI 出了日本返回 404，而 `loadBitmap` 不缓存失败**：每次重建都会重发。要按状态码区分，确定没有的负缓存，限流 / 网络错误不缓存。
- **影像 A 通道是编码值，不能做 mipmap 平均**：将来给影像纹理加 mipmap 或各向异性（G06）时，A 必须从第 0 级读。
- **换影像源会改变 `landClasses` 分类和夜间灯点判据**：阈值是按 EOX 的色调定的。换源或混源时，要么做低频色调迁移，要么同时重调阈值，用 `uDebug = 21` 验收。
- **Esri 在 z≤11 是 15 m TerraColor**：比 EOX 还粗，不要为了「清晰」把 Esri 放进第 3 级及更粗的级别。

---

## 7. 开发体验反馈

- **顺手的地方**：
  - `research/PARAMS.md` 把视场、clipmap 级数、纹素都列好了，§1 的估算基本不用翻代码。
  - README 速查表里「影像 A 通道语义」这一条直接避免了一个混用方案的大坑。
  - T02 交接写清了缺瓦片回退的来龙去脉，让我立刻想到 GSI 的 404 会触发反复重试。
- **不顺手的地方**：
  - PARAMS 里没有「画面实际覆盖的俯角范围（标准 / 看机翼视角）」和 `groundLod` 的距离系数（0.85 / 1.5）。这两个数决定了「哪一级出现在画面里」，这次是读 `view-presets.ts` 和 `ground.glsl.ts` 推出来的。建议加进 PARAMS，或者直接收录 `tmp/imagery-test/calc.py` 这样的计算脚本（`scripts/footprint.py`）。
  - 调试模式 22（像素足迹）只显示足迹，没有「纹素 / 足迹」比值。加一个比值伪彩，能一眼看出 clipmap 在哪里是瓶颈，G06 验收也用得上。
  - 各服务的许可原文分散在网页里，很多页面是 JS 渲染的，WebFetch 抓不到正文。Esri 用 `sharing/rest/content/items/<id>?f=json` 和 MapServer `?f=json` 能拿到原文，EOX 用 WMTS GetCapabilities 的 Abstract 能拿到原文，这两招值得记下来。
  - Windows 控制台默认 GBK：Python 打印含 `\xa0` 的文本会抛 UnicodeEncodeError，要加 `PYTHONIOENCODING=utf-8`（根 AGENTS.md「环境坑」可以补一句）。
