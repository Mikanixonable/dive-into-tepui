# グラフィック基盤 — 現況調査とロードマップ

この文書は「個々の天体・エフェクトを個別に作り込む」のをやめ、**疎結合にシェーダを書ける
レンダリングパイプライン**へ移行するための調査結果と実装順序をまとめたものである。
個々の見た目の仕様は `DEVELOP/EARTH_MOON_GRAPHICS_PROPOSAL.md` /
`DEVELOP/PHYSICAL_RING_RENDERING_PROPOSAL.md` が持つ。**この文書はその下に敷く土台だけを扱う。**
両提案の「実装順序 1. HDR線形パイプライン、トーンマッピング、露出を固定する」が、
そのままこの文書の Phase 1 にあたる。

---

## 1. 現況(調査結果)

### 1-1. パイプラインは存在しない

| 項目 | 現況 |
|---|---|
| `THREE.Scene` | 1個(`render/scene.ts:15`)。リポジトリ全体で `new THREE.Scene()` はここだけ |
| `renderer.render()` | **毎フレーム1回**(`game/game.ts:783`)。dock ビューでは0回 |
| レンダーターゲット | **なし**。既定フレームバッファへ直接描く |
| ポストエフェクト | **なし**。`PostProcessing` / `pass()` / `EffectComposer` の使用箇所ゼロ |
| MRT | **なし** |
| トーンマッピング | **未設定**(`renderer.toneMapping` への代入なし) |
| 出力色空間 | **未設定**(`renderer.outputColorSpace` への代入なし) |
| カメラレイヤ | 未使用(`layers.` の出現ゼロ) |

つまり **単一シーン・単一パス・単一マテリアルのフォワード描画**。ユーザーの想定どおりで、
このままではドローコールとシェーダ実装量が天体数・エフェクト数に比例して増え続ける。

### 1-2. ライティングが二重世界に分裂している

**同じ画面の中に、互いを知らない2つのライティングモデルが共存している。**

- **実ライティング世界** — 艦船・デブリ・基地。`MeshStandardMaterial`
  (`render/ships.ts:289-292, 498-499, 518, 531-606`)が、シーンの
  `AmbientLight(0x8899bb, 0.25)` + `DirectionalLight(0xfff4e0, SUN_INTENSITY=2.2)`
  (`game/celestial/environment-scene.ts:101-104`)で照らされる。
- **自前シェーディング世界** — 全天体。`MeshBasicNodeMaterial`(=**アンリット**)に
  手書きの Lambert を載せている(`render/celestial-surface.ts:48-76`,
  `render/earth.ts:49,77`)。シーンライトを意図的に無視し、天体ごとに `sunDirection`
  uniform を持つ。

分裂の原因は正当で、**天体の描画位置が真の位置ではないから**である(1-3)。単一の平行光源は
描画位置に対して向きが合わない。したがって「ライトを1つにする」だけでは解決せず、
パイプライン側の対応が要る(Phase 2 / 3)。

### 1-3. 距離圧縮(visDist)というアドホックの中心

天体は真の位置ではなく、カメラから固定距離 `visDist` の位置へ置き、
`scale = visDist × radius / trueDist` で見かけの角直径だけを保存している
(`game/celestial/sphere-body.ts:70-80`, `point-body.ts:132-140`)。

これは **near/far を1つの深度レンジに収めるための回避策**である。戦闘カメラは
near=2 m / far=6e7 m、比 **3×10⁷**(`game/const.ts:124-125`)。真の位置(月 3.8e8 m、
太陽 1.5e11 m)は far の外なので、圧縮なしには描けない。

派生して次が生まれている。

- `MOON_VIS_DIST = 4.5e7`(`render/stars.ts`)、`PLANET_VIS_DIST = 5e7`
  (`celestial-registry.ts:28`)、`POINT_BODY_VIS_DIST = 5e7`(`point-body.ts:36`)
  — **後2者は同値の重複定義**。
- 星球シェル `STAR_SHELL_RADIUS = 3.5e7`、天球グリッド `CELESTIAL_SHELL_RADIUS = 1.35e10`、
  太陽ビルボード `SUN_DISTANCE = 4.2e7` と、シェル半径が3種類。
- `overview` と `combat` で表示モデルそのものを切り替える分岐
  (`sun-body.ts:33-57`, `point-body.ts:120-178`)。

**この圧縮を撤去できれば、上の定数群と分岐がまとめて消える。** ロードマップ上もっとも
効果の大きい一手であり、Phase 2 に置く理由でもある。

### 1-4. アドホック実装の棚卸し

| 現在の実装 | 場所 | 何が問題か | 置換先 |
|---|---|---|---|
| 手書き Lambert + `NIGHT_AMBIENT=0.04` | `celestial-surface.ts:49,74-76` | BRDFでない。天体ごとに複製 | Phase 3 遅延ライティング |
| **リング影32バンドを表面シェーダに直書き** | `celestial-surface.ts:34-72` | 固定長uniform配列。他の遮蔽物に一般化不能 | Phase 3 シェーディングコンテキスト |
| 大気もや `1-exp(-0.34/cosθ)` | `earth.ts:67-71` | 地表シェーダ内。散乱でない | Phase 5 大気積分 |
| 大気リム球(`R+340km`, 加算, `depthTest:false`) | `earth.ts:86-124` | 深度テストを切り、球交差を解析的に自前計算 | Phase 5 |
| 夕焼け = 固定オレンジ `vec3(1,0.4,0.1)` の補間 | `earth.ts:59-64` | 波長別散乱でない | Phase 5 |
| 雲影 = UVを一定量ずらしたサンプル | `earth.ts:55-56` / `earth-color.ts:158-175` | 太陽方向に追従しない | Phase 5 |
| オーロラ = CPUで毎フレーム全頂点再構築 | `aurora.ts:66-107` | 160×3頂点×4枚をCPU更新。加算板ポリ | Phase 4 → Phase 8 ボリューム |
| プルーム/RCS/再突入 = 加算ビルボード | `thrust-effects.ts:44-51`, `rcs-effects.ts:58-60`, `reentry-effects.ts:40-42` | 手調整の size/opacity 式 | Phase 4 → Phase 8 |
| リング 1px 線 LOD をCPUで別実装 | `ring.ts:182-235` | GPU版と同じ光学を**二重実装** | Phase 7 |
| `renderOrder` 手動9段 | 全体27箇所 | 半透明の順序を人手管理 | Phase 4 で規約化 |

### 1-5. 性能面

**カリングが全面的に無効化されている。** `frustumCulled = false` が
`orbit-line.ts:102`, `celestial-grid.ts:58`, `stars.ts:32,59`, `sampled-line.ts:97`,
`ring.ts:164,201,275,293`, `celestial-surface.ts:78`, `ships.ts:225,273`,
`billboard.ts:22`, `point-field-view.ts:57` に散在。`THREE.LOD` は**ゼロ箇所**。

常駐オブジェクトの実数:

- **天体メッシュ 101個**(`celestial-registry.ts:88-190`)— 画面上2pxでも常に全部描く。
  スクリーンサイズによる間引きは **8個の `planetEntry` にしか無い**
  (`point-body.ts:37` の `PHYSICAL_DIAMETER_THRESHOLD_PX = 2`)。残り90+の
  `SphereBody` は**間引き一切なし**。
- **地球表面 = `SphereGeometry(R_EARTH, 1024, 768)`**(`earth.ts:37`)。約 **157万三角形**、
  地球が2pxのときも同じ。これ単独で最大のジオメトリ負荷。
- リング 35バンド → **66描画オブジェクト**(薄板31本が annulus + line の2個ずつ常駐)。
- 参照軌道線 約100本、点群 7 InstancedMesh / **11,200インスタンス**、
  天球グリッド **約960本の `THREE.Line`**(既定オフだがシーングラフには常駐)。
- エンティティは**インスタンシングなし**、1個1メッシュ。上限は
  弾400 / 薬莢260 / デブリ600 / 小惑星400(`const.ts:194-202`)= 最大1660個。
  弾は body+halo の2メッシュ構成(`ships.ts:223-247`)なので実質さらに多い。

計測基盤も薄い。`perf-meter.ts` は `?perf=1` 限定で、`update` ms と **`sync+render` 合算** ms
しか出さない。**GPU時間・ドローコール数・三角形数は未計測**(`renderer.info` を読んでいない)。

**描画品質のGUIは存在しない。** `hud/settings-panel.ts:24-33` は BGM音量/ミュート/
スナップショット/タイトルへ戻る/閉じる のみ。解像度スケール・AA・エフェクト密度の
いずれの設定項目も無い。`renderer.setPixelRatio(devicePixelRatio)` は上限なしで、
リサイズ時にも読み直さない(`scene.ts:18,22`)。

### 1-6. 責務境界の逸脱

`src/physics/` は THREE を**一切** import していない(この不変条件は保たれている)。
一方 `src/game/` は **49ファイル**が `three/webgpu` を import する。

描画判断が `game/` 側にある具体例:

- `game/celestial/` **8ファイルすべてが実質レンダラ**。距離圧縮(`sphere-body.ts:54-103`)、
  LOD閾値(`point-body.ts:37,120-131`)、輝度階層の size/opacity 表
  (`point-body.ts:24-33`)、リングの線↔面クロスフェード(`ring-view.ts:26-39`)、
  `renderOrder` 代入(`sphere-body.ts:48`, `ring-view.ts:56-61`)、
  シェーダ uniform 組み立て(`ring-view.ts:117-124`)。
- `celestial-registry.ts` が**テクスチャURL表・約100天体の配色・表示名**を兼ねている
  (`:13-33, 88-190`)。天体を1つ登録するのに色を決めさせられる。
- `environment-scene.ts` がシーンライト(`:101-104`)、影に応じた光量変調(`:141-152`)、
  参照線の色/不透明度/`renderOrder`(`:41-42, 74, 87-98`)、
  z-fighting 回避のための頂点密度方針(`:182-204`)を持つ。
- **`physics/ring-optics.ts:27-30` の `ringPixelCoverage(widthMeters, metersPerPixel)`**
  — スクリーン空間量が `physics/` にある。同ファイルの他5関数(Beer–Lambert、
  Henyey–Greenstein、単一散乱、影)は放射伝達の物理なので `physics/` で妥当だが、
  これ1つだけは描画LODである。
- `physics/solar-system.ts:104-122` の `RingOpticsDef` が `color` を持つ
  (`:325-330`)。光学的厚さ・アルベド・位相係数は物理量だが、**色は見た目**。

`GameEntity` 自身が `obj: THREE.Object3D` を持つため、`game/` から THREE を完全に
追い出すのは大改修になる。**この文書では「game/ が描画の *判断* をしない」までを目標にし、
`Object3D` を不透明ハンドルとして持つことは当面許容する**(§4)。

---

## 2. 設計方針

### 2-1. three 0.169 で実現可能なこと(確認済み)

`three/webgpu` バンドルは以下を **すでにエクスポートしている**。追加依存は不要。

- `mrt()` / `MRTNode` / `OutputStructNode` — G-buffer 出力
- `PostProcessing` / `pass()` / `PassNode.setMRT()` / `PassNode.getTextureNode(name)` — パス合成
- `RenderTarget`、`bloom` / `BloomNode`、`gaussianBlur`、`ssaaPass`、`renderOutput`
- `viewportDepthTexture` / `linearDepth` / `getViewPosition` / `screenUV` /
  `perspectiveDepthToViewZ` — 深度参照と位置復元

したがって **標準レンダラのまま遅延シェーディングと深度参照透明を組める**。
自前 WebGPU バックエンドを書く必要はない。

### 2-2. 目標構成

```text
[Phase 2] 深度カスケード: 遠→近の順に N 個の深度レンジを描き、色だけ合成する
   ├ カスケード0 (太陽系スケール)   ┐
   ├ カスケード1 (地球-月スケール)  ├ 各カスケードで下の [G-buffer→ライティング] を実行
   └ カスケード2 (艦船スケール)     ┘

[Phase 3] 不透明パス (カスケードごと)
   ジオメトリパス → MRT G-buffer
       RT0: albedo.rgb           (rgba8unorm)
       RT1: normal.xy            (oct符号化, rg16float)
       RT2: roughness/metalness/shadingContextId (rgba8unorm)
       RT3: viewZ                (r32float ← ハードウェア深度からは復元しない)
   ライティングパス → HDR color
       BRDF(albedo, normal, roughness, metalness) × 光源
       + shadingContextId で引く天体別コンテキスト(太陽方向・リング影・地球照)

[Phase 4] 半透明パス (不透明の深度を読む、前方描画)
   大気 / リング / オーロラ / プルーム / 弾
   → 深度までレイ積分して合成する共通枠組み

[Phase 6] ポストエフェクト
   露出 → ブルーム/グレア → レンズフレア → トーンマッピング → sRGB出力
```

### 2-3. 中核となる2つの設計判断

**(A) 深度カスケードで visDist 圧縮を撤去する。**
深度レンジを分割すれば、天体を**真の位置・真の半径**で描ける。1-3 の圧縮定数・
シェル半径3種・`overview`/`combat` の表示モデル分岐が、まとめて不要になる。
シーンライトの向きも真の位置に対して正しくなるため、1-2 の**ライティング二重世界も
自然に解消する**。ユーザー要求の「アドホックな実装を解体し、物理的な表現に代替する」に
もっとも直接的に応える項目。

**(B) 天体別の陰影入力は「シェーディングコンテキストID」で引く。**
遅延シェーディングの弱点は「マテリアルごとに違う照明計算」ができないことで、素朴にやると
`celestial-surface.ts:34-72` のリング影32バンドのような固定長uniform配列を
G-buffer に載せる羽目になる。代わりに **G-buffer には 8bit の ID だけ**を書き、
ライティングパスがその ID で小さな配列(太陽方向・リング系の記述・地球照の寄与)を引く。
天体を1つ足してもシェーダは変わらず、配列に1要素増えるだけになる
— これが「組み合わせ爆発」を止める仕掛けである。

**なぜ viewZ を専用の r32float チャンネルに持つか。** 戦闘カメラの near/far 比は 3×10⁷
(1-3)。24bit ハードウェア深度からの位置復元は遠方で桁落ちして使えない。深度バッファは
可視性判定(zテスト)にのみ使い、**シェーディング用の深度は線形値を別チャンネルに書く**。
MRT があるのでコストはバンド幅だけで済む。

---

## 3. ロードマップ

各フェーズは独立に比較可能であること。**一度に全面置換しない。**

### Phase 0 — 計測と描画設定GUI(効果を実装する前に)

ユーザー方針「事前に描画設定GUIを作って項目ごとにオンオフできるようにする」に従い最初に置く。
以降の全フェーズが、ここで作ったトグルにぶら下がる。

1. `perf-meter.ts` を拡張: `renderer.info` のドローコール数・三角形数、`sync` と `render` の
   分離計測、可能なら GPU タイムスタンプ。
2. `render/graphics-settings.ts` を新設。品質プリセット(低/中/高)+ 個別トグル:
   解像度スケール(`setPixelRatio` 上限)、AA、ブルーム、大気、オーロラ、雲、
   ボリューム、影、点群、LODバイアス。
3. `hud/settings-panel.ts` に「描画」タブ。既存の BGM 設定と同じ場所。
4. 設定はローカル保存し、`main.ts` 起動時に適用。

**完了条件**: 全項目をオフにしたときに、現行と同じ絵が出る(まだ何も置換していないので)。

### Phase 1 — 色空間・HDR・露出・トーンマッピング

**すべての後続フェーズの前提。** 現在は色空間もトーンマッピングも未設定で、既存の色は
暗黙のLDR sRGBに対して手調整されている。BRDFも散乱も**線形HDRでしか正しく合成できない**。

1. `renderer.outputColorSpace = SRGBColorSpace`、`toneMapping` を明示。
   HDRレンダーターゲット(`rgba16float`)へ描き、出力段で変換。
2. **露出の基準を決める。** 太陽直射・地球照・星明かりで輝度が10桁以上開く。
   物理単位を採用するか正規化するかをここで固定し、以後の全エフェクトがそれに従う。
   自動露出は後回しでよいが、手動露出は必須。
3. 既存の色定数(`const.ts:498-533` の `COLOR_*`、`celestial-registry.ts:88-190` の
   約100天体色、各エフェクトの opacity)を線形空間で再調整。**ここで一度、絵が崩れる。**
4. `earth-color.ts` の出力が既に線形であることを確認済み(`:117-179`)。sRGB画像を
   線形値として誤用していないかを全テクスチャで点検。

**リスク**: 手調整された値が全面的に合わなくなる。Phase 0 の画像回帰シーンを先に用意しておく。

### Phase 2 — 深度カスケード / 距離圧縮の撤去

§2-3(A)。単独で見た目が良くなるわけではないが、**これ以降のすべてを単純にする**。

1. `render/cascade.ts`: N個の深度レンジを定義し、遠いカスケードから順に描いて
   色を合成(深度は引き継がない)。カスケード境界はカメラ距離から導出。
2. 天体を真位置・真半径で配置。`sphere-body.ts:54-103` / `point-body.ts:132-140` の
   スケール計算を削除。
3. `MOON_VIS_DIST` / `PLANET_VIS_DIST` / `POINT_BODY_VIS_DIST` / `SUN_DISTANCE` /
   `SUN_VISUAL_SIZE` を削除。`STAR_SHELL_RADIUS` / `CELESTIAL_SHELL_RADIUS` は
   「無限遠背景カスケード」に一本化。
4. `sun-body.ts:33-57` / `point-body.ts:120-178` の overview/combat 分岐を削除。
5. シーンライトを真の太陽方向に統一。天体ごとの `sunDirection` uniform の役目が
   ここで終わる(リング影など天体固有の入力は Phase 3 のコンテキストへ移す)。

**完了条件**: 圧縮定数がゼロ件。ズームを通して天体の見かけサイズが連続。
既存の「マップと戦闘でモデルが違う」状態が解消。

### Phase 3 — 遅延シェーディング

1. `render/gbuffer.ts`: §2-2 のMRTレイアウト。`pass().setMRT(mrt({...}))`。
2. `render/deferred-lighting.ts`: BRDF(GGX + Lambert diffuse)。艦船の
   `MeshStandardMaterial` と天体の自前Lambertが、**ここで1つのBRDFに統合される**。
3. `render/shading-context.ts`: §2-3(B) のIDテーブル。まず
   `celestial-surface.ts:34-72` のリング影32バンドをここへ移す。
   `celestial-surface.ts` は albedo/normal/roughness を G-buffer に書くだけになる。
4. 地球照(GI)はライティングパス内で扱う。ユーザー指摘どおりAOの優先度は低い。
5. `earth.ts` の地表シェーダを分解: BRDF部分は G-buffer へ、
   もや(`:67-71`)・夕焼け(`:59-64`)は Phase 5 の大気パスへ移すため**一旦そのまま残す**。

**完了条件**: 天体と艦船が同一のBRDFで陰影される。天体を1つ追加してもシェーダコードが
増えない(コンテキスト配列に1要素増えるだけ)。

### Phase 4 — 半透明パスの統合

不透明の深度を読む前方描画パス。ここで `renderOrder` の手動9段を規約に置き換える。

1. `render/transparent-pass.ts`: 不透明カスケード解決後に描画。`viewportDepthTexture` /
   `linearDepth` で不透明面までの距離を得る。
2. 「視線に沿って不透明面までメディアを積分する」共通ヘルパを用意。**大気・オーロラ・
   プルーム・リングがこれを共有する**のが本フェーズの目的。
3. `earth.ts:86-124` の大気リム球を廃止 — 深度テストを切って自前で球交差を解いていた
   回避策(`:96-107`)が不要になる。
4. `aurora.ts` のCPU頂点更新(`:66-107`)をGPUへ。頂点位置は低頻度更新に留める。
5. 加算合成の上限を露出に連動させる(Phase 1 の露出基準に従う)。

**完了条件**: 半透明が不透明面に正しく遮蔽される。`renderOrder` の手動設定が
規約化された少数の値に収束。

### Phase 5 — 大気散乱(指数密度)

ユーザー要求「大気圏の厚みを決め打ちせず、指数関数的な濃度を考慮したい」。
`EARTH_MOON_GRAPHICS_PROPOSAL.md`「大気パス」の Bruneton型LUT方針と整合させる。

1. 透過・単散乱・多重散乱近似をLUT化(オフライン生成も可)。カメラが大気圏内外の
   どちらでも同じモデルを評価する。
2. Phase 4 のレイ積分枠組みに載せ、**エアリアルパースペクティブ**(地表までの散乱)を
   不透明深度に対して積分。`earth.ts:67-71` のもやを置換。
3. 夕焼けを光路長から導出し、`vec3(1,0.4,0.1)` の固定補間(`:59-64`)を削除。
4. 雲は当面 Phase 3 の地表シェーダ内2層サンプリング。太陽方向に追従する雲影で
   `earth.ts:55-56` のUVずらしを置換。

### Phase 6 — ポストエフェクト

ユーザー方針: AOは優先度低、グローとレンズフレアは高品質が要る。

1. 露出 → ブルーム(`bloom` ノード)→ レンズフレア/グレア → トーンマッピング → sRGB。
2. 太陽・エンジン・爆発が正しくブルームするよう、HDR輝度の基準を Phase 1 に合わせる。
3. TAA/SSAA は Phase 0 のトグル配下で任意。

### Phase 7 — LOD とカリング

**game/ から切り離して `render/` が持つ。**

1. `frustumCulled = false` を全面的に見直す。不要な箇所(天体、艦船、点群)は
   カリングを戻す。星球シェル等の意図的な箇所だけ理由を残して維持。
2. スクリーン投影サイズによる統一的な間引き。現在 8天体にしか無い
   `PHYSICAL_DIAMETER_THRESHOLD_PX`(`point-body.ts:37`)を全天体へ一般化。
   **数px未満の天体はメッシュを描かず点として描く。**
3. **地球の `SphereGeometry(R_EARTH, 1024, 768)`(約157万三角形)を距離に応じた
   分割数へ。** 単体で最大のジオメトリ負荷。
4. リングの線↔面クロスフェード(`ring-view.ts:26-39`)を統一LODへ吸収し、
   `ring.ts:182-235` のCPU側光学**二重実装を削除**。
5. 弾・薬莢・デブリ(最大1660個、各1メッシュ)をインスタンシングへ。
6. 天球グリッド約960本の `THREE.Line` を、まとめて1描画へ。
7. `physics/ring-optics.ts:27-30` の `ringPixelCoverage` を `render/` へ移動。

### Phase 8 — ボリュームレンダリング

Phase 4 のレイ積分枠組みが前提。プルーム(`thrust-effects.ts`)・RCS(`rcs-effects.ts`)・
再突入(`reentry-effects.ts`)・オーロラ(`aurora.ts`)を板ポリゴンから参加媒質へ。
手調整の size/opacity 式が密度分布に置き換わる。

---

## 4. 責務境界の規則(全フェーズ横断)

> **`game/` は「なにがあるか」を知り、「どう見えるか」を知らない。**

Phase をまたいで少しずつ寄せる。一括改修はしない。

### 移す

| 対象 | 現在 | 移動先 |
|---|---|---|
| `celestial/{sphere,point,sun,earth}-body.ts`, `ring-view.ts`, `point-field-view.ts` | `game/celestial/` | `render/celestial/` — 実質すべてレンダラ |
| テクスチャURL表・約100天体の配色 | `celestial-registry.ts:13-33, 88-190` | `render/`。レジストリには**表示名とidだけ**残す |
| シーンライト・光量変調 | `environment-scene.ts:101-104, 141-152` | `render/` |
| 参照線の色・不透明度・`renderOrder`・頂点密度方針 | `environment-scene.ts:41-42, 74, 87-98, 182-204` | `render/` |
| `ringPixelCoverage`(スクリーン空間量) | `physics/ring-optics.ts:27-30` | `render/` |
| `RingOpticsDef.color` | `physics/solar-system.ts:104-122, 325-330` | `render/`。光学的厚さ・アルベド・位相係数は物理なので残す |
| エフェクトの size/opacity 式・配色 | `vfx/`, `player/*-effects.ts`, `const.ts:230-247, 498-533` | `render/` |

### 残す

- `physics/` の THREE 非依存(**現状ゼロ件、維持する**)。
- `physics/ring-optics.ts` の放射伝達5関数、`physics/projection.ts` — 物理・幾何として妥当。
- `GameEntity.obj: THREE.Object3D` — 不透明ハンドルとして当面許容。
  完全な排除は本ロードマップの範囲外(49ファイルに波及するため)。ただし
  **`game/` 側で material / renderOrder / LOD / 色 を決めるのは禁止**とする。

### 判断基準

`game/` に書いてよいのは「この天体が存在する」「この位置にある」「破壊された」まで。
「何pxだから点で描く」「`renderOrder` は3」「色は `0x9a8a7a`」は `render/` の判断。

---

## 5. リスクと未決事項

| 項目 | リスク | 備考 |
|---|---|---|
| Phase 1 の再調整 | **高**。既存の手調整値が全面的に崩れる | Phase 0 で画像回帰シーンを先に用意する |
| Phase 2 のカスケード分割数 | 中。分割が多いほどパス数が増える | 実測で決める。まず2〜3枚 |
| MRT のバンド幅 | 中。4RT × 全画面は WebGPU で重い | 解像度スケール(Phase 0)で逃げ道を確保 |
| 遅延シェーディング + 半透明 | 中。半透明は遅延の恩恵を受けない | Phase 4 は前方描画で確定 |
| WebGPU の TSL LUT サンプリング | 中 | 不安定ならオフライン生成LUTを読む(既存提案と同方針) |
| 低性能端末 | 中。全部オフでも動くこと | Phase 0 のプリセットが担保 |
| **未決: 露出の基準** | — | Phase 1 で決める。物理単位か正規化か |
| **未決: カスケードと浮動原点の相互作用** | — | `FloatingOrigin` はカメラ位置基準。カスケードごとに原点を変えるか要検討 |
| **未決: 影** | — | 天体規模のシャドウマップは非現実的。リング影は解析的(Phase 3)。艦船の自己影は別途 |

---

## 6. 最初の一歩

**Phase 0 から着手する。** 効果の実装より前に、(a) ドローコール数と GPU 時間を見える化し、
(b) 品質トグルの器を作り、(c) 画像回帰の基準シーンを撮る。この3つが無いまま Phase 1 で
色空間を変えると、崩れた絵を元に戻せなくなる。
