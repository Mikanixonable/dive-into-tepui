# グラフィック基盤 — ロードマップ 第二版

第一版(`for_agent.md`)にユーザー判断を反映し、追加調査で判明した事実で裏を取り直したもの。
**この版が有効で、第一版は破棄する。**

個々の見た目の仕様は `DEVELOP/EARTH_MOON_GRAPHICS_PROPOSAL.md` /
`DEVELOP/PHYSICAL_RING_RENDERING_PROPOSAL.md` が持つ。この文書はその下に敷く土台だけを扱う。

---

## 0. 第一版からの変更点(要約)

| # | 第一版 | 第二版 |
|---|---|---|
| 1 | 「未決: 露出の基準。物理単位か正規化か」 | **決定**。放射照度 [W/m²] を基準に取る。既存の手調整値は保存対象ではなく破棄対象 |
| 2 | 浮動原点は §4「責務境界」の一項目 | **Phase 0 へ昇格**。グラフィック以前の疎結合化として最初に片付ける |
| 3 | Phase 2 でカスケードを導入する(前提) | **スパイクで可否を測ってから決める**。座標の順/逆変換を単一モジュールへ切り出すことを要件化 |
| 4 | §2-3(B) シェーディングコンテキストID(主根拠=リング影32バンド) | **取り下げ**。影は別基盤へ移すので根拠が消える。§1-4 参照 |
| 5 | 影は「リング影は解析的、艦船の自己影は別途」(未決) | **決定**。太陽可視率を単一の問いに統一し、遮蔽器の実装だけを3層に分ける |
| 6 | Phase 1 のリスク「既存の手調整値が崩れる」= 高リスク | リスクではなく**意図した結果**。画像回帰の役割を「一致確認」から「崩れ方の観測」へ変更 |
| 7 | 「出力色空間 未設定」 | **事実誤り**。three r0.169 の既定が `SRGBColorSpace`。欠けているのは HDR RT とトーンマッピングのみ |
| 8 | — | デッドコード3系統が判明(§3-5)。着手前に消す |

フェーズ番号は振り直した。対応は §4 冒頭の表を見よ。

---

## 1. 確定した4つの判断

### 1-1. 露出 — 放射照度を基準に取り、既存の手調整値は捨てる

**方針(確定)**: HDR 線形空間へ移した上で、物理的根拠のある式へ組み替える。視覚的な問題が出たら
**HDR 空間の上で**再調整する。LDR 時代の手調整値へ戻す方向の調整はしない。

したがって第一版が「高リスク」としていた「既存の手調整値が全面的に合わなくなる」は、
**回避すべき事態ではなく通過すべき工程**である。画像回帰シーンは「変更前後の一致」を
判定するためではなく、「どこがどう変わったか」を人が読むために撮る。

**基準の取り方(確定)**: 太陽放射照度を一次基準とする。

```text
E(d) = SOLAR_CONSTANT * (AU / d)^2      [W/m^2]    — 距離 d における放射照度
L_surface = E(d) * albedo / pi          [W/m^2/sr] — 完全拡散反射面の放射輝度
exposure  = 1 / L_ref                              — L_ref を中間グレーへ写す係数
```

必要な量は**すべて既にある**:

- `SOLAR_CONSTANT = 1361` [W/m²] — `game/const.ts:65`(ラジエータと電力が既に使用)
- `ASTRONOMICAL_UNIT = 1.495978707e11` — `physics/srp.ts:9`
- 逆二乗則の実装 — `physics/srp.ts:24`
- `STEFAN_BOLTZMANN` / `HULL_EMISS` — `game/const.ts:44-45`(砲身赤熱を黒体で導ける)
- 機体温度 [K] — `game/const.ts:47-51`

**唯一の欠落はアルベドである。** 天体表面は 101 天体ぶんの 16 進直書き色(85 リテラル、ユニーク 63 種、
`celestial-registry.ts:88-195`)しか持たず、アルベド値は 1 つも無い。色の決め方に根拠コメントも無い。
**これが露出フェーズの最大の実作業になる。**

補足すべき事実として、`SOLAR_PRESSURE_1AU = 4.56e-6`(`physics/srp.ts:6`)は
`SOLAR_CONSTANT / c` と同じ量の二重表現である。露出基準を入れる際に、片方をもう片方から
導出する形へ統一すること(定数が2つある状態で放射量の基準を名乗らない)。

**既にこの基準で書かれている部分がある。** リングだけが完全な放射伝達モデルになっている —
`RingOpticsDef` の単一散乱アルベド(0.35〜0.6)・法線光学的厚さ(2e-8〜8)・HG 非対称因子(0.05〜0.9)が
全 35 帯に出典コメント付きで入っており、`physics/ring-optics.ts:50-64` の `ringSingleScattering` は
「等方散乱=1 の相対放射輝度」という明示された単位を持つ。現状はこれを
`RADIANCE_SCALE = 0.72`(`render/ring.ts:30`)という**手調整係数 1 個**で LDR へ押し込んでいるだけである。

> **露出の校正はリングを基準に取る。** 唯一、放射量として意味の定まっている系だから。
> `RADIANCE_SCALE` が 1.0 になる(= 押し込み係数が消える)ことを、露出フェーズの完了条件の一つにする。

**HDR 化で構造変更が要る箇所**: `Billboard` は `MeshBasicMaterial.opacity`(0..1 クランプ)で
明るさを表しており、`transparent + AdditiveBlending` の 5 経路のうち最大のものがここを通る
(`render/billboard.ts:16-18`。太陽・惑星輝点・噴射・RCS・再突入・全フラッシュが共有)。
1 を超える輝度を出せないので、`colorNode` を持つノードマテリアルへ置き換える必要がある。
**太陽ビルボードは opacity 固定 1**(`render/stars.ts:50`)で、現状は白飛びすら起きていない。

### 1-2. 座標境界 — 浮動原点を描画から切り離す(グラフィック以前の問題)

**方針(確定)**: 描画はすべてフローティングオリジン座標系(`THREE.Vector3`)で行い、
GPU に ECI 座標(独自 `Vec3`)が渡らないことを徹底する。`game/` から `render/` へ情報が渡る
**前後のできるだけ早い段階**で変換する。可能なら `render/` に ECI 座標が入ること自体を避ける。

これは描画品質の話ではなく、ゲームと描画の疎結合化の話である。よって**フェーズ 0 に置く**。

現況(調査で確定):

- **`render/` の `FloatingOrigin` 依存は 2 箇所だけ** — `orbit-line.ts:119`、`sampled-line.ts:197`。
  どちらも `line.position` を置くためだけに使っている。
- **ECI 絶対座標が uniform で GPU へ渡っている箇所は 0 件。** シェーダに入る位置ベクトルは
  すべて描画フレーム相対(`earth.ts` の `earthCenter`、`ring.ts` の `bodyCenter`、
  `celestial-surface.ts` の 32 バンド `center`)か単位方向。**現時点で単精度の破綻は無い。**
- ただし**大きな絶対値が f32 バッファに載る系統が 2 つある**(下記)。
- `ring.ts` / `earth.ts` / `billboard.ts` / `stars.ts` は既に「THREE 型 + 数値のみ」で目標状態。
  `game/celestial/ring-view.ts` が境界の担い方の見本になっている。
- **本丸は `sampled-line.ts`** — `KinematicState` / `ReferenceFrame` / `Attractor` / `Ephemeris` に加え、
  **絶対 ECI 位置を引数に取る関数型 `ScaleAtFn`(`sampled-line.ts:28`)を `render/` 自身が定義している**。
  `fo` を外しただけでは目標状態にならない。

**f32 精度の実在リスク(要実測)**:

| 系統 | 座標の基準 | 最大絶対値 | f32 量子化 | 見えうる条件 |
|---|---|---|---|---|
| `orbit-line.ts:76,261-263` の頂点 | 中心天体相対 | 海王星軌道 ~4.5e12 m | ~3e5 m | 海王星付近まで寄った状態でその軌道線を描くと ~3 px 相当 |
| `point-field-view.ts:92-96` の `instanceMatrix` | 太陽中心 | カイパー帯 ~7.5e12 m | ~5e5 m | 同上 |

いずれも ECI 絶対ではないが「絶対に近い大きさ」であり、フローティングオリジンの恩恵を受けていない。
**引きの絵では画素以下だが、寄ると露見する** — ユーザー指摘の「単精度で ECI を扱うと崩れる」に
実際に該当する唯一の系統なので、Phase 0 で実測して判断する。

**切り離しの方法(2段)**:

1. **上り(生成側)と下り(アップロード側)を割る。** `sampled-line` の bake + Hermite 細分は
   THREE を一切使わない座標計算で、`Float32Array` への書き込みだけが描画側である
   (`sampled-line.ts:113-151` を確認済み)。頂点列の生成を `game/` 側へ出し、
   `render/` は「頂点バッファと材質を持ち、渡された配列をアップロードする」だけにする。
2. **表示ポリシーは `render/` に残す。** 弦数の決め方(画面上のサグ `MAX_EDGE_SAG_PX = 0.5`、
   折れ角上限 5°)は描画の判断なので `render/` が持つ。ただし ECI を取らない純関数
   `chordCountFor(turnRad, chordLen, metersPerPixel) -> number` として公開し、`game/` が呼ぶ。
   これで「表示 LOD は `render/`、座標は `game/`」が両立する。

`orbit-line` も同型(楕円頂点の生成は `OrbitalElements` からの幾何、アップロードは描画)。

**完了条件**: `src/render/**` から `physics/vec3` の `Vec3`、`KinematicState`、`ReferenceFrame`、
`Attractor`、`Ephemeris`、`FloatingOrigin` への import が 0 件。
公開 API の引数が `THREE.*` と数値と描画専用型だけになる。

### 1-3. 深度カスケード — 測ってから決める。変換は一か所に閉じる

**方針(確定)**: 距離圧縮の撤去は GPU 上の深度精度が担保できるかが鍵であり、
やってみないと分からない。**全体と密結合にならないよう、順変換と逆変換を一か所へ切り出しておく。**

したがって第一版のように「Phase 2 でカスケードを入れる」と決め打ちせず、
**スパイク → 測定 → 判断 → 本実装**の順にする。判断が否なら距離圧縮は残り、
後続フェーズは圧縮を前提に進む(その場合の影響は §1-4 と §6 に明記)。

調査で判明した、判断を楽にする事実:

- **`physics/projection.ts` は near/far に一切依存しない。** `Viewpoint` が near/far を持たず
  (`projection.ts:10-16`)、`projectToNdc` も `metersPerPixel` も near/far を読まない
  (`projection.ts:19-37, 53-57`)。
  → **カスケード間で fov/aspect を共有する限り、`ProjectFn` / `ScaleFn` の全消費者(マーカー約10系統、
  picking 5系統、plan 系、`sampled-line` の頂点密度、`ring-view` の LOD、`point-body` の 2px 判定)は
  無変更で通る。** カスケードは「Viewpoint 1 つ + (near, far) N 組」で足りる。
- **投影行列を書く箇所は `camera/camera-system.ts:73` の 1 箇所しかない。**
  `updateProjectionMatrix()` の呼び出しは src 全体でここだけ。変更点が 1 点に集中している。
- `PerspectiveCamera` は 2 個(戦闘 / 広範囲)だけ。
- **`COMBAT_CAMERA_FAR = 6e7` は `MOON_VIS_DIST = 4.5e7` から逆算された値である**
  (`const.ts:120-123` のコメントが明記)。圧縮を撤去すれば far の制約がそのまま解ける。
- **地球だけは既に真位置・実半径で描かれている**(`earth-body.ts:34`)。真スケール描画の前例が既にある。

**未決だった「カスケードと浮動原点の相互作用」は解決する**: カスケードごとに原点を変える必要はない。
浮動原点は 1 つのまま、カスケードは投影行列の near/far だけを持つ。f32 の精度は原点からの距離で
決まるが、遠方カスケードでは要求される絶対精度もその分緩いので釣り合う。**ただしこれは仮説であり、
スパイクの測定対象そのものである。**

**変換の切り出し(要件)**: 現況、ECI → 描画位置の順変換は **5 種類に分散**しており共通ヘルパが無い。
逆変換は **1 つも存在しない**。

1. `FloatingOrigin.RtoThreeV3(pos)` — 真スケール配置
2. `cam.position + dir * visDist`, `scale = visDist*r/d` — `sphere-body.ts:76-81`, `point-body.ts:141-147`
3. `cam.position + dir * SUN_DISTANCE` + 固定サイズ — `sun-body.ts:54-62`
4. `cam.position + dir * STAR_SHELL_RADIUS` — `point-body.ts:177-181`
5. `mesh.position = cam.position` + `setScalar` — `environment-scene.ts:170-171`, `celestial-grid.ts:249-250`

これらを 1 モジュール(`render/view-space.ts` 等)へ集約し、次を公開する:

```text
toRender(eciPos)        -> THREE.Vector3     順変換
toEci(renderPos)        -> Vec3              逆変換(現在は存在しない。作る)
cascadeOf(eciPos)       -> number            どの深度レンジに属するか
cascadeNearFar(i)       -> {near, far}
```

**圧縮を採るにせよ撤去するにせよ、この集約は先にやる。** 圧縮方式そのものがこのモジュールの
実装詳細に落ちるので、後で差し替えられる。

**スパイクの測定項目**: (a) 分割数 2 / 3 / 4 での z-fighting の有無、(b) パス増加によるフレーム時間、
(c) `depthTest: false` の 3 箇所(星殻 `stars.ts:28`、大気リム `earth.ts:92`、
Δv ギズモ `plan-gizmo-3d.ts:32`)がカスケード間の深度クリアと衝突しないか、
(d) `frustumCulled = false` が広範(13 箇所)なので `camera.layers` による振り分けが機能するか。

**先行して必要な小作業**: `types/three-shims.d.ts` に `clearDepth()` が無い(`:6-19`)。カスケードには要る。

### 1-4. 遮蔽 — 「太陽可視率」を単一の問いへ統一する。CSM はその一実装

**方針(確定)**: 惑星のリングの影・艦のセルフシャドウ・艦が惑星の影に入る現象は同じ物理であり、
同じ基盤で表現されているのが自然。第一版のように「現存のリング影方式をそのまま遅延化する」のは
リングへのアドホック実装を温存するだけなので採らない。

**統一の実体は、実装ではなくインターフェースである。**

```text
sunVisibility(worldPos, normal) -> [0, 1]      受け手はこれしか呼ばない
```

受け手(天体表面 / 艦の BRDF / リング / 大気)はこの 1 関数しか知らない。
遮蔽器の側だけが種類を持つ。

**なぜ CSM 一本ではできないか(数値)**: 同一シーン内で影に関わる寸法が **1e0 〜 1e10 m** に開く。

| 遮蔽の対象 | 寸法 |
|---|---|
| 艦の構造 | 数 m(`PLAYER_HULL_RADIUS = 2.6`、全長 5〜6 m) |
| 追跡カメラ距離 | 12〜8000 m |
| 戦闘域(弾の消滅 / 敵スポーン) | 10〜30 km |
| 惑星本体 | 1.7e6〜7.2e7 m |
| リング系 | 6.7e7 〜 **1.3e10 m**(土星フェーベ環) |
| **最細のリング帯** | **幅 1.5e3 m @ 半径 4.2e7 m(天王星 λ 環)= 比 3.6e-5** |

天王星の λ 環 1 本に 1 テクセルを割り当てるだけでも約 2.8 万テクセル/軸が要る。
フェーベ環まで含めればさらに 2 桁悪化する。**シャドウマップでリングは解けない。**
逆に、球とリング平面には**閉じた解析解があり、離散サンプリングより精度が高い。**
解析解のあるものへシャドウマップを使うのは劣化であって統一ではない。

**したがって遮蔽器は 3 層に分ける(実装の分岐であって、概念の分岐ではない)**:

| 遮蔽器 | 手法 | 適用範囲 | 現況 |
|---|---|---|---|
| 天体本体(球/回転楕円体) | 解析的レイ・球交差 | 1e6〜1e11 m | **CPU と GPU に別実装が既存**。`physics/shadow.ts` の `sunlitFactor` と `render/ring.ts:71-77` の `inBodyShadow` |
| リング平面(帯ごとの τ) | 解析的レイ・平面交差 + Beer–Lambert | 1e7〜1e10 m | `render/celestial-surface.ts:63-91` に**固定長 32 バンド**で既存 |
| 艦・デブリ・基地 | シャドウマップ(**ここに CSM が入る**) | 1e0〜3e4 m | **存在しない**(`castShadow`/`shadowMap` は src に 0 件) |

3 層目の適用範囲は 10 m 〜 30 km の 3 桁強で、CSM 3 枚なら 1 枚あたり 1 桁。標準的な使い方に収まる。

**「同じ基盤」が現実に破れている箇所(これが本題)**:

1. **物理側と描画側が同じ問いに別々に答えている。** `sunlitFactor`(`physics/shadow.ts:8-13`)は
   **地球固定の円柱影**で、`R_EARTH` 直書き、他天体の影が存在しない。これを読んでいるのは
   照明(`environment-scene.ts:130-132`)・ラジエータ熱入力(`player.ts:230-233`)・
   電力(`player.ts:235`)・SRP(`dynamics.ts:120-123`)の 4 系統。
   → **月の影に入ってもラジエータは冷えず、SRP は効き続ける。これは描画の問題ではなく物理の欠陥である。**
   遮蔽の統一は、まずここを全天体へ一般化することから始まる。
2. **リング影シェーダが「真の方向 × 偽の位置」を混ぜている。**
   `sunDirNode` は天体の**真の ECI 位置**から引いた方向(`sphere-body.ts:64-65`)なのに、
   `positionWorld` と 32 バンドの `center` / `inner` / `outer` は**圧縮された描画位置・描画長**
   (`celestial-surface.ts:128-150` が `band.innerRadius / bodyRadius * displayScale` で換算)。
   `ring.ts` の `bodyRadius` にも描画スケールが入る(`ring-view.ts:117-124`)。
   → **距離圧縮を撤去しない限り、遮蔽を物理的に正しく統一することはできない。**
   これが §1-3 のカスケード判断と影の統一を結びつける唯一かつ決定的な依存関係である。
3. **CPU/GPU 二重実装が既にある。** `physics/ring-optics.ts:67-78` の `ringPlanetShadow` は
   `render/ring.ts:71-77` の TSL 版と同じ幾何だが、**src のどこからも呼ばれていない**(§3-5)。
   「解析遮蔽ライブラリ」の芽が既にあり、片方が枯れている状態。

**§2-3(B) シェーディングコンテキスト ID を取り下げる理由**: 第一版でこの仕組みを立てた主根拠は
「リング影 32 バンドの固定長 uniform 配列を G-buffer に載せずに済ませる」だった。影が上記の
遮蔽基盤へ移れば、その根拠は消える。残る候補も消える —
天体ごとの `sunDirection` は距離圧縮を撤去すれば単一の平行光で足り、アルベド/粗さは
G-buffer に直接書ける。**天体別シェーディング入力テーブルは不要。**
必要なのは「遮蔽器のリスト」だけであり、それは ID で引くテーブルではなく遮蔽問い合わせの内部構造である。

---

## 2. 第一版の記述の訂正

| 箇所 | 第一版の記述 | 実際 |
|---|---|---|
| §1-1 | 「出力色空間 未設定」 | three r0.169 の既定が `SRGBColorSpace`(`Renderer.js:70-73`)。**色空間は実質正しい**。欠けているのは HDR レンダーターゲットとトーンマッピングのみ(`NoToneMapping` が既定) |
| §1-4 | 「雲影 = UVをずらしたサンプル `earth.ts:55-56` / `earth-color.ts:158-175`」 | `earth-color.ts` は**実行時に使われていない**(§3-5)。該当は `earth.ts:55-56` だけ |
| Phase 1-4 | 「sRGB画像を線形値として誤用していないかを全テクスチャで点検」 | **点検済み。ほぼ問題なし。** 色を持つテクスチャで `colorSpace` 未設定なのは `8k_clouds.jpg` のみで、これは `.r` をマスクに使う用途なので線形扱いが正しい。`earth-color.ts` の線形契約と `export-earth-texture.mjs` の sRGB OETF も整合している |
| §1-5 | 「リング 35バンド → 66描画オブジェクト」 | 帯数 35 は正しい。ただし**土星のテクスチャ環は一度も読まれない**(§3-5)ため、実際は全帯が単色 |
| §5 | 「未決: 露出の基準」「未決: カスケードと浮動原点」「未決: 影」 | いずれも §1 で決定 |

---

## 3. 追加で判明した事実

### 3-1. 光源と陰影の二重世界(第一版の §1-2 を補強)

- シーンライトは **2 つだけ**: `AmbientLight(0x8899bb, 0.25)`(`environment-scene.ts:87`)と
  `DirectionalLight(0xfff4e0, 2.2)`(`:89`)。これを受けるのは `MeshStandardMaterial` の層
  = 艦船・デブリ・薬莢・基地・小惑星のみ(生成 12 箇所、すべて `render/ships.ts`)。
- 天体は全て `MeshBasic(Node)Material` でライト非依存。手書き Lambert + `NIGHT_AMBIENT = 0.04`
  (`celestial-surface.ts:30`)が地球にも他天体にも同じ値で掛かる。
- **「艦が惑星の影に入る」は現状 `DirectionalLight.intensity` のスカラ変調のみ**
  (`environment-scene.ts:147-148`)。形状に依存する影は一切無い。
- 平行光の向きは**描画原点(`fo.r`)から見た恒星方向**(`:145-146`)。`fo.r` を日照の基準点として
  読む唯一の箇所。
- 定数 `AMBIENT_INTENSITY = 0.25`(`const.ts:89`)が定義されているのに、
  `environment-scene.ts:87` は `0.25` を直書きしていて定数を使っていない。

### 3-2. 天体の座標系の扱いが不統一

地球のみ真位置・実半径・`SphereGeometry(R_EARTH, 1024, 768)`(約157万三角形)。
他天体は単位球をスケールする方式(`celestial-surface.ts:113,119`)で、かつ距離圧縮を受ける。
**同じ「天体」でありながら座標系の扱いが 2 通りある。**

### 3-3. `renderOrder` の実測(9 段。うち線の族は集約済み)

**線の族は `LINE_RENDER_ORDER`(`game/const.ts:547`)へ既に集約されている**
(reference:0 / shipOrbit:1 / secondaryTarget:2 / target:3 / plan:4 / predicted:5、消費者 9 箇所)。
表自身のコメントが「同値だと透明描画の前後が不定になる」ので各線が単独で決めない、と方針を明記している。
第一版が「手動 9 段」と呼んだもののうち、**線に関する部分の集約は済んでいる**。

| 値 | 対象 |
|---|---|
| -10 | 星空シェル(`depthTest:false`) |
| -9 | 太陽ビルボード、惑星輝点ビルボード |
| 0 | 天球グリッド、`OrbitLine` 既定、`LINE_RENDER_ORDER.reference`(参照軌道線・静止軌道リング)、天体本体球(暗黙)、点群(暗黙)、艦船モデル(暗黙) |
| 1 | `LINE_RENDER_ORDER.shipOrbit`(自機・敵・基地)、リング(本体 `renderOrder + 1`) |
| 2 | 大気リム(`depthTest:false`)、`SampledLine` 既定、`LINE_RENDER_ORDER.secondaryTarget` |
| 3 | オーロラ、`LINE_RENDER_ORDER.target` |
| 4 | `LINE_RENDER_ORDER.plan`(計画軌道アーク) |
| 5 | **`LINE_RENDER_ORDER.predicted` と `Billboard` 既定が同値** — 下記 |
| 999 | Δv ギズモの `Group` — **THREE は親→子へ伝播しないので実質無効**。前面表示は子の `depthTest:false` で成立 |

**残る問題(Phase 7 で拾う)**:

1. **値 5 の衝突。** `LINE_RENDER_ORDER.predicted = 5` と `Billboard` 既定 = 5(`render/billboard.ts:11`。
   噴射・RCS・再突入・全フラッシュが通る)が同値で、**どちらも半透明**。表のコメントが警告している
   「同値だと前後が不定」が、線の族の**外側**との間でそのまま起きている。集約が線だけを対象にしていて、
   ビルボード・大気リム・オーロラを同じ表に載せていないため。
2. **表の置き場所。** `LINE_RENDER_ORDER` は `game/const.ts` にあり、§5 の
   「`game/` 側で `renderOrder` を決めるのは禁止」に反する。ただし**集約という難所は済んでいる**ので、
   残りは `render/` へ移すことと、上記 1 のために半透明物すべてを 1 つの表へ統合することだけ。
3. `environment-scene.ts:217-218` は `LINE_RENDER_ORDER.reference` で構築した直後に
   `line.line.renderOrder = 0` を重ねて代入している(冗長)。

### 3-4. `frustumCulled = false` は 13 箇所

`stars.ts:32,59` / `celestial-grid.ts:58` / `orbit-line.ts:99` / `sampled-line.ts:102` /
`ring.ts:164,201,275,293` / `celestial-surface.ts:58` / `billboard.ts:22` / `ships.ts:256,304` /
`point-field-view.ts:60`。カスケードで `camera.layers` による振り分けを使う場合、
frustum culling には頼れない。

### 3-5. デッドコード 3 系統(着手前に消す)

1. **`physics/ring-optics.ts:67-78` の `ringPlanetShadow`** — 定義行以外に参照が無い。
   TSL 版(`ring.ts:71-77`)と重複。
2. **土星環テクスチャ経路** — `RingBandDef.texture` を設定した帯が `solar-system.ts` に 0 件のため、
   `2k_saturn_ring_alpha.png` は一度もロードされず、`RING_TEXTURES`(`celestial-registry.ts:33`)と
   `createTexturedRing`(`ring.ts:280-295`)は到達不能。
3. **`earth-color.ts` / `tools/export-earth-texture.mjs` / `src/assets/earth.png`** —
   `earth.png` は src のどこからも import されていない。実行時に使われるのは `earth.jpg`。
   さらに `earth.jpg` と `8k_earth.jpg` は**同一バイト数**(4,565,076)で複製の疑い。

これらは CLAUDE.md の「改名は痕跡を残さない / 旧名エイリアスを残さない」と同じ理由で、
**基盤工事の前に片付ける**。残したまま進めると「二重実装の解消」の対象数を誤る。

---

## 4. ロードマップ 第二版

第一版との対応:

| v2 | 内容 | v1 |
|---|---|---|
| Phase 0 | 座標境界の確定(浮動原点を描画から剥がす) | §4 の一項目 → **昇格** |
| Phase 1 | デッドコード除去と計測基盤・描画設定GUI | Phase 0(範囲拡大) |
| Phase 2 | HDR 線形パイプラインと露出基準 | Phase 1(未決を決定済み) |
| Phase 3 | 深度カスケードのスパイクと判断 | Phase 2 前半(**新設**) |
| Phase 4 | 距離圧縮の撤去 | Phase 2 後半(Phase 3 の判断に従属) |
| Phase 5 | 遮蔽の統一 | Phase 3 の一部 + 未決事項(**独立フェーズへ**) |
| Phase 6 | 遅延シェーディング | Phase 3(**縮小**。コンテキストID を削除) |
| Phase 7 | 半透明パスの統合 | Phase 4 |
| Phase 8 | 大気散乱 | Phase 5 |
| Phase 9 | ポストエフェクト | Phase 6 |
| Phase 10 | LOD とカリング | Phase 7 |
| Phase 11 | ボリュームレンダリング | Phase 8 |

各フェーズは独立に比較可能であること。**一度に全面置換しない。**

### Phase 0 — 座標境界の確定

§1-2。グラフィックの話ではないので最初に片付ける。

1. `render/` から `FloatingOrigin` を剥がす(`orbit-line.ts:119` / `sampled-line.ts:197` の 2 箇所)。
   呼び出し側が `THREE.Vector3` の位置を渡す形にする。
2. 頂点列の生成と頂点バッファのアップロードを分ける(§1-2 の 2 段)。表示 LOD ポリシー
   (サグ・折れ角)は ECI を取らない純関数として `render/` に残す。
3. `sampled-line.ts:28` の `ScaleAtFn`(絶対 ECI を取る関数型の `render/` 側定義)を排除する。
4. f32 精度の実測 — 海王星軌道線とカイパー帯点群に寄って量子化が見えるか
   (§1-2 の表)。見えるなら中心を移す(点群は既に `instanceMatrix` 分担の設計があるので、
   同じ手を軌道線へ広げる)。

**完了条件**: `src/render/**` から `physics` / `game` の座標型への import が 0 件
(`ships.ts` の `game/const` 定数参照は §5 の例外として残す)。

### Phase 1 — デッドコード除去、計測、描画設定GUI

1. §3-5 のデッドコード 3 系統を削除。`AMBIENT_INTENSITY` の直書き重複(§3-1)も直す。
2. `perf-meter.ts` を拡張: `renderer.info` のドローコール数・三角形数、`sync` と `render` の分離計測、
   可能なら GPU タイムスタンプ。**現状は `sync+render` 合算 ms しか出ない。**
3. `render/graphics-settings.ts` を新設。品質プリセット(低/中/高)+ 個別トグル:
   解像度スケール(`setPixelRatio` 上限)、AA、ブルーム、大気、オーロラ、雲、ボリューム、影、点群、LOD バイアス。
   現状 `setPixelRatio(devicePixelRatio)` は上限なしで、**resize 時に読み直してもいない**(`scene.ts:18,22-24`)。
4. `hud/settings-panel.ts` に「描画」タブ。設定はローカル保存し、`main.ts` 起動時に適用。
5. 画像回帰シーンを撮る。**役割は「変更前後の一致判定」ではなく「変化の可読化」**(§1-1)。
   基準ケースは `EARTH_MOON_GRAPHICS_PROPOSAL.md:167-168` の一覧に従う。

**完了条件**: ドローコール数と三角形数が画面に出る。全トグルをオフにしたとき現行と同じ絵が出る。

### Phase 2 — HDR 線形パイプラインと露出基準

§1-1。**すべての後続フェーズの前提。**

1. HDR レンダーターゲット(`rgba16float`)へ描き、出力段で `toneMapping` を経て sRGB へ。
   `outputColorSpace` は既定のままでよい(§2 の訂正)。
2. 露出基準を実装: `E(d) = SOLAR_CONSTANT * (AU/d)^2` を一次基準とし、`exposure` を手動で持つ。
   自動露出は後回し。`SOLAR_PRESSURE_1AU` を `SOLAR_CONSTANT / c` から導出する形へ統一。
3. **101 天体のアルベドを入れる。** 現在の 16 進直書き色(63 種)を、幾何アルベド + 色度へ置き換える。
   **本フェーズ最大の実作業。** 出典をコメントに残す(`RingOpticsDef` の帯コメントが手本)。
4. `Billboard` をノードマテリアル化し、1 を超える輝度を出せるようにする(§1-1)。
   `opacity` による明るさ表現をやめる。太陽・惑星輝点は等級 → 放射照度へ置き換える。
5. `RADIANCE_SCALE = 0.72`(`ring.ts:30`)を 1.0 にする。押し込み係数が要らなくなることを
   露出校正の合否判定に使う。
6. 砲身赤熱を機体温度 + `STEFAN_BOLTZMANN` + `HULL_EMISS` の黒体放射へ置き換える(物理量が既にある)。
7. 手調整値(`NIGHT_AMBIENT`、`SUN_INTENSITY`、各エフェクトの opacity、`ZOOM_MUZZLE_FLASH_SCALE`)は
   **温存せず捨てる。** 必要なら HDR 空間で入れ直す。

**完了条件**: リングの `RADIANCE_SCALE` が消える。ズーム時のマズルフラッシュ減光(`0.02`)のような
LDR クリップ回避のための係数が不要になる。露出を 1 段変えると全体が一様に明るく/暗くなる。

### Phase 3 — 深度カスケードのスパイクと判断

§1-3。**このフェーズの成果物はコードではなく判断である。**

1. `render/view-space.ts` を新設し、順変換 5 種(§1-3)を集約。逆変換 `toEci` を作る。
   **この作業は判断の結果によらず有効**なので先にやる。
2. `types/three-shims.d.ts` に `clearDepth()` を追加。
3. カスケード 2 / 3 / 4 枚のスパイクを作り、§1-3 の測定項目 (a)〜(d) を測る。
4. **判断**: 通れば Phase 4 へ。通らなければ距離圧縮を維持し、Phase 5 の遮蔽統一は
   「圧縮空間の中で幾何を整合させる」限定版になる(§6 に影響を明記)。

### Phase 4 — 距離圧縮の撤去(Phase 3 の判断が可の場合のみ)

1. 天体を真位置・真半径で配置。`sphere-body.ts:76-81` / `point-body.ts:141-147` のスケール計算を削除。
2. `MOON_VIS_DIST` / `PLANET_VIS_DIST` / `POINT_BODY_VIS_DIST` / `SUN_DISTANCE` / `SUN_VISUAL_SIZE` を削除。
   `STAR_SHELL_RADIUS` / `CELESTIAL_SHELL_RADIUS` を「無限遠背景カスケード」へ一本化。
3. `COMBAT_CAMERA_FAR` の根拠(`MOON_VIS_DIST` からの逆算)が消えるので、カスケード境界から引き直す。
4. `sun-body.ts:39-64` / `point-body.ts:96-186` の overview/combat 分岐を削除。
   地球だけが真位置だった不統一(§3-2)も解消する。
5. シーンライトを真の太陽方向へ統一。天体ごとの `sunDirection` uniform の役目が終わる。

**完了条件**: 圧縮定数がゼロ件。ズームを通して天体の見かけサイズが連続。
マップと戦闘でモデルが違う状態が解消。

### Phase 5 — 遮蔽の統一

§1-4。**Phase 4 に依存する**(圧縮下では「真の方向 × 偽の位置」が解消しないため)。

1. **`physics/shadow.ts` の `sunlitFactor` を全天体へ一般化する。** 地球固定の円柱影をやめ、
   `Attractor[]` を取る形にする。これは描画以前に**物理の欠陥修正**であり、
   ラジエータ・電力・SRP の 4 消費者がそのまま恩恵を受ける。
2. 解析遮蔽を CPU/GPU 共通の 1 モデルへ集約。`ringPlanetShadow`(未使用の CPU 版)と
   `inBodyShadow`(TSL 版)の二重実装を解消する。
3. `celestial-surface.ts:63-91` の**固定長 32 バンド uniform 配列を廃止**し、
   遮蔽器リストとして引く形にする。バンド数の上限をシェーダから追い出す。
4. `sunVisibility(worldPos, normal)` を単一の問いとして公開。受け手(天体表面・艦の BRDF・リング・大気)は
   遮蔽器の種類を知らない。
5. 艦・デブリ・基地のシャドウマップ(CSM 3 枚、10 m 〜 30 km)を遮蔽器の 3 種目として追加。
   `castShadow` / `receiveShadow` は現状 0 件なので新規。
6. 太陽の有限角直径による半影を `smoothstep` で入れる。現状 `inBodyShadow` は二値
   (`ring.ts:71-77`)、`sunlitFactor` は `SHADOW_PENUMBRA = 6e4` の線形ぼかし — 基準を揃える。

**完了条件**: 月の影に入るとラジエータの熱入力・電力・SRP・見た目が同時に落ちる。
艦が自分の構造で影を落とす。リング影のバンド数上限がシェーダから消える。
同じ遮蔽現象について CPU と GPU に別実装が無い。

### Phase 6 — 遅延シェーディング(縮小版)

第一版から**シェーディングコンテキストID を削除**した(§1-4)。

```text
ジオメトリパス → MRT G-buffer
    RT0: albedo.rgb                      (rgba8unorm)
    RT1: normal.xy                       (oct符号化, rg16float)
    RT2: roughness / metalness           (rgba8unorm)
    RT3: viewZ                           (r32float)
ライティングパス → HDR color
    BRDF(albedo, normal, roughness, metalness) × 光源 × sunVisibility(...)
```

1. `render/gbuffer.ts`: 上記レイアウト。`pass().setMRT(mrt({...}))`。
2. `render/deferred-lighting.ts`: BRDF(GGX + Lambert diffuse)。艦船の `MeshStandardMaterial` と
   天体の自前 Lambert が**ここで 1 つの BRDF に統合される**。`NIGHT_AMBIENT = 0.04` の
   天体別複製が消える。
3. 遮蔽は Phase 5 の `sunVisibility` を呼ぶだけ。G-buffer に遮蔽の入力を載せない。
4. 地球照(GI)はライティングパス内で扱う。AO の優先度は低い。
5. `earth.ts` の地表シェーダを分解: BRDF 部分は G-buffer へ、もや(`:67-71`)・夕焼け(`:59-64`)は
   Phase 8 の大気パスへ移すため**一旦そのまま残す**。

**なぜ viewZ を専用チャンネルに持つか**: 戦闘カメラの near/far 比は 3e7。24bit ハードウェア深度からの
位置復元は遠方で桁落ちする。深度バッファは可視性判定にのみ使い、シェーディング用の深度は
線形値を別チャンネルに書く。**カスケード導入後は比が縮むので、この判断は Phase 3 の結果を見て見直す。**

**完了条件**: 天体と艦船が同一の BRDF で陰影される。天体を 1 つ追加してもシェーダコードが増えない。

### Phase 7 — 半透明パスの統合

不透明の深度を読む前方描画パス。`renderOrder`(§3-3)を規約へ置き換える。

1. `render/transparent-pass.ts`: 不透明カスケード解決後に描画。`viewportDepthTexture` / `linearDepth`。
2. 「視線に沿って不透明面までメディアを積分する」共通ヘルパ。**大気・オーロラ・プルーム・リングが
   これを共有するのが本フェーズの目的。**
3. `earth.ts:86-124` の大気リム球を廃止 — `depthTest:false` + 自前球交差の回避策(`:96-107`)が不要になる。
4. `aurora.ts` の CPU 頂点更新(`:66-107`)を GPU へ。頂点位置は低頻度更新に留める。
5. `depthTest: false` の 3 箇所(§1-3 の測定項目 c)を規約内へ回収する。
6. **`LINE_RENDER_ORDER` を `render/` へ移し、線以外の半透明物(ビルボード・大気リム・オーロラ・リング)を
   同じ表へ統合する。** 線の族の集約は既に済んでいる(§3-3)ので、残るのは置き場所と適用範囲。
   値 5 の衝突(予測線 vs `Billboard` 既定)はこの統合で解消する。
7. 加算合成の上限は Phase 2 の露出基準に従う(`opacity` による明るさ表現は既に廃止済み)。

**完了条件**: 半透明が不透明面に正しく遮蔽される。`renderOrder` が規約化された少数の値へ収束。

### Phase 8 — 大気散乱(指数密度)

`EARTH_MOON_GRAPHICS_PROPOSAL.md` の「大気パス」(Bruneton型LUT)と整合させる。

1. 透過・単散乱・多重散乱近似を LUT 化(オフライン生成も可)。カメラが大気圏内外どちらでも同じモデル。
2. Phase 7 のレイ積分枠組みへ載せ、エアリアルパースペクティブを不透明深度に対して積分。
   `earth.ts:67-71` のもや(`ATMO_HAZE_TAU0 = 0.34`)を置換。
3. 夕焼けを光路長から導出し、`vec3(1,0.4,0.1)` の固定補間(`:59-64`)を削除。
4. 雲は当面 Phase 6 の地表シェーダ内 2 層サンプリング。太陽方向に追従する雲影で
   `earth.ts:55-56` の UV ずらしを置換。

### Phase 9 — ポストエフェクト

AO は優先度低、グローとレンズフレアは高品質が要る。

1. 露出 → ブルーム(`bloom` ノード)→ レンズフレア/グレア → トーンマッピング → sRGB。
2. ブルーム対象は Phase 2 で HDR 化済みの発光体(太陽・噴射・撃破フラッシュ・マズルフラッシュ・
   再突入プラズマ・惑星輝点)。**再突入プラズマは既に動圧という物理量から強度を引いている**
   (`REENTRY_GLOW_MIN_Q` / `_FULL_Q`)ので、HDR 化の妥当性を検証する基準ケースに使える。
3. TAA/SSAA は Phase 1 のトグル配下で任意。

### Phase 10 — LOD とカリング

**`game/` から切り離して `render/` が持つ。他フェーズへの依存が弱いので、任意の時点で前倒しできる。**

1. `frustumCulled = false` の 13 箇所(§3-4)を見直す。星球シェル等の意図的な箇所だけ理由を残す。
2. スクリーン投影サイズによる統一的な間引き。現在 8 天体にしか無い
   `PHYSICAL_DIAMETER_THRESHOLD_PX`(`point-body.ts:37`)を全 101 天体へ一般化。
3. **地球の `SphereGeometry(R_EARTH, 1024, 768)`(約157万三角形)を距離に応じた分割数へ。**
   単体で最大のジオメトリ負荷。**他のどのフェーズにも依存しない**ので最優先で前倒し可能。
4. リングの線↔面クロスフェード(`ring-view.ts:26-39`)を統一 LOD へ吸収し、
   `ring.ts:182-235` の CPU 側光学**二重実装を削除**。
5. 弾・薬莢・デブリ(最大 1660 個、各 1 メッシュ。弾は body+halo の 2 メッシュ)をインスタンシングへ。
6. 天球グリッド約 960 本の `THREE.Line` をまとめて 1 描画へ。
7. `physics/ring-optics.ts:27-30` の `ringPixelCoverage` を `render/` へ移動。

### Phase 11 — ボリュームレンダリング

Phase 7 のレイ積分枠組みが前提。プルーム・RCS・再突入・オーロラを板ポリゴンから参加媒質へ。
手調整の size/opacity 式が密度分布へ置き換わる。

---

## 5. 責務境界の規則(全フェーズ横断)

> **`game/` は「なにがあるか」を知り、「どう見えるか」を知らない。**
> **`render/` は「どう見えるか」を知り、「どこにあるか(ECI)」を知らない。**

第二版で 2 行目が加わった(§1-2)。Phase をまたいで少しずつ寄せる。一括改修はしない。

### 移す

| 対象 | 現在 | 移動先 | 対応フェーズ |
|---|---|---|---|
| 頂点列の生成(bake / 細分) | `render/sampled-line.ts`, `orbit-line.ts` | `game/` — 座標は `game/` の責務 | Phase 0 |
| 絶対 ECI を取る `ScaleAtFn` 型定義 | `render/sampled-line.ts:28` | 廃止(純関数 `chordCountFor` へ) | Phase 0 |
| `celestial/{sphere,point,sun,earth}-body.ts`, `ring-view.ts`, `point-field-view.ts` | `game/celestial/` | `render/celestial/` — 実質すべてレンダラ | Phase 4 |
| テクスチャURL表・101天体の配色 | `celestial-registry.ts:13-33, 88-195` | `render/`。レジストリには**表示名とidだけ**残す | Phase 2 |
| シーンライト・光量変調 | `environment-scene.ts:87-89, 130-132, 147-148` | `render/` | Phase 6 |
| 参照線の色・不透明度・`renderOrder`・頂点密度方針 | `environment-scene.ts` | `render/` | Phase 7 |
| `ringPixelCoverage`(スクリーン空間量) | `physics/ring-optics.ts:27-30` | `render/` | Phase 10 |
| `RingOpticsDef.color` | `physics/solar-system.ts:107-116, 322` | `render/`。τ・アルベド・位相係数は物理なので残す | Phase 2 |
| エフェクトの size/opacity 式・配色 | `vfx/`, `player/*-effects.ts`, `const.ts:230-247, 499-534` | `render/` | Phase 2 |

### 残す

- `physics/` の THREE 非依存(**現状ゼロ件、維持する**)。
- `physics/ring-optics.ts` の放射伝達5関数、`physics/projection.ts` — 物理・幾何として妥当。
  **`projection.ts` が near/far 非依存であることは、カスケード導入時の重要な資産**(§1-3)。
- `render/ships.ts:6` の `game/const` 参照 — 色・寸法のゲーム調整値なので読み取り専用の例外。
  ただし Phase 2 で色定数が `render/` へ移った後は、この import は寸法のみになる。
- `GameEntity.obj: THREE.Object3D` — 不透明ハンドルとして当面許容。完全な排除は範囲外
  (`game/` の 49 ファイルが `three/webgpu` を import している)。ただし
  **`game/` 側で material / renderOrder / LOD / 色 を決めるのは禁止**とする。

### 判断基準

`game/` に書いてよいのは「この天体が存在する」「この位置(ECI)にある」「破壊された」まで。
「何 px だから点で描く」「`renderOrder` は 3」「色は `0x9a8a7a`」は `render/` の判断。
そして `render/` は ECI を受け取らない — 位置は `THREE.Vector3`(描画座標)で渡る。

---

## 6. リスクと未決事項

| 項目 | リスク | 備考 |
|---|---|---|
| **Phase 2 のアルベド 101 天体** | **高** | 露出フェーズ最大の実作業。出典の無い 63 種の直書き色を、根拠のある値へ置き換える必要がある。データ調査が本体 |
| Phase 3 の判断が否だった場合 | **高** | 距離圧縮が残ると Phase 5(遮蔽統一)が「真の方向 × 偽の位置」を解消できず、限定版に留まる。**この依存はカスケードを試す最大の動機** |
| Phase 0 の頂点生成の移動 | 中 | `sampled-line` は予測軌道・計画軌道・デバッグ線の 3 消費者を持つ。移動先の置き場所を先に決める |
| Phase 3 のカスケード分割数 | 中 | 実測で決める。まず 2〜3 枚 |
| MRT のバンド幅 | 中 | 4RT × 全画面は WebGPU で重い。解像度スケール(Phase 1)で逃げ道を確保 |
| 遅延シェーディング + 半透明 | 中 | 半透明は遅延の恩恵を受けない。Phase 7 は前方描画で確定 |
| WebGPU の TSL LUT サンプリング | 中 | 不安定ならオフライン生成 LUT を読む(既存提案と同方針) |
| CSM と `MeshStandardMaterial` の経路差 | 中 | 艦船は標準マテリアル、天体はノードマテリアルで別経路。Phase 6 の BRDF 統合前に CSM を入れると二重管理になる。**Phase 5 の CSM は Phase 6 の直前に置くか、順序を入れ替えるか要検討** |
| 低性能端末 | 中 | 全部オフでも動くこと。Phase 1 のプリセットが担保 |
| **既存の絵が崩れること** | — | **リスクではない**(§1-1)。露出基準に対して合っていないことが判明するだけ |
| ~~未決: 露出の基準~~ | — | §1-1 で決定 |
| ~~未決: カスケードと浮動原点の相互作用~~ | — | §1-3 で決定(浮動原点は 1 つ、カスケードは near/far のみ)。ただし仮説であり Phase 3 の測定対象 |
| ~~未決: 影~~ | — | §1-4 で決定(単一の問い + 3 層の遮蔽器) |
| 未決: Phase 5 と Phase 6 の順序 | — | 上記「CSM と経路差」に依存。Phase 3 の結果を見て決める |

---

## 7. 最初の一歩

**Phase 0 から着手する。** グラフィックの話に入る前に、`render/` が ECI 座標を受け取らない状態を作る。
触るのは 2 ファイル(`orbit-line.ts` / `sampled-line.ts`)で、`FloatingOrigin` の呼び出しは各 1 箇所しかない。
この時点で f32 精度の実測(海王星軌道線・カイパー帯点群)も済ませる。

続けて Phase 1 で、**着手前にデッドコード 3 系統を消す**(§3-5)。
`ringPlanetShadow` の未使用 CPU 実装を残したまま Phase 5 の「二重実装の解消」を数えると、
対象を取り違える。

Phase 2 のアルベド調査は他フェーズと独立に進められるので、Phase 0/1 と並行して始めてよい。
Phase 10 の地球ジオメトリ分割(約157万三角形)も依存が無く、いつでも前倒しできる。
