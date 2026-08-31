# `line` / `trajectory` の規範 — 保留中の残件

`rename_ephemeris2.md`(実施完了により破棄)の調査から切り出したもの。あちらは
`ephemeris` / `orbit` / `pack` を片付け、**`line` と `trajectory` だけを未着手で残した。**

**規範の案そのものは提案済みで、片方(`line`)は現用法と完全に一致することを確認済み。**
もう片方(`trajectory`)は**現用法の半分としか合っていない**ので、着手前に何を捨てるかを
決める必要がある。**この文書は決めていない。**

件数・行番号は **`acf7c0f8`** 時点のコードから実測したもの。**維持しない** — 着手時に測り直す。

---

## 1. 案

- **`line`** — **画面に描かれる可視化された線。**
- **`trajectory`** — **物体の軌跡。** `orbit` の上位概念(`orbit` は「基準となる重力源に対して
  定まる軌跡」という下位区分)。

## 2. `line` — 現用法を完全に説明できる

プロジェクト自身が名付けた `*Line` 識別子は、**例外なく描画物**である。

| 群 | 代表 | 描かれるか |
| --- | --- | --- |
| 見た目の宣言 | `LineStyle`(34)/ `LINE_RENDER_ORDER` / `ellipseLineStyle` / `orbitLineColor`(28) | ○ |
| 描画クラス | `EllipseLine`(19)/ `TrajectoryLine`(18)/ `predictedLine`(17)/ `targetRelativeLine`(15)/ `ellipseLine`(15)/ `actualLine`(15)/ `previewEllipseLine`(7) | ○ |
| 集合・管理 | `EntityLineManager` / `entityLines` / `orbitGuideLines`(6)/ `zeroVelocityLines` / `referenceLine`(12、実体は `EllipseLine`) | ○ |
| 当たり判定 | `LinePickable`(13)/ `linePickables`(7)/ `lineWindows`(8) | ○(**描かれている線だけが候補になる**。4節) |
| 生成の下請け | `LineOverlay`(9)/ `svgLinePool`(8)/ `setLinePoints` / `makeLine` / `rebuildLines` / `drawPolylineWithGaps` | ○ |
| 天体グリッド | `poleLine`(9)/ `planeLine`(9)/ `gridLine`(9)(実体は `THREE.Line` / `LineSegments`) | ○ |
| 表示可否 | `lineVisible`(12)/ `showEllipseLine` / `hideEllipseLine` / `lineCountEl` | ○ |

**当たりの残りはすべて「line を含むだけの別語」**で、`pipeline`(78)/ `outline`(44)/
`inline`(27)/ `linear`(14)/ `deadline`(9)/ `baseline`(9)/ `coastline`(7)、
**共線ラグランジュ点の族**(`CollinearPoint` 12・`collinear` 11・`collinearGamma` 10・
`CollinearFrame` 6・`collinearFrame` 5・`collinearBody` 5 = 計 49)、および three.js の API 名
(`LineBasicMaterial` 28・`LineSegments` 21・`lineDistances` 8・`lineWidth` 8・`linecap` 7)。

**この規範は、いま CODING-RULE へ書いても既存コードを1行も動かさない。**

## 3. `trajectory` — 現用法の半分としか合わない

`trajectory` は**4つの意味**で使われていて、**うち2つが互いに真逆。**

| 意味 | 識別子 | 案に合うか |
| --- | --- | --- |
| (a) 軌跡そのもの | `DynamicTrajectory`(22)/ `trajectory-features.ts` / `trajectoryStateAt`(2)/ `trajectorySampleInterval`(6) | **○ そのもの** |
| (b) **`orbit` の上位概念** | `TrajectoryStyles { ellipse, predicted, actual }`(3)/ `sameTrajectoryStyle`(3) | **○ 案どおりの階層が既にコードにある** |
| (c) **`orbit` の兄弟(楕円を除く側)** | `showTrajectoryLine`(29)/ `trajectoryEligible`(5)/ `toggleTrajectoryLine`(5) | **✗ 逆** |
| (d) 描画物・その基準系 | `TrajectoryLine`(18)/ `trajectoryLine`(4)/ `syncTrajectoryLines`(2)/ `TrajectoryFramePanel`(5)/ `trajectoryPanel`(5)/ `trajectoryItem`(6) | **✗ `line` 側の語** |

### (b) と (c) は同じファイルに同居している

`src/game/lines/entity-line-manager.ts`:

- `:31` `interface TrajectoryStyles { ellipse; predicted; actual }` — **楕円を含む総称。**
- `:76` `const fallbackEllipse = !trajectoryEligible && overviewMode && …` — **楕円と排他。**
- `:92` `const trajectoryEligible = isActive || (overviewMode && ship.showTrajectoryLine);`

メニュー文言も `menu-actions.ts:43` が「**予測線・過去線で表示**」で、楕円ではない方を指す。

### 現 CODING-RULE は (c) 側で確定している

`DEVELOP/CODING-RULE.md:516`(`ephemeris` 側の作業で書き換えた行):

> 計画した経路は `path`、積分した軌跡は `trajectory` — **後者は経路が N 体の積分で決まり、
> 1つの基準に対して定まっていない。** 概念が違うので共存させる。

**`orbit` の新しい定義(基準の有無)と対にして書いてあるので、いま `trajectory` を上位概念へ
広げると、この1文と `orbit` 節の両方を書き直すことになる。**

### 動かせないもの

**`showTrajectoryLine` はセーブのキー**(`save-data.ts:96,131,149`。艦・敵・基地の3箇所、
いずれも `?:` の任意フィールドで旧セーブは既定 false)。改名するなら読み替えが要る。

## 4. なぜ `LinePickable` を `TrajectoryPickable` にしなかったか

`ephemeris` 側の作業で `OrbitPickable` → `LinePickable` へ改名した(`95ee9747`)。
`TrajectoryPickable` も候補に挙がったが、**3つの理由で `line` 側にしか落ちない。**

1. **集合の定義が「描かれていること」そのもの。** `line-pickables.ts` は
   「いまフレームにどの線が表示されているか」を集めるだけで、`refresh` は
   `cameraSystem.overviewMode` でなければ**空を返す**。`points` はすべて描画クラス
   (`EllipseLine` / `TrajectoryLine` / `TargetRelativeLine` / `OrbitGuideLines`)の
   `samplePoints()` 由来で、当たり判定は**スクリーン座標**で行う。
2. **`'orbit-guide'` には物体が乗っていない。** CR3BP 族・リサジュー・地球専用参照軌道は
   焼き込んだ形を天体位置へ載せた**参照曲線**で、誰の軌跡でもない。
3. **`TargetRelativeLine`(2点を結ぶ直線)も候補に入る。** 軌跡でも軌道でもない。

**3つの `kind` のうち `trajectory` と呼べるのは `'orbit-body'` / `'orbit-ship'` の2つだけ。**

## 5. 着手するなら、先に決めること

**(b) と (c) のどちらへ倒すか。** ここが決まらないと規範を書けない。

| 倒す先 | 何が起きるか |
| --- | --- |
| **(b) 上位概念** | `showTrajectoryLine` / `trajectoryEligible` / `toggleTrajectoryLine`(計 39)が意味を失うので改名が要る。**`showTrajectoryLine` はセーブのキー**なので読み替えが要る。CODING-RULE の `trajectory` の1文と `orbit` 節も書き直す |
| **(c) 兄弟(現状維持)** | `TrajectoryStyles` / `sameTrajectoryStyle`(計 6)を改名する。楕円・予測線・過去線をまとめる総称が別に要る(`EntityLineStyles` など)。CODING-RULE は触らなくてよい |
| **両方残す** | いまの状態。**同じファイルの中で語の向きが反転しているので、読む側は毎回どちらか判定する必要がある** |

**(d) は倒し方に関わらず `line` 側へ寄る**(`TrajectoryLine` は「軌跡を描いた線」で、
`line` の規範に合う。`TrajectoryFramePanel` は「予測線・計画線の描画基準」を選ぶパネルなので、
(c) を捨てるなら名前も見直す)。

## 6. この件では触らないもの

| 何 | なぜ |
| --- | --- |
| `orbitLineColor`(28) | **セーブのキー**(`save-data.ts:140` / `enemy-save.ts:19`) |
| `MapDisplayToggles` の `*Orbit` キー(10) | **マップ表示トグルの永続キー**(`display-toggles.ts`) |
| `LinePickKind` / `LineCalcMethod` の**値** | `'orbit-body'` / `'orbit-ship'` / `'orbit-guide'` / `'analytic'` / `'predicted'` / `'guide'` は「何を描いた線か」のラベル。型名だけ `Line*` へ改名済み |
| `tools/perf-probe.mjs` の `setOrbitLineFor` | HUD の行ラベルを操作する関数で、この型とは無関係 |
| 共線ラグランジュ点の `collinear*`(49) | `line` を含むだけの別語 |
