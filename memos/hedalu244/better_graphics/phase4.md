# Phase 4 — 深度からの位置復元と、パスの疎結合化

**前提**: Phase 3.5(描画テスト環境)が動いていること。測定はそこで行う。
実装している three の版は `0.185.1`(npm 上の最新。`0.186.x` はまだ出ていない)。

## 目的

**このフェーズの終わりに到達していたい状態:**

> **G バッファとそこからの座標復元が完成し、各パスが疎結合化され、
> あとは個々のフィルターの品質を上げるだけになっている。**

パイプラインの最終形は **不透明(ライトプリパス + 遮蔽)+ 半透明 + ポストプロセス**。
分割の目的は**視覚効果を疎結合にして、後から個別に品質を上げられるようにすること**である。
したがって **Phase 5 以降のどのフェーズも、パイプラインの再構成を伴ってはならない。**
伴うなら、分割した意味が無い。

### 1. 深度は「画素ごとの位置を復元する器」である

求めるのは z-fighting を消すことではない。
**画素ごとに、その面が描画座標(ECI − 浮動原点)のどこにあるかを正確に復元できること**である。

`FloatingOrigin.r` は**アクティブカメラの ECI 位置そのもの**なので、描画座標の原点はカメラであり、
f32 の絶対誤差は「カメラからの距離 × 相対精度」で頭打ちになる。
**この座標系は `render/` の中で完結する** — GPU に ECI 絶対座標は渡らないので、
§1-2 の不変条件を破らずに済む。

復元ができると、**太陽を点光源として扱える。**
画素の復元位置と太陽の位置の**差分ベクトル**から、その画素における太陽の方向と距離が正確に出る。

- **天体ごとの `sunDirection` uniform が要らなくなる。**
- **逆二乗の減衰が画素ごとに正しく効く。**
- **天体を `LIT_OPAQUE_LAYER` へ載せられる。** 自前 Lambert の複製が消える。
- **将来の球エリアライト(Phase 8)は、点を有限の立体角へ替えるだけになる。** 受け手は変わらない。
- **遮蔽も大気も、復元位置を入力に取る画面空間のフィルタとして書ける。**

#### なぜ深度の作り直しが要るのか

復元は `getViewPosition(screenUV, depth, projectionMatrixInverse)`、すなわち
**screenUV(誤差なし)× 深度から得た距離**である。横方向 x,y は z に比例するので、
**復元位置の相対誤差は深度の相対誤差そのもの**になる。

| 距離 z | いま(非反転 `depth24plus`、near=2)の復元誤差 | 反転 `depth32float` の復元誤差 |
|---|---|---|
| 1e4 m | 3.0 m | 6.0e-4 m |
| 1e6 m | 3.0e4 m | 6.0e-2 m |
| 4.5e7 m | **6.0e7 m — far より大きい。復元不能** | 2.7 m |
| 3.8e8 m(月の真位置) | far の外 | 23 m |
| 1.5e11 m(太陽の真位置) | far の外 | 8.9e3 m |

非反転の固定小数点は `Δz = z²·2⁻²⁴/near` で**距離の二乗で悪化する**のに対し、
反転 + float32 は `Δz ≈ z·2⁻²⁴`、**相対誤差 6.0e-8 が距離に依らず一定。**

**「単純な実装では遠方の精度が怪しい」の正体がこれである。** 遠方の画素は復元位置がまるごと
壊れているので、そこから引いた太陽の方向も距離も意味を持たない。
**それが反転 + 32bit で本当に解決するのかを測って判断するのが、このフェーズの前半。**

原理: 非反転は `z_ndc = 1 − near/z` の形で、**1 から微小量を引く**ため浮動小数の桁が落ちる。
反転すると `z_ndc ≈ near/z` になり、**float の指数分布が透視分割の 1/z をそのまま吸収する。**
**深度カスケードで人為的に距離を分ける動機は、これが通れば消える。**

### 2. 距離圧縮を外さないと成立しない

戦闘ビューでは月・惑星・太陽を、見かけの角直径を保ったままカメラ近くの固定距離へ圧縮して置く。
**描画座標が偽物なら、そこから引いた差分ベクトルも偽物である。**
いまは深度だけを真の距離へ引き戻す補正(`CelestialSurface.setDepthScale` →
`celestial-surface.ts:119` の自前 `depthNode`)が入っているが、これは
**表示位置と深度が食い違う状態**を作っているだけで、面の形も法線も圧縮されたままである。
しかもこの `depthNode` は非反転の `viewZToPerspectiveDepth` なので、
深度を反転すると**例外も出さずに裏返る。**

### 3. 1 つのシェーダが不透明と半透明をまたいでいてはならない

**地球がこれに違反している。** `render/earth.ts:51-80` の地表マテリアルは 1 つの `colorNode` に

- アルベド(地表テクスチャ・雲・雲影) — **不透明**
- 昼夜の陰影(`sunFactor`・`NIGHT_AMBIENT`) — **ライティング**
- 大気のもや(`ATMO_HAZE_TAU0` の Beer-Lambert)と夕焼けの色 — **半透明の大気**

を全部混ぜている。加えて大気のリム光(`earth.ts:103-135`)は別メッシュだが、
`depthTest: false` + 自前のレイ・スフィア交差という回避策の上に乗っている。

**これを分けずに Phase 5 以降へ持ち越すと、Phase 10(大気散乱の品質向上)がパイプラインの
再構成を伴うことになる。** それは分割の目的に反する。**分割は Phase 4 で終わらせる。**

なお `DEVELOP/SPEC/RENDERING.md` は既に
**「大気は幾何形状ではなく、視線方向から毎ピクセル計算する解析的な効果として描く」**
と書いている。画面空間のフィルタにすることは、コードを仕様へ寄せる方向でもある。

### 前半と後半

| | 手順 | 独立に commit できるか |
|---|---|---|
| **4-A** | 1〜6。天体を `FloatingOrigin` へ通す → 深度の反転・32bit 化 → 測定と判断 → 距離圧縮の撤去 | できる。ここで止めても絵は正しい |
| **4-B** | 7〜11。太陽の点光源化 → 遮蔽度バッファ → 天体を `LIT_OPAQUE_LAYER` へ → 地球の分割と大気フィルタ | 4-A が済んでいることが前提 |

---

## 決めたこと(覆せる判断)

### (1) 地球を本体(不透明)と大気(半透明の画面空間フィルタ)へ分ける

| いま | Phase 4 後 |
|---|---|
| 地表マテリアル: アルベド + 陰影 + もや + 夕焼け(`MeshBasicNodeMaterial`) | **アルベドだけ**(`MeshStandardNodeMaterial`、`LIT_OPAQUE_LAYER`)。陰影はライティングパス |
| リム光: 半径 R+340km の加算合成シェル、`depthTest: false` + 自前レイ・スフィア交差 | **廃止** |
| — | **`render/pipeline/atmosphere-pass.ts`** — 不透明深度から復元した位置に対し、視線に沿った大気の透過率と内部散乱を評価して不透明の絵の上へ合成する画面空間の半透明フィルタ |

**中身の式は今のものをそのまま持っていく。** もやは `1 − exp(−τ₀/cosθ)`、リムは高度の指数減衰、
夕焼けは `sunDot` による補間。**Phase 4 でやるのは置き場の是正であって、品質の向上ではない。**
Phase 10 はこのフィルタの**中身だけ**を差し替える(LUT 化・多重散乱・光路長からの夕焼け)。

**もやの移動は代数的にほぼ等価である。** いまの
`mix(baseColor, atmoColor, haze·sunFactor)` は、アルファ `a = haze·sunFactor`・色 `atmoColor` の
半透明層を over 合成したものと同じ形をしている。違いは、いまは昼夜係数がもやにも掛かる点だけ
(昼側では `sunFactor ≈ 1` なので差は出ず、昼夜境界付近だけわずかに変わる)。

**リムも同じフィルタで解ける。** 不透明が無い画素(深度 = far)では、視線と大気シェルの交差から
同じ積分をすればよい。**いまリムがやっているレイ・スフィア交差は、そのまま使える。**

**見た目で失われるものが 1 つある。** いまは雲そのものを橙に染める項
(`cloudColorLit = mix(sunsetColor, white, smoothstep(-0.1, 0.2, sunDot))`)があり、
これはアルベドではなくライティングなので albedo から外れる。同じ見た目は大気フィルタの
内部散乱色が担うことになるが、いまの `a = haze·sunFactor` は昼夜境界でゼロへ落ちるので、
**そのままでは終端の橙が薄れる。** 位相の掛け方をフィルタ側で引き直す
(`a = haze`、色の側に太陽依存を寄せる)のが最小の対処。物理的な導出は Phase 10。

### (2) 遮蔽度バッファには、環の影だけでなく天体の本影・半影も載せる

天体をライティングパスの受け手にすると、**環の影の行き場が無くなる**
(いまは `celestial-surface.ts` が 32 帯の透過率積を天体表面シェーダの中で解いている)。
遮蔽度バッファを作って環の影をそこへ送り、ライティングパスで合成する。

**ただし「環の影だけ」では別のものが壊れる。**
`SunLight.sunVisibility()` はいま、CPU が**艦の 1 点**で求めた `sunlitFactor` を返し、
ライティングパスがそれを**全画素へ一様に**掛けている。天体を同じパスへ載せると、
**艦が地球の影に入った瞬間に地球まで暗くなる。** 一様なスカラなので画素で区別できない。

| 案 | 中身 | 評価 |
|---|---|---|
| (a) | 環の帯だけ載せ、CPU スカラはそのまま | **採れない。** 上の破綻がそのまま出る |
| (b) | G バッファへ「受け手の種別」を持たせ、艦の画素にだけ CPU スカラを掛ける | MRT かビットが増える。種別で分岐する規則が残る |
| (c) | **遮蔽度バッファへ天体の本影・半影も載せ、CPU スカラを描画から外す** | **採る** |

**(c) を採る理由**: 増えるのは源 1 種類だけでバッファもチャンネルも増えない。
`physics/shadow.ts` の `occludedFraction`(太陽円盤と遮蔽天体円盤の交差面積比、約 40 行の
閉じた式で本影・金環・半影・完全日照が場合分けなしに出る)が**そのまま移せる**。
**復元位置の最初の実消費者になる。** §1-8 が「描画は `physics/shadow.ts` を読まなくなる」と
既に決めており、その配線切りが前倒しになるだけ(**CPU 側は熱・電力・SRP のために残る**)。

**既知の近似**: 受け手が乗っている天体自身も遮蔽器に数えるので、昼夜境界で N·L と二重に暗くなる。
ずれは地球で ±30 km(直径の 0.2%)。ロードマップは Phase 8 までこれを許容すると決めている。

### (3) 明るさの基準は「天体の見た目を据え置き、艦の環境項を `NIGHT_AMBIENT` へ寄せる」

**いま、艦と天体は独立に調整された 2 つの明るさスケールに乗っている。** 統合すると 1 つになるので、
どれかは必ず動く。

| | いまの昼側 | いまの夜側 |
|---|---|---|
| 天体(`celestial-surface.ts`) | `色 × 1.0` | `色 × NIGHT_AMBIENT`(= 0.04) |
| 艦(ライトプリパス) | `albedo × SUN_INTENSITY`(= 2.2) | `albedo × ambientColor × AMBIENT_INTENSITY`(= 0.25) |

**天体の昼側を据え置くための仕掛け**: 天体の直書き色を **`1 / SUN_INTENSITY` してから
アルベドとして渡す。** §1-1-1 のとおり現状の色は放射照度を畳み込んだ「照らされた見え方」なので、
これは辻褄合わせではなく元に戻す操作である。**Phase 5 が本物のアルベドを入れた時点で消える定数。**

**環境項**: `NIGHT_AMBIENT = 0.04` を基準に `AMBIENT_INTENSITY` を引き直す。
狙いは **天体の影側の色がほぼ変わらず、艦の影側が同等かやや暗くなる**こと。
艦の影側を明るくするのは地球照(Phase 8)が入ってから。

**数値は机上で決めない。** 上の表の比は `THREE.Color` の sRGB→線形変換が掛かるかどうかで
2 倍近く変わり、そこを取り違えると「据え置いたつもりで倍暗い」になる。
**Phase 3.5 の lab で統合前後の同じ球と同じ艦を撮り、夜側の画素値を読んで決める。**

**`SHADOW_MIN_SUN` / `SHADOW_MIN_AMBIENT` の扱い**:

- `SHADOW_MIN_SUN`(= 0.04)は**残す。** 遮蔽度バッファの透過率に掛かる定数として、画素ごとの
  形に無理なく乗る。捨てるのは地球照が入る Phase 8。
- `SHADOW_MIN_AMBIENT`(= 0.35)による**環境光の変調はやめ、環境光を一定にする。**
  この変調は CPU の一様スカラが入力だったので、それを外す以上再構成できない。
  画素ごとに作り直すには地球照のモデルが要り、それは Phase 8。
  **食の中が今より暗くなる** — その差が Phase 8 で埋めるべき量そのものである。

### (4) `toEci` は作らない

必要なのは ECI ではなく描画座標(ECI − 浮動原点)であり、
**その逆変換は GPU 側の `getViewPosition` がやる。** CPU 側に逆変換の消費者はいない。
画面 → 世界の逆投影は `physics/projection.ts` が別に持つ。
使い道のない API を先に作るのは `DEVELOP/CODING-RULE.md` 1.5 の「早急な一般化」にあたる。

### (5) 座標変換の新しいモジュールは作らない。天体を `FloatingOrigin` へ通す

**ECI → 描画座標の写像は `FloatingOrigin.RtoThreeV3`(`game/floating-origin.ts:28`)が既に持っている。**
第二のモジュールを作るのは重複でしかない。**直すべきは「天体だけがその写像を通っていない」ことである。**

| 通っていない箇所 | 中身 |
|---|---|
| `sphere-view.ts:107-112` / `point-view.ts:167-171`(輝点)`:218-222`(星殻上の輝点)/ `sun-view.ts:58-62` | 戦闘ビューで `cam.position + dir * visDist` と置く。**`fo` を一切通らない** |
| `point-field-view.ts:92-99` | 親の `mesh.position` は `fo` を通るが、`instanceMatrix` には太陽中心の生座標が入る。**子だけが通っていない** |

**圧縮は描画座標だけで閉じた操作である。** `FloatingOrigin.r` は
`cameraSystem.activeCameraPos` そのもの(`game.ts:472`)で、`syncCameraToViewpoint` は
`camera.position = fo.RtoThreeV3(view.position)` と置き、その `view.position` は
同じ `activeCameraPos` である(`camera-system.ts:184-186`)。
**したがって `camera.position` は描画座標で厳密に (0,0,0)。**
いまの `cam.position + dir * visDist` は、`p = fo.RtoThreeV3(pos)` を使って

```text
k          = visDist / |p|     … 圧縮率(描画原点 = カメラを中心とする一様な放射スケール)
position   = p * k
scale      = radius * k
depthScale = 1 / k
```

と**厳密に**書き直せる。いまコードに散っている `visDist * radius / dist` も `dist / visDist` も、
この `k` の別表現である。**圧縮は「描画座標 → 描画座標」の関数**であり、ECI も暦も
カメラの ECI 位置も要らない。**だから `render/` に置ける。**

したがって:

- `game/celestial/*-view.ts` は **`fo.RtoThreeV3(pos)` と真の半径を渡すだけ**にする。
  `overviewMode` を見て置き方を変える判断も、表示距離の定数も持たない。
- 圧縮の規則は **`render/view-compression.ts`** が持つ。表示距離の定数もそこへ集める。
  **どの分類にどの距離を使うかは `render/` の判断、その天体がどの分類かは `game/` の事実。**
- **手順 6 で圧縮が消えれば、このモジュールごと消える。**
- **判断が否で圧縮が残るなら、`render/pipeline/` の中へ完全に隠蔽する** — 天体の表示オブジェクトを
  `render/celestial/` へ切り出し、`game/` 側が圧縮関数を呼びさえしない形にする。
  **その設計は否だったときに考える**(先に作ると、消す前提のものに構造を掛けることになる)。

---

## 達成目標

### 4-A

1. **天体の描画位置がすべて `FloatingOrigin.RtoThreeV3` から始まっている。**
   `game/celestial/` に表示距離の定数が 0 件、カメラ位置からの直接配置が 0 件。
2. **圧縮定数が 0 件。** `MOON_VIS_DIST` / `PLANET_VIS_DIST` / `POINT_BODY_VIS_DIST` /
   `SUN_DISTANCE` / `SUN_VISUAL_SIZE` と `render/view-compression.ts` そのものが消える。
3. **`overviewMode` による座標系の分岐が 0 件。** ビューを切り替えても見かけサイズが飛ばない。
4. **`setDepthScale` と `celestial-surface.ts` の `depthNode` が消える。**
5. **`depth-1e4` 〜 `depth-1e11` の 4 ケースすべてで、ε=1e-6 までが澄む。**
   **距離に依らず同じ結果になること自体が目標。**
6. **`order` ケースで、5 本の線が反転前と同じ順に重なる。**
7. **カイパー帯(7.5e12 m)へ 4.7e8 m まで寄っても点群の量子化が見えない。**
8. **`three` を上げると `npm run ci` が落ちる。**

### 4-B

9. **`sunDirNode` / `setSunDirection` が `src/` から消える。**
10. **`environment-scene.ts` が `physics/shadow.ts` を読んでいない。**
11. **艦が地球の影に入っても、地球そのものは暗くならない。**
12. **土星の環の影が本体表面に落ちる。** 遮蔽度バッファ単体に、環の縞と天体の本影が両方写る。
13. **天体の明るさが太陽からの距離に応じて変わる。** 木星圏の天体が地球圏より暗い。
14. **`NIGHT_AMBIENT` と自前 Lambert が `src/` から消える。**
15. **`depthTest: false` が 3 箇所から 2 箇所へ減る。**
16. **どのオブジェクトも「光を受ける不透明」と「半透明」を 1 つのシェーダに混ぜていない。**
17. **明るさ**: 統合前後で **天体の昼側と夜側がほぼ変わらず、艦の影側が同等かやや暗い。**
18. **Phase 10 が `atmosphere-pass.ts` の中だけで完結する見通しが立つ** —
    大気に関わるコードが他のどのパスにも残っていない。

---

## 手順

### 手順 1. 天体を `FloatingOrigin` へ通す

**目的**: 天体だけが `fo.RtoThreeV3` を通っていない状態を解消し、圧縮を `render/` 側の
「描画座標 → 描画座標」の関数へ隔離する。**この時点で挙動は 1 ミリも変えない**
(判断 (5) のとおり `camera.position` が厳密に (0,0,0) なので、書き直しは厳密に同値)。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/view-compression.ts`(新規) | 描画座標に対する圧縮率 `k` と、分類ごとの表示距離。**手順 6 で消える前提のモジュール**である旨と、`camera.position === (0,0,0)` への依存をコメントに書く |
| `src/game/celestial/sphere-view.ts:97-118` | `overviewMode` 分岐と `cam.position` 参照を廃し、`fo.RtoThreeV3(pos)` → 圧縮率 → position/scale/depthScale へ |
| `src/game/celestial/point-view.ts:135-141`(球)`:160-175`(輝点)`:212-225`(星殻上の輝点) | 同上 |
| `src/game/celestial/sun-view.ts:43-64` | 同上 |
| `src/game/celestial/celestial-registry.ts:28` | `PLANET_VIS_DIST` を `render/view-compression.ts` へ移す |
| `src/game/celestial/point-view.ts:40` | `POINT_BODY_VIS_DIST` を同上 |
| `src/render/stars.ts:11-13` | `SUN_DISTANCE` / `MOON_VIS_DIST` を同上へ集める |
| `src/game/celestial/environment-scene.ts:228` / `src/render/celestial-grid.ts:317-318` | `cam.position` を写している箇所を原点直書きへ(**厳密に同値**) |

`earth-view.ts` と `point-field-view.ts` の親位置は既に `fo` を通っているので無変更。
`point-field-view.ts` の `instanceMatrix` は手順 4 の実測しだいなので、ここでは触らない。

**達成条件と検証**

- `game/celestial/` に表示距離の定数(`*_VIS_DIST` / `SUN_DISTANCE`)が 0 件。
- `game/celestial/` に `activeCamera.position` / `activeCameraPos` を使った位置計算が 0 件。
- `src/render/**` から `Vec3` / `FloatingOrigin` 等への import が 0 件のまま。
- 絵が変わっていない。
- `npm run typecheck`
- `grep -rn "VIS_DIST\|SUN_DISTANCE" src/game/` → 0 件
- `grep -rn "activeCameraPos\|activeCamera.position" src/game/celestial/` → 0 件
- `grep -rn "physics/vec3\|floating-origin\|ephemeris" src/render/` → 0 件
- `npm run render-lab:shot` → `leo` / `far` の `prepass` が変更前と同じ絵
- `npm run dev` → 戦闘ビュー ⇄ マップビューを切り替え、月の見かけサイズが飛ばないこと

---

### 手順 2. 深度を反転し、32bit にする(圧縮はまだ残す)

**目的**: 位置復元の相対誤差を距離によらず一定にする器を入れる。
**別々に commit しない** — 途中の状態はどれも「反転したのに比較関数が非反転」
「反転したのに 24bit」のような、絵が壊れるか静かに効かないかのどちらかにしかならない。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/scene.ts:26` | `new WebGPURenderer({ ..., reversedDepthBuffer: true })`。**コンストラクタ引数でしか渡せない**(`@types/three` で `readonly`。実行時も深度比較関数だけが構築時の値 `backend.parameters.reversedDepthBuffer` を読むので、後から代入すると比較関数だけ取り残される) |
| `src/render/pipeline/reversed-sort.ts`(新規) | 既定比較関数の符号反転を `renderer.setOpaqueSort()` / `setTransparentSort()` へ据える。**three `0.185.1` 限定の等価変換**である旨と Issue 番号と撤去手順をコメントに書く |
| `src/render/pipeline/gbuffer.ts:66` | `new THREE.DepthTexture(1, 1, THREE.FloatType)` |
| `src/render/pipeline/render-pipeline.ts:76` | HDR ターゲットへ `depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType)` を明示 |
| `src/render/pipeline/render-pipeline.ts:32` | `viewDistanceFromDepth` の分母の `near` と `far` を入れ替える(反転形は `near·far / (near(1−d) + far·d)`) |
| `src/render/celestial-surface.ts:119` | `viewZToPerspectiveDepth` → `viewZToReversedPerspectiveDepth`(手順 6 で消えるまでの暫定) |
| `package.json` | `three` を `^0.185.1` → `0.185.1`、`@types/three` を `^0.185.4` → `0.185.4` |
| `tools/check-three-pin.mjs`(新規) | 版と `.reverse()` の存在を検査する(下の復帰手順書の「検知」節のとおり) |
| `package.json` の `ci` | 上を検査の連鎖へ足す |
| **この文書** | 下の「three r186 以降へ上げるときの復帰手順書」の節を書く |

**`camera-system.ts` は無変更。** `updateProjectionMatrix()` はレンダラーが立てた
`camera._reversedDepth` を読むので、投影行列は自動的に反転版になる(透視・正射影とも)。
`light-prepass.ts` の `getViewPosition` も `camera.projectionMatrixInverse` を渡しているので追随する。

**達成条件と検証**

- ゲームが起動し、戦闘ビュー・マップビューとも絵が反転前と同じに見える。
- `order` ケースで線の順序が反転していない。
- 深度デバッグ表示が黒一色や白一色にならず、奥行きが読める。
- `three` を上げると `npm run ci` が落ちる。
- `npm run typecheck`
- `npm run render-lab:shot` → `order-prepass.png` が手順 1 と同じ順序
- `npm run dev` → `[Esc]` → 描画設定 → デバッグ表示「深度」で奥行きの階調が見えること
- 実機で戦闘ビューの星空が最前面に来ていないこと(反転ソートの取りこぼしが一番出やすい形)
- `node tools/check-three-pin.mjs` → 通る
- `npm install three@0.186.0 --no-save` を試して検査が落ちること。そのあと `npm install` で戻す

---

### 手順 3. 位置復元の精度を測り、圧縮を外せるかを判断する

**目的**: **このフェーズの分岐点。** 反転 + 32bit で位置復元の相対誤差が距離によらず
一定になるかを確かめ、距離圧縮を外せるかを決める。

**変更が必要な箇所**

コード変更なし。**判断の結果をこの文書へ書き戻す。**

**期待値**: 反転 float32 の `ε_min = 2⁻²⁴ = 5.96e-8`。**4 ケースとも同じ値になるはず。**

**達成条件と検証**

- `depth-1e4` / `depth-1e6` / `depth-1e8` / `depth-1e11` の 4 ケースで、
  斑になる ε の境目が **距離によらず 6e-8 付近**。
- `depthTest: false` の 3 箇所(`stars.ts:34` / `earth.ts:107` / `plan-gizmo-3d.ts:33`)が
  反転後も意図どおりに描かれている。
- フレーム時間が反転前と変わらない。
- **4 ケースの結果を数値でこの文書へ書き戻し、可否を明記してある。**
- `npm run render-lab:shot` → `depth-*.png` の 4 枚を開き、澄んでいる ε と斑の ε を読む
- `npm run dev` → `[F3]` の負荷確認ウィンドウで GPU 各パスの時間を反転前後で比べる
- 実機で星空・大気リム・Δv ギズモが消えていないこと

**否だった場合**: 圧縮を維持し、手順 5 以降を中止する。
**Phase 6 は「圧縮空間の中で幾何を整合させる」限定版に留まる**ことをロードマップ §5 へ書き戻す。
深度カスケード 2 / 3 / 4 枚のスパイクはこのときだけ作る。

---

### 手順 4. 点群の f32 量子化を測る

**目的**: 深度とは独立した、もう 1 つの精度の穴を潰す。
`point-field-view.ts` は `InstancedMesh` のローカル座標へ太陽中心の生座標を書いており、
浮動原点の補正を受けるのは親の `mesh.position` だけ。**instance 側は素の絶対値。**

**導出**: カイパー帯 7.5e12 m での f32 の量子化誤差は `7.5e12 · 2⁻²⁴ = 4.5e5 m`。
これが画面上 1 px に達するのは `4.5e5 = 9.64e-4·z`(fov 55° / 高さ 1080px)すなわち
**`z = 4.7e8 m`** まで寄ったとき。1e8 m まで寄れば `4.7 px`。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/game/celestial/point-field-view.ts:88-100` | **見えたときだけ。** `Curve` と同じ pivot 補正(カメラ近傍の基準点を引いてから f32 へ書く)を入れる |

**達成条件と検証**

- カイパー帯の点へ 1e8 m まで寄っても、点の位置が格子状に量子化されて見えない。
- **見えたか否かを、寄った距離と併せてこの文書へ書き戻してある。**
- `npm run dev` → マップビューでカイパー帯の点へフォーカスし、1e8 m 程度まで寄る
- カメラを微小に動かして、点が格子へ吸い付く動きをしないこと
- 補正を入れた場合は `npm run typecheck`

---

### 手順 5. SPEC を直す(圧縮の撤去に先立って)

**目的**: 仕様はコードより先行する(`CLAUDE.md`)。圧縮を外す前に「どう振舞うべきか」を確定させる。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `DEVELOP/SPEC/RENDERING.md`「浮動小数点精度の扱い」 | 「太陽以外の遠方天体は…圧縮した距離に置いて描く」と、続く「深度だけは真の距離に基づいて計算し直す」→ **すべてのビューで実 ECI 位置・実スケール** |
| 同「浮動小数点精度の扱い」 | 「戦闘ビューの近平面・遠平面は常に 2m・6,000万m で固定」→ 新しい far |
| 同「デバッグ表示」 | 「近平面2m・遠平面6,000万mという比では」→ 新しい比 |
| 同「星野と天球シェル」 | 太陽をビルボードで置く理由と「マップビューで十分に近づくと実位置のメッシュへ入れ替わる」→ 常に実位置 |

**達成条件と検証**

- SPEC に圧縮の記述が残っていない。
- `grep -n "圧縮" DEVELOP/SPEC/RENDERING.md` → 0 件
- `grep -n "6,000万" DEVELOP/SPEC/RENDERING.md` → 0 件

---

### 手順 6. 圧縮を外す

**目的**: 天体を真位置・真半径で描き、描画座標を本物にする。
**ここから先の差分ベクトルがすべて意味を持つようになる。**

**`COMBAT_CAMERA_FAR` の導出**: 戦闘ビューで実際に描かれる最も遠いものは、
球として描かれる天体のうち見かけ直径が 2 px を超える最遠のもの。
`apparentDiameterPx = lodBias · D / (9.64e-4·z) ≥ 2` より `z ≤ lodBias · 519 · D`。
最大の D は太陽の 1.392e9 m、`lodBias` の最大は 2 なので `z ≤ 1.44e12 m`。
**`COMBAT_CAMERA_FAR = 2e12` を採る。** このとき反転 float32 の Δz は `1.2e5 m`、
その距離の 1 px は `1.9e9 m` なので **6e-5 px。far を広げる費用は事実上ゼロ。**

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/view-compression.ts` | **モジュールごと削除。** 手順 1 で作ったものがここで役目を終える |
| `src/game/celestial/sphere-view.ts` | 圧縮の呼び出しと `visDist` 引数を削除。常に真位置・真半径 |
| `src/game/celestial/point-view.ts` | 同上 |
| `src/game/celestial/sun-view.ts` | 同上 |
| `src/render/celestial-surface.ts` | `depthScaleNode` / `setDepthScale` / `mat.depthNode` を削除 |
| `src/render/stars.ts` | `SUN_VISUAL_SIZE` を削除 |
| `src/game/celestial/celestial-registry.ts` | 各 `SphereView` へ渡す `visDist` 引数を削除 |
| `src/game/const.ts:158` | `COMBAT_CAMERA_FAR = 2e12` |
| `src/game/celestial/environment-scene.ts:208, 230` | 星殻を overview で拡大する分岐の見直し |

**達成条件と検証**

- 達成目標 1〜4・6。
- ズームを通して天体の見かけサイズが連続。
- 月・太陽が far の外に落ちていない。
- `npm run typecheck`
- `grep -rn "VIS_DIST\|SUN_DISTANCE\|SUN_VISUAL_SIZE\|setDepthScale\|view-compression" src/` → 0 件
- `grep -rn "overviewMode" src/game/celestial/` → 座標計算の分岐が残っていないこと
- `npm run render-lab:shot` → `order` の順序が変わっていないこと
- `npm run dev` → 戦闘ビューで月・太陽が見え、マップビューへ切り替えても大きさが飛ばないこと
- マップビューを最大までズームアウトしても天体が消えないこと

---

### 手順 7. 太陽を点光源にする

**目的**: ライティングパスが画素ごとに太陽との差分ベクトルを取る形へ替える。
**この時点では受け手は艦だけなので、絵はほとんど変わらない**(艦は浮動原点の近傍にいて、
そこでは点光源と平行光の差が無い)。**変わらないことが正しさの確認になる。**

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/pipeline/sun-light.ts` | 方向 + 強度 → **描画座標での位置 + 半径 + 放射強度**。`angularRadius`(フレームに 1 個のスカラ)は画素ごとに変わる量なので廃す |
| `src/render/pipeline/light-prepass.ts` | `lightDir` を uniform から `normalize(sunPosView − viewPos)` へ。放射照度に `1/|sunPosView − viewPos|²` を掛ける |
| `src/game/celestial/environment-scene.ts` | `sunLight.set()` へ方向でなく描画座標での太陽位置と半径を渡す |

**達成条件と検証**

- `leo` ケースの `diff` が手順 7 の前後で変わらない。
- 艦の陰影が実機で変わって見えない。
- `npm run typecheck`
- `npm run render-lab:shot` → `leo-prepass.png` を手順 6 時点のものと見比べて差が無いこと
- `npm run dev` → 戦闘ビューで艦の陰影が変わっていないこと

---

### 手順 8. 遮蔽度バッファを作る

**目的**: 太陽の直達光の透過率を画素ごとに持つ器を置き、CPU の一様スカラを描画から外す。
**環の影の移し先**であり、**復元位置の最初の実消費者**でもある。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/pipeline/occlusion.ts`(新規) | 復元位置に対し**環の帯**(`celestial-surface.ts` の 32 帯の計算をそのまま移す)と**遮蔽天体の球**(`physics/shadow.ts` の `occludedFraction` を TSL へ)の透過率を求め、1 チャンネルへ書く画面空間パス。合成は**透過率の積**。`SHADOW_MIN_SUN` を床として掛ける |
| `src/render/pipeline/light-prepass.ts` | 遮蔽度バッファを読んで太陽の放射照度へ掛ける。環境光の変調をやめる |
| `src/render/pipeline/sun-light.ts` | `sunVisibility()` の中身をバッファ読み出しへ。`SHADOW_MIN_AMBIENT` の項を削除 |
| `src/render/pipeline/render-pipeline.ts` | 遮蔽パスを G バッファとライティングの間へ |
| `src/gpu-timings.ts` | `GPU_PASS` / `GPU_PASS_LABELS` に遮蔽の 1 行 |
| `src/render/pipeline/debug-target.ts` | 遮蔽度バッファ単体の目視を足す |
| `src/game/celestial/environment-scene.ts` | `physics/shadow.ts` を読んでスカラを渡す配線を切り、**遮蔽天体の位置と半径の列**を遮蔽パスへ渡す |
| `src/game/celestial/sphere-view.ts` / `point-view.ts` | `setRingShadowSystem` の呼び出しを、環の帯を遮蔽パスへ渡す形へ |
| `src/game/const.ts` | `SHADOW_MIN_AMBIENT` を削除 |
| `DEVELOP/SPEC/RENDERING.md` | 描画パイプラインの段数(5 → 6)、デバッグ表示の候補、負荷計測の行 |

環の帯を渡すのは環付き天体 1 体ぶん(画面に環付き天体が複数写る状況は実質起きない。
いまも 1 体ぶんしか持っていない)。**そう決めたことをコメントに残す。**

**達成条件と検証**

- 達成目標 10・11。
- 艦が地球の影へ入るときの減光が連続で起きる(源が CPU から GPU へ移っただけ)。
- 遮蔽度バッファ単体をデバッグ表示で見られる。
- `npm run typecheck`
- `grep -rn "physics/shadow" src/game/celestial/ src/render/` → 0 件
- `npm run dev` → `[Esc]` → 描画設定 → デバッグ表示「遮蔽」で、地球の本影が円として見えること
- 土星へフォーカスし、遮蔽度バッファに環の縞が写ること
- 艦を地球の影へ入れ、**艦だけが暗くなり地球は暗くならない**こと
- `[F3]` で遮蔽パスの GPU 時間が出ること

---

### 手順 9. 天体を `LIT_OPAQUE_LAYER` へ載せ、明るさを合わせる

**目的**: 天体の自前 Lambert を捨て、艦と同じ BRDF・同じ光源で描く。
**天体を 1 つ追加してもシェーダコードが増えない状態**にする。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/celestial-surface.ts` | 自前 Lambert・`NIGHT_AMBIENT`・32 帯の環影・`sunDirNode` を削除し、`MeshStandardNodeMaterial` へ。色は `1 / SUN_INTENSITY` してアルベドとして渡す(判断 (3))。`markLitOpaque` の対象になる |
| `src/game/celestial/sphere-view.ts` / `point-view.ts` | `setSunDirection` の呼び出しを削除 |
| `src/game/const.ts` | `AMBIENT_INTENSITY` を lab の実測から引き直す |
| `DEVELOP/SPEC/RENDERING.md` | 「天体は自分自身の真の位置から見た太陽方向で自ら昼夜の陰影を計算する」→ **画素ごとの差分ベクトル**。夜側の明るさの根拠 |

**地球はこの手順では触らない**(手順 10・11 で分割する)。

**達成条件と検証**

- 達成目標 9・12・13・14・17。
- 天体の昼側と夜側が統合前とほぼ同じ明るさ。艦の影側が同等かやや暗い。
- `npm run typecheck`
- `grep -rn "NIGHT_AMBIENT\|sunDirNode\|setSunDirection\|SHADOW_MIN_AMBIENT" src/` → 0 件
- `npm run render-lab:shot` → `leo-prepass.png` の球の昼側・夜側と艦の影側の画素値を、
  手順 8 時点の同じ画像と数値で比べる(**ここで `AMBIENT_INTENSITY` を決める**)
- `npm run dev` → 木星圏と地球圏の天体を見比べ、明るさが距離に応じて違うこと
- 土星の環の影が本体表面に落ちていること

---

### 手順 10. 地球の大気リムを画面空間フィルタへ移す

**目的**: 大気フィルタの器を作り、**まずリム光だけ**を移して器が正しく動くかを見る。
もやまで一度に移すと「フィルタが壊れている」のか「移し方が違う」のか切り分けられない。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/pipeline/atmosphere-pass.ts`(新規) | 復元位置と視線から大気シェルとのレイ・スフィア交差を解き、高度の指数減衰と夕焼け色で内部散乱を評価して不透明の絵の上へ合成する画面空間パス。**`buildAtmoRim` の式をそのまま移す** |
| `src/render/pipeline/render-pipeline.ts` | 大気パスをマテリアルパスと world パスの間へ |
| `src/render/earth.ts:86-140` | `buildAtmoRim` とリム球を削除 |
| `src/game/celestial/earth-view.ts` | 地球の中心と半径を大気パスへ渡す |
| `src/gpu-timings.ts` | `GPU_PASS` / `GPU_PASS_LABELS` に大気の 1 行 |
| `src/render/pipeline/debug-target.ts` | 大気フィルタ単体の目視を足す |
| `src/render/graphics-settings.ts` | `atmosphere` トグルの効き先をフィルタへ |
| `tools/render-lab/cases.ts` / `webpack.render-lab.config.js` | `earth` ケースを足す(`.jpg` を読むので `asset/resource` のルールが要る) |
| `DEVELOP/SPEC/RENDERING.md` | パイプラインの段数(6 → 7)、デバッグ表示の候補、負荷計測の行 |

**達成条件と検証**

- 達成目標 15(`depthTest: false` が 2 箇所へ)。
- リム光が移す前と同じに見える。
- `earth` ケースが lab に出る。
- `npm run typecheck`
- `grep -rn "depthTest: false" src/` → `stars.ts` と `plan-gizmo-3d.ts` の 2 件だけ
- `npm run render-lab:shot` → `earth-prepass.png` のリムが移す前と同じ
- `npm run dev` → 地球の縁の発光が同じに見え、地球本体に隠れるべき側が光っていないこと
- 描画設定で大気をオフにすると消えること

---

### 手順 11. 地球の地表からもやと陰影を外す

**目的**: 地表マテリアルをアルベドだけにし、**不透明と半透明を 1 枚のシェーダに混ぜている
最後の箇所**を解消する。

**変更が必要な箇所**

| ファイル | 変更 |
|---|---|
| `src/render/earth.ts:41-84` | 地表マテリアルを `mix(shadowColor, vec3(1), cloudAlpha)`(= アルベドだけ)の `MeshStandardNodeMaterial` へ。もや・夕焼け・`NIGHT_AMBIENT`・`sunFactor` を削除 |
| `src/render/pipeline/atmosphere-pass.ts` | もや(`1 − exp(−τ₀/cosθ)`)と夕焼け色を足す。**昼夜境界の橙が薄れる分だけ位相の掛け方を引き直す**(`a = haze` にして太陽依存を色側へ寄せる) |
| `src/game/celestial/earth-view.ts` | `setSunDir` の呼び出しを削除 |
| `DEVELOP/SPEC/RENDERING.md`「地球の描画」 | 地表と大気の役割分担 |

**達成条件と検証**

- 達成目標 16・18。
- 地球の昼側・夜側・昼夜境界が、分割前と見比べて許容できる範囲。
- `npm run typecheck`
- `grep -n "ATMO_HAZE_TAU0\|sunsetColor\|NIGHT_AMBIENT" src/render/earth.ts` → 0 件
- `npm run render-lab:shot` → 分割前後の `earth-prepass.png` を見比べる。**特に昼夜境界の橙**
- `npm run dev` → 地球を昼夜境界が見える角度から眺め、雲の橙が極端に失われていないこと
- 高度 420km から地平線方向を見て、もやが以前と同じように掛かること

---

## three r186 以降へ上げるときの復帰手順書

**なぜ手順書が要るか。** three `0.185.1` の `RenderList.sort`(`RenderList.js:389`)は、
`reversedDepth` のとき custom sort を適用した**あとで** `opaque` / `transparent` /
`transparentDoublePass` を無条件に `.reverse()` する(Issue #33944 / 修正 PR #33945、
マイルストーン r186)。手順 2 はこれを `setOpaqueSort()` / `setTransparentSort()` へ
**既定比較関数の符号反転**を渡して打ち消す。`.reverse()` は sort の直後に無条件で走り、
既定の比較関数は最後に `a.id - b.id` でタイを割る**全順序**なので、
「反転比較でソート → reverse」は「既定比較でソート」と厳密に一致する。

**修正が入った版へ上げると、この打ち消しが余計になり、描画順が黙って逆さになる。**
例外は出ない。星殻が最前面に出て画面が塗り潰され、軌道線の優先度が逆になる。

### 検知

`tools/check-three-pin.mjs` が `npm run ci` の中で次の 2 つを見る。どちらかが崩れたら落とす。

1. `node_modules/three/package.json` の `version` が `0.185.1` であること。
2. `node_modules/three/src/renderers/common/RenderList.js` に、空白を除いた
   `if(reversedDepth){this.opaque.reverse();` が含まれること。

**2 が本質で、1 は補助。** 版を上げなくても振る舞いが変われば落ちるようにしておく。
エラーメッセージにはこの節への参照を書く。

### 手順

1. `package.json` の `three` / `@types/three` を上げ、`npm install`。
2. `node tools/check-three-pin.mjs`。**2 の検査だけが落ちるなら、修正が入っている。**
3. `src/render/pipeline/reversed-sort.ts` を削除し、`src/render/scene.ts` の
   `setOpaqueSort()` / `setTransparentSort()` の呼び出しを消す。
4. `tools/check-three-pin.mjs` を削除し、`package.json` の `ci` からその行を消す。
   `three` / `@types/three` の指定を `^` 付きへ戻す。
5. **検証**: `npm run render-lab:shot` を撮り、`order` ケースで 5 本の線が
   奥から `reference → shipOrbit → target → plan → predicted` の順であることを確かめる。
   **これが唯一の判定** — 手順 3 をやらずに版だけ上げても、やりすぎて両方消しても、
   このケースの絵が逆順になる。
6. `leo` ケースの `diff` が変わっていないこと、実機で星空が最前面に来ていないことを確かめる。

**手順 3 と 4 は同じ commit で行う。** 片方だけ入った状態は、検査が通るのに絵が逆さ、
またはその逆になる。

---

## 見積り

### コード量

| 手順 | 行 | 内訳 |
|---|---|---|
| 1 | +10 | 新規 `render/view-compression.ts` 約 40(圧縮率 15 + 表示距離 15 + 経緯コメント 10)、既存 6 ファイルから約 30 を落とす |
| 2 | +80 | `reversed-sort.ts` 45、`check-three-pin.mjs` 25、既存 5 ファイルへ 6 行 |
| 3・4・5 | ±0 | 測定と SPEC の書き換え |
| 6 | **-115** | 分岐削除 -60、`view-compression.ts` ごと -40、`depthScaleNode` 一式 -12、`visDist` 引数 -3 |
| 7 | +15 | `sun-light.ts` の組み替え |
| 8 | +170 | `occlusion.ts` 150(環 60 + 天体 60 + パス配線 30)、`light-prepass.ts` +15、計測とデバッグ表示 +5 |
| 9 | **-65** | `celestial-surface.ts` -80、標準マテリアル化 +15 |
| 10 | +40 | `atmosphere-pass.ts` 100(リム 60 + パス配線 40)、`earth.ts` -50(リム球)、lab のケース +20 -30 |
| 11 | +35 | `atmosphere-pass.ts` +60(もや 40 + 夕焼け 20)、`earth.ts` -25(もや 12 + 陰影 8 + 雲の位相 5) |

**合計 +170 行前後。** 4-A(手順 1〜6)だけなら **-25 行**の純減。

### GPU コスト

**パスが 2 段増える**(遮蔽・大気)。どちらも全画面 1 枚。

- **遮蔽**: G バッファ深度を 1 回読み、環 32 帯 + 遮蔽天体 4 個の解析式。
  ライティングパス(全画面 1 枚 + GGX 一式)の実測が **0.5ms** なので、**同じ桁 0.3〜0.8ms** と見込む。
- **大気**: 全画面 1 枚 + レイ・スフィア交差 + 指数。**0.2〜0.5ms** と見込む。
  ただし**リム球(96×64 分割の背面シェル、加算合成)が消える**ので world パスがそのぶん減る。
  **差し引きでほぼ相殺と見る。**

**この見積りが外れたら、実測を書き戻す。**

**減る側**: `celestial-surface.ts` の `depthNode` が消えて **early-Z が復活する。**
天体が画面を覆う場面では G バッファパスとマテリアルパスの両方で効く。
32 帯の環影も天体表面の全画素から遮蔽パスの全画素へ移るだけで増えない。
深度テクスチャのビット幅は `depth24plus`(実装上 32bit/texel)からの増分ゼロ。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
|---|---|---|
| **`camera.position === (0,0,0)` の前提が将来崩れる** | 手順 1 の書き直しは `FloatingOrigin.r` がアクティブカメラの ECI 位置と**同じ値**であることに厳密に依存する。原点を自機など別の点へ変えると、**圧縮の中心がカメラからずれて例外も出さずに絵が歪む** | 手順 1。`view-compression.ts` のコメントに依存を明記。**手順 6 で圧縮が消えれば依存も消える** |
| **圧縮の判断を `game/` に残す** | 「どれだけ縮めるか・どのビューで掛けるか」は視覚の判断であって `game/` の責務ではない。views が `overviewMode` を見る形が残ると、Phase 6 以降も同じ分岐を引きずる | 手順 1 の検証のグレップ |
| **`reversedDepthBuffer` を構築後に代入する** | 投影行列とクリア値だけ反転し、深度比較関数(構築時の値を読む)が非反転のまま残る。**手前のものが奥に隠れる**という、原因の見当がつかない壊れ方 | 手順 2。`scene.ts` のコンストラクタ引数に入っているか |
| **RenderTarget の深度を `FloatType` で明示し忘れる** | 自動で `depth32float` になるのは**キャンバス直描きのときだけ**。本作は全パスが RenderTarget なので、**絵は正常なのに精度だけ 24bit のまま**。手順 3 で「反転しても改善しない」と誤結論する | 手順 3。`depth-1e6` で ε=1e-5 が斑のまま残る |
| **`celestial-surface.ts` の `depthNode` を反転版へ替え忘れる** | 天体だけ深度が裏返る。**手前の月が背景の後ろへ回る**が、例外は出ない | 手順 2。戦闘ビューで月が星空に隠れる |
| **`three` を上げて描画順が二重反転する** | 誰も触っていないのに線の重なりが逆さになる | 手順 2 の検査を入れなかったとき。次に依存を更新した日に `order` ケースで露見 |
| **反転比較関数が将来の custom sort と競合する** | `RenderList.sort` は `custom ?? 既定` を使ってから `.reverse()` する。**他所から `setOpaqueSort` を呼ぶと反転が二重になるか消えるか** | 手順 2。`reversed-sort.ts` に「ここが唯一の custom sort である」と書く |
| **正射影のマップカメラで反転が効かない** | 正射影の深度は線形なので反転しても分解能は変わらない。**「反転したのにマップビューが改善しない」を不具合と誤認する** | 手順 3。正射影は 8 bit ぶんだけが効く、が正しい期待値 |
| **手順 3 の判断が否だったのに先へ進む** | 圧縮が残ったまま SPEC だけ「実位置」になり、仕様とコードが食い違う | 手順 5 の入口。**手順 3 の結論を書き戻してから**手順 5 に入る |
| **圧縮撤去後、`far` が足りず遠方天体が消える** | far の外の球は描かれない。**2 px 未満で消えるのと区別がつかない** | 手順 6。`showsPhysicalSphere` で消えているのかを切り分ける |
| **`SphereView` の `visDist` 引数を消し忘れる** | 誰も読まない引数が残る。`private readonly` なので `noUnusedParameters` に引っかからない | 手順 6 の検証のグレップ |
| **点光源化で艦の絵が変わってしまう** | 艦は浮動原点の近傍にいるので、点光源と平行光の差は**出ないのが正しい。** 出たなら太陽の位置か強度の換算を間違えている | 手順 7。`leo` の `diff` |
| **遮蔽度バッファに環だけ載せて CPU スカラを残す** | 艦が地球の影へ入った瞬間、**地球そのものが暗くなる。** 一様スカラなので画素で分けられない | 手順 8〜9。**手順 8 で天体の本影・半影まで載せることが前提** |
| **遮蔽パスをライティングパスの中に書いてしまう** | 環(`ring.ts`)は半透明なので恒久的に前方描画側で、同じ遮蔽を後で必要とする。閉じ込めると Phase 6 で作り直しになる | 手順 8 |
| **受け手が乗っている天体自身を遮蔽器に数える** | N·L と幾何遮蔽が昼夜境界で二重に暗くなる。地球で ±30 km(直径の 0.2%) | 手順 8。**既知の近似として受け入れる**(Phase 8 で天体 id を持たせて除外) |
| **環付き天体が複数写る場面** | 遮蔽パスへ渡すのが 1 体ぶんなので、2 体目の環の影が出ない | 手順 8。**いまと同じ制限**であり後退ではないが、そう決めたことをコメントに残す |
| **明るさを机上の数字で決める** | 天体の色の `1/SUN_INTENSITY` と環境項の換算はどちらも sRGB→線形変換が掛かるかで 2 倍近く変わる。**据え置いたつもりで倍暗い**状態が、誰も気付かないまま基準になる | 手順 9。**lab の画素値で決める** |
| **`SHADOW_MIN_AMBIENT` を消したことで食が暗くなりすぎる** | 影の中が今より暗い。**それは Phase 8 で地球照が埋めるべき量**だが、暗すぎて遊べないなら暫定の床が要る | 手順 8〜9。実機で地球の影へ入る |
| **大気パスの置き場を world パスの中にしてしまう** | メッシュとして置くと、また `depthTest: false` と自前交差の回避策が要る。**Phase 10 が再びパイプラインを触ることになる** | 手順 10。**画面空間のフィルタとしてマテリアルパスと world パスの間に置く** |
| **大気を先に合成することで軌道線との重なりが変わる** | いまリムは `renderOrder = 2` で軌道線の間に居る。フィルタを world パスの前に置くと、**線は必ず大気の手前**になる | 手順 10。`leo` で線とリムの重なりを見る。**変わること自体は許容**だが、意図した変更として記録する |
| **大気フィルタで昼夜境界の橙が薄れる** | 雲を橙に染める項が albedo から外れるため。**物理的にはそれが正しいが、見た目は後退する** | 手順 11。`earth` ケースの昼夜境界。導出は Phase 10 |
