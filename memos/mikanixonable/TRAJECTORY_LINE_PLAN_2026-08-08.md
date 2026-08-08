# 軌道線描画の修正計画 (2026-08-08)

対象: `src/game/plan/plan-arc.ts` / `src/game/plan/plan-path.ts` / `src/game/plan/plan-display.ts` /
`src/game/plan/plan-editor.ts` / `src/render/sampled-line.ts` / `src/physics/projection.ts` /
`src/game/camera/camera-system.ts` / `src/game/debug-trajectory-line.ts` / `src/game/game.ts` /
`src/game/const.ts`、および新規追加する `src/game/predicted-trajectory-line.ts` と
`src/game/entity-line-set.ts`。

---

## 0. 目的

マップビュー・戦闘ビューに描かれる軌道線の意味づけを、次の視覚言語に統一する。

| 線 | 内容 | 描画 |
|---|---|---|
| 予測軌道 | `GameEntity.predictedTrajectory` を数値積分した、実際に起きる軌道 | **実線** |
| 計画軌道 | マニューバノードが要求する、まだ実現していない軌道 | **破線** |
| 天体表面に達した後 | — | **描かない**(到達地点の ✕ マーカーのみ残す) |

破線の間隔は画面上のピクセルで一定にする。マップビューの倍率は LEO 規模(10⁵ m)から
月軌道規模(10⁹ m)まで4桁変動するため、破線の間隔を実距離で固定すると、拡大時は数本の
線分に、縮小時はサブピクセルになって実線と区別できなくなる。

## 1. 変更後の到達点(仕様)

1. マニューバノードが1つも無い計画では、計画軌道の折れ線を描かない。ノードが無い計画の
   軌道は自艦が実際に乗っている軌道と一致するので、計画として示す情報を持たない。
   ただし折れ線の**積分は続ける**。マップビューで最初のノードを置く手段は
   「計画軌道の線をクリックする」(`src/game/plan/plan-editor.ts` の `handleMapClick` が
   `PlanPath.nearestSample` に問い合わせる)か、「近地点・遠地点アイコンや赤道交点アイコンを
   右クリックして『ここにノードを追加』を選ぶ」(`src/game/map-picker.ts` の `'apsis'` /
   `'eqnode'` 種別)のどちらかであり、両方とも `PlanPath` のサンプル列と
   `src/game/plan/plan-display.ts` のアイコンに依存する。積分を止めると最初のノードを
   置けなくなる。ノードが無い間、計画軌道は自艦の実軌道とほぼ重なるので、描かれている
   予測軌道線の上をクリックすれば、描かれていない計画軌道の線に当たる。
2. 計画軌道の折れ線は、マニューバノードの有無に関わらず常に破線で描く。
3. 計画軌道の折れ線は、噴射前の区間と噴射後の区間で不透明度を変えない。区間の区別は
   `src/game/plan/plan-path.ts` の `SEGMENT_COLORS`(薄橙 `0xffb36b` → 中橙 `0xff8a26` →
   濃橙 `0xff6a00`)による色の違いだけが担う。
4. 計画軌道の積分が天体表面に達した時点で積分を打ち切り、そこから先は描かない。到達地点を
   示す `✕` マーカー(`src/game/plan/plan-display.ts` の `IMPACT_MARKER_KEYS`)は残す。
5. 操作対象の自艦は、`predictedTrajectory` の保持サンプル列を実線の折れ線として描く。
6. 操作対象の自艦の解析楕円(`src/render/orbit-line.ts` の `OrbitLine`)は、5 の折れ線が
   2頂点以上描けているフレームでは抑制する。`predictedTrajectory` は予算付きで少しずつ
   伸びるため、配置直後や高速ワープ中(`SimSpeedManager.canGrowPrediction` が false)には
   短いか空になる。その間だけ解析楕円が見えるフォールバックとして働く。

## 2. 決定事項

### 決定 1: 解析楕円 `OrbitLine` は自艦から取り除かず、フォールバックとして残す

`src/game/player/player.ts` の `Player.orbitLine` を削除して予測軌道線へ全面的に置き換えると、
`predictedTrajectory` が育っていない状態(艦の配置直後、`canGrowPrediction` が false になる
×8 以上のワープ中)で自艦の軌道線が1本も出なくなる。`OrbitLine` は軌道要素から即座に
引けるので、この空白を埋める役に立つ。よって `Player.orbitLine` は残し、予測軌道線が
描けている間だけ `OrbitLine.setSuppressed(true)` で隠す。

この決定の副産物として、`src/game/plan/plan-path.ts` の `detectAnalyticDivergence` /
`analyticDivergent` / `isAnalyticDivergent` / `resetDivergence` と、それらを読む
`src/game/game.ts` の抑制判定が不要になる。これらは「月フライバイなどで計画軌道の積分線と
解析楕円が乖離したとき、二重に見えるのを避けるため解析楕円を隠す」ために存在するが、
予測軌道線が出ている限り解析楕円は常に隠れるので、乖離を検出する必要が無くなる。
`PlanArc` の再積分のたびに全サンプルを走査していた処理も同時に消える。

### 決定 2: 予測軌道線を描く対象は操作対象の自艦のみ

敵(`src/game/game-entity/enemy.ts` の `Enemy.orbitLine`)と基地
(`src/game/game-entity/base.ts` の `Base.orbitLine`)は解析楕円のまま変更しない。
`src/game/predicted-trajectory-line.ts` の `PredictedTrajectoryLine.sync` は対象集合を
毎フレーム引数で受け取る形にするので、対象を敵へ広げるときは `src/game/game.ts` の
呼び出し1箇所を変えるだけで済む。

### 決定 3: 予測軌道線の bake 座標系は `PlanDisplay.planFrame` を使う

`src/game/plan/plan-display.ts` の `PlanDisplay.planFrame`(TRAJECTORY パネルで選ぶ)は
計画軌道の折れ線が描かれる座標系である。予測軌道線を別の座標系で描くと、同じ画面に
異なる座標系の軌道線が2本並ぶことになり比較できない。よって両者は同じ `planFrame` を使う。

この決定により、マニューバノードが無い状態でも TRAJECTORY パネルは意味を持つ(予測軌道線の
座標系を選ぶため)。したがって TRAJECTORY パネルの表示条件は
`src/game/plan/plan-editor.ts` の `editMode` のままとし、折れ線の描画条件
(ノード数 > 0)とは切り離す。

---

## 3. 変更詳細

### 3-1. `src/physics/projection.ts` — 画面尺度の純関数を追加

```
export function metersPerPixel(view: Viewpoint, worldPos: Vec3, viewportHeight: number): number
```

`worldPos` の位置で画面1ピクセルが何メートルに相当するかを返す。
`2 · depth · tan(fovDeg·π/360) / viewportHeight`。`depth` は `projectToNdc` と同じく
カメラ前方軸への射影成分(`-viewZ`)を使い、視点の背後・視点上の点で 0 や負にならないよう
正の下限でクランプする。

ピンホール投影の逆算そのものであり見た目の調整値を含まないので、
`src/physics/projection.ts` に置く(このファイルの冒頭コメントが述べる配置基準に合致する)。

### 3-2. `src/game/camera/camera-system.ts` — `ScaleFn` を追加

`ProjectFn` と対になる型と束縛を足す。

```
export type ScaleFn = (worldPos: Vec3) => number;
```

- モジュール private の `scaleFromViewpoint(view: Viewpoint): ScaleFn` を追加する。
  `projectionFromViewpoint` が `ndcToScreen` へ `window.innerWidth` / `window.innerHeight` を
  渡しているのと同じ位置で、`metersPerPixel` へ `window.innerHeight` を渡す。
- `activeCameraProjection` と並べて `activeCameraScale: ScaleFn` を公開する。中身は
  `scaleFromViewpoint(this.overviewMode ? this.overviewCamera.viewpoint : this.combatCamera.viewpoint)`。

カメラが `Viewpoint` を束縛して配り、消費側は引数で受け取る(import しない)という
`ProjectFn` の扱いをそのまま踏襲する。

### 3-3. `src/render/sampled-line.ts` — 破線パターンの毎フレーム更新を許す

`setDash(dashSize: number, gapSize: number): void` を追加する。`LineDashedMaterial` の
`dashSize` / `gapSize` へ書き込むだけで、破線でない `SampledLine` では何もしない。

頂点に焼く `lineDistance` 属性は実距離 [m] のまま変えない。`syncGeometry` は点列と座標系が
変わったときしか走らないので、毎フレーム動くカメラへの追従を頂点側で行うことはできない。
`dashSize` / `gapSize` は uniform なので、書き換えてもシェーダやパイプラインの再構築は
発生しない見込みだが、`CLAUDE.md` が列挙する WebGPU レンダラーの制約を踏まえ、実装時に
破線が実際にズームへ追従するかを目視で確認する。

`DashPattern` のコメントに、値が実距離 [m] であることに加えて呼び出し側が毎フレーム
書き換えてよいことを明記する。

### 3-4. `src/game/const.ts` — 定数の入れ替え

削除する:

- `PLAN_ARC_GHOST_DASH_M`(3e4)
- `PLAN_ARC_GHOST_GAP_M`(3e4)
- `PLAN_ARC_GHOST_OPACITY_MULT`(0.5)

追加する:

- `PLAN_ARC_DASH_PX` — 計画軌道の破線1本の画面上の長さ [px]。初期値 8。
- `PLAN_ARC_GAP_PX` — 計画軌道の破線の間隔 [px]。初期値 6。
- `PLAN_ARC_OPACITY` — 計画軌道の折れ線の不透明度。初期値 0.85。

### 3-5. `src/game/plan/plan-arc.ts` — 幽霊軌道の削除と常時破線化

削除するもの:

- `ghostLine`(`SampledLine`)
- `preImpactSamples` / `postImpactSamples`
- `splitSamplesAtImpact()`
- `integrate()` 内の `impactBody` と、それに基づく重力源フィルタ
  (`stepAttractors.filter(...)`)および大気抵抗の切り替え(`impactBody ? 0 : C.SHIP_BCINV`)
- `THREE.Group`(線が1本になるので不要)。`object3d` は `SampledLine` の `line` を直接返す。

変更するもの:

- コンストラクタは常に破線で `SampledLine` を構築する。`dashSize` / `gapSize` の初期値は
  何を渡しても `sync()` が毎フレーム上書きするので、`PLAN_ARC_DASH_PX` / `PLAN_ARC_GAP_PX`
  をそのまま(1 m/px 相当として)渡しておけばよい。
- `integrate()` のループ内で `hitAttractor` が天体を返したら、`impactState` に到達状態を
  記録し、`truncated = true` を立てて `break` する。非有限値による打ち切り・
  `PLAN_ARC_MAX_STEPS` による打ち切りと同じ経路になる。`truncated` が立つと
  `endState()` は `null` を返すので、その区間を起点とする後続ノードは繋がらなくなる
  (天体に衝突する計画で後続ノードが破綻するのは正しい振る舞い)。
- `sync()` の引数に `dashSize: number, gapSize: number` を追加し、`SampledLine.setDash` を呼ぶ。

維持するもの:

- `impactPoint()` — `src/game/plan/plan-display.ts` の `impactIconsOf()` が読み、
  `✕` マーカーの位置になる。

### 3-6. `src/game/plan/plan-path.ts` — 不透明度の統一と破線サイズの算出

- `arcOpacity`(区間 0 は 0.55、それ以降は 0.85)を削除し、`PlanArc` の生成時に
  `C.PLAN_ARC_OPACITY` を一律で渡す。`SEGMENT_COLORS` と `arcColor` は変更しない。
- `sync(fo, project)` の引数に `scale: ScaleFn` を追加する。区間ごとに、その区間の
  サンプル列の中央のサンプルを `toDisplay(r, t)` で表示座標(絶対 ECI)へ変換し、
  `scale()` へ渡して m/px を得る。`C.PLAN_ARC_DASH_PX` / `C.PLAN_ARC_GAP_PX` に掛けた
  実距離を `PlanArc.sync` へ渡す。サンプルが0本の区間は `setDash` を呼ばず据え置く。

  表示座標変換をこのクラスに閉じるのは、`PlanPath` が「表示座標変換と画面判定を行う唯一の
  場所」である責務分担に従うため。`PlanArc` は自分のサンプルが最終的にどこへ描かれるかを
  知らない。
- `detectAnalyticDivergence` / `analyticDivergent` / `isAnalyticDivergent` /
  `resetDivergence` を削除する(決定 1 を参照)。これに伴い
  `orbitalElementsOf` / `strongestAttractor` の import が不要になる場合は取り除く。

### 3-7. `src/game/plan/plan-display.ts` — 折れ線の可視性だけをノード数で決める

`sync(fo, project, showPanel)` の中で、折れ線の可視性を計画のノード数から決める。

- `this.path.setVisible((this.plan?.nodes.length ?? 0) > 0)` とする
  (`update(plan, simTime, displayTime, show)` は `show` が真のとき `this.plan = plan` を
  保持しているので、`sync` からノード数を読める)。`PlanPath.sync` 自体はノード数に
  関わらず毎フレーム呼ぶ — `PlanPath.sync` は画面判定が使う `project` を毎フレーム受け取って
  保持しており、これを止めると `handleMapClick` の当たり判定が過去の視点で行われる。
- `PlanPath.sync` の内側にある `arc.setVisible(true)` は、`PlanPath.group` の可視性で
  一括して覆われるため変更しない。
- マーカー同期(`syncGhost` / `syncApsisMarkers` / `syncEqNodeMarkers` / `syncImpactMarkers` /
  `syncDayTickMarkers`)は変更しない。ノードが無い間も近地点・遠地点アイコンと赤道交点
  アイコンは出したままにする — 最初のノードを置く経路の一つがこれらの右クリックだから
  (第1節の項目1を参照)。`⬡` ゴーストマーカーは `ghostAt` が既にノード数0で `null` を
  返すので、追加の変更は要らない。
- TRAJECTORY パネルの表示は `showPanel` のみで決める(決定 3 を参照)。変更しない。
- `resetDivergence()` の呼び出しを削除する。

`hide()` と `update()` は変更しない。

### 3-8. `src/game/plan/plan-editor.ts` — 破線尺度の引き渡しのみ

表示条件は変更しない。`update` の
`this.hasPlan && (this.editMode || this.plan.nodes.length > 0)`、`sync` の同じ条件、
ノードギズモと MANEUVER PLAN パネルの条件(`this.hasPlan && this.editMode`)はすべてそのまま
残す。ノードが無い間に折れ線を隠すのは `PlanDisplay` の役目(3-7)であり、`PlanEditor` は
計算を止めない。

変更は1点だけ:

- `sync` に `scale: ScaleFn` を引数として追加し、`planDisplay.sync` へ渡す
  (`PlanDisplay` はさらに `PlanPath.sync` へ渡す)。

### 3-9. `src/game/entity-line-set.ts`(新規)— エンティティ別の線の管理

`src/game/debug-trajectory-line.ts` の `DebugTrajectoryLine` は
`Map<GameEntity, SampledLine>` を持ち、対象に無いエンティティの線を `dispose` して
GPU リソースの解放漏れを防いでいる。`PredictedTrajectoryLine` も同じ管理を必要とするため、
この部分を切り出して両者で共有する。

```
export class EntityLineSet {
  constructor(scene, factory: () => SampledLine)
  lineFor(entity: GameEntity): SampledLine   // 無ければ生成してシーンへ追加
  pruneTo(alive: ReadonlySet<GameEntity>): void  // 集合に無い線をシーンから外して dispose
}
```

色・不透明度・`renderOrder` は `factory` が決めるので、このクラスは線の見た目を知らない。

### 3-10. `src/game/predicted-trajectory-line.ts`(新規)— 予測軌道の実線

```
export class PredictedTrajectoryLine {
  constructor(scene: THREE.Scene)
  sync(targets: readonly GameEntity[], frame: ReferenceFrame, simTime: number,
       ephemeris: Ephemeris, fo: FloatingOrigin): void
  hasLineFor(entity: GameEntity): boolean
}
```

- 各対象の `entity.predictedTrajectory?.samplesOldestFirst() ?? []` を
  `SampledLine.syncGeometry` / `syncTransform` へ渡す。過去の履歴
  (`actualTrajectory.history`)は含めない。
- 色は `0xbfc9d4`、不透明度 0.55、`renderOrder` 1 とする。これは
  `src/game/player/player.ts` の `Player.orbitLine`(`new OrbitLine(0xbfc9d4, 0.55)`、
  `OrbitLine` のコンストラクタが `renderOrder = 1` を設定)と同一で、抑制される解析楕円と
  入れ替わっても見た目が変わらない。
- `hasLineFor(entity)` は、その対象の折れ線が実際に描画されている(サンプルが2点以上ある)
  かを返す。`src/game/game.ts` が `OrbitLine.setSuppressed` の条件に使う。
  `src/render/sampled-line.ts` の `SampledLine` は頂点数が2未満のとき `applyVisible()` で
  自身を隠すという判断を既に内側に持っているので、`SampledLine` に `get visible(): boolean`
  (`this.line.visible` を返す)を足して `hasLineFor` はそれを読む。
  `PredictedTrajectoryLine` がサンプル数を数え直すと、同じ判断が2箇所に分かれる。
- 予測サンプルの上限は `C.PREDICT_MAX_SAMPLES`(2000)で、`SampledLine` の
  `MAX_VERTICES`(16384)は 1 辺あたり平均 8 本のエルミート細分まで吸収できる。
  `PLAN_ARC_MAX_SAMPLES` も 2000 なので、頂点予算は計画軌道の1区間と同じであり
  `src/render/sampled-line.ts` に変更は要らない。

### 3-11. `src/game/debug-trajectory-line.ts` — `EntityLineSet` を使う形へ

`Map<GameEntity, SampledLine>` の生成・prune・dispose を `EntityLineSet` へ委ねる。
描く内容(過去の履歴 + 現在状態 + 未来の予測を1本に連結)と色 `0x40e0ff`、
`?debugLines=1` による有効化は変更しない。

このファイルの冒頭コメントは bake 座標系として `PlanDisplay.planFrame` を渡すと書いているが、
`src/game/game.ts` は `overviewMode ? overviewCamera.cameraFrame : INERTIAL_FRAME` を
渡している。予測軌道線が `planFrame` を使う(決定 3)のに合わせ、`DebugTrajectoryLine` へ
渡す座標系も `planFrame` に揃え、コメントと実際の呼び出しを一致させる。

### 3-12. `src/game/game.ts` — 配線

- `PredictedTrajectoryLine` を構築して保持する。
- `sync` フェーズで、生存中の操作対象の自艦を対象として
  `predictedTrajectoryLine.sync([player], this.editor.planDisplay.planFrame, simTime, this.ephemeris, this.floatingOrigin)`
  を呼ぶ。自艦が存在しない/死亡しているフレームでは空配列を渡し、`pruneTo` に線を畳ませる。
- 解析楕円の抑制を
  `player.orbitLine.setSuppressed(this.predictedTrajectoryLine.hasLineFor(player))` に変える。
  `overviewMode` の条件は外す。戦闘ビューでも予測軌道線を描く以上、二重に見える問題は
  両ビューで同じだから。
- `this.editor.planDisplay.path.isAnalyticDivergent` の参照を削除する。
- `debugTrajectoryLine.sync` へ渡す座標系を `this.editor.planDisplay.planFrame` に変える。
- `this.editor.sync(...)` の呼び出しに `this.cameraSystem.activeCameraScale` を渡す。

---

## 4. 実装順序

1. `src/physics/projection.ts` の `metersPerPixel` と、そのテストを追加する。
2. `src/game/camera/camera-system.ts` の `ScaleFn` / `activeCameraScale` を追加する。
3. `src/render/sampled-line.ts` の `setDash` を追加する。
4. `src/game/const.ts` の定数を入れ替える。
5. `src/game/plan/plan-arc.ts` から幽霊軌道を取り除き、常時破線にする。
6. `src/game/plan/plan-path.ts` の不透明度統一・破線サイズ算出・乖離検出の削除を行う。
7. `src/game/plan/plan-display.ts` の折れ線可視性をノード数で決めるようにし、
   `src/game/plan/plan-editor.ts` へ `ScaleFn` の引き渡しを追加する。
8. `src/game/entity-line-set.ts` を追加し、`src/game/debug-trajectory-line.ts` を置き換える。
9. `src/game/predicted-trajectory-line.ts` を追加する。
10. `src/game/game.ts` を配線し、解析楕円の抑制条件を差し替える。

5〜7 の段階では予測軌道線がまだ無いため、マニューバノードが無い状態で自艦の軌道線が
解析楕円だけになる。10 まで進めて初めて仕様(第1節)を満たす。途中の段階で動作を確認する
場合はこの点を織り込む。

## 4-1. 残るリスク

`predictedTrajectory` は `src/game/simulation/predictor.ts` の `Predictor.resyncPrediction` が
実状態との乖離を検出すると破棄する。破棄された直後のフレームは折れ線が2頂点未満になるため、
予測軌道線が消えて解析楕円が現れる。`Predictor` は破棄したリストを次フレームから予算内で
描き直すので、乖離が頻発する状況(高倍率ワープ中、噴射中)では2本の線が交互に見える
可能性がある。実装後にこの点を目視で確認し、ちらつきが目に付く場合は
`OrbitLine.setSuppressed` を数フレーム保持する(予測軌道線が消えてもすぐには解析楕円へ
戻さない)対処を検討する。抑制の保持は状態を1つ増やすので、実際にちらつきが観測された
場合にだけ入れる。

## 5. 検証

- `npm run typecheck` — 全段階で実行する。
- `npm run test:physics` — `src/physics/projection.ts` を変更するため必須。
  `tests/physics/projection.test.ts` に `metersPerPixel` の検証を追加する:
  視点から既知の距離にある点で、`metersPerPixel` 倍の変位を与えたときの
  `projectToNdc` → `ndcToScreen` の結果が、ちょうど1ピクセル動くこと。
- 実行時の目視確認(`/verify`、ユーザーが求めた場合のみ):
  - マップの倍率を LEO から月軌道まで変えたとき、計画軌道の破線の間隔が画面上で一定に
    見えること。
  - マニューバノードを1つ置くと破線が現れ、削除すると消えて実線の予測軌道線だけになること。
  - 大気圏に突入する計画で、折れ線が地表で終わり `✕` マーカーが出ること。

## 6. 設計文書の更新(同じ変更セットに含める)

- `CLAUDE.md`
  - `src/game/predicted-trajectory-line.ts` と `src/game/entity-line-set.ts` の項を追加する。
  - `src/game/camera/camera-system.ts` の項に `ScaleFn` / `activeCameraScale` を追加する。
  - `src/physics/projection.ts` の項に `metersPerPixel` を追加する。
  - `src/game/plan/plan-arc.ts` の項から幽霊軌道(衝突後に天体を除いて伝播を続ける記述)を
    削除し、天体表面到達で打ち切ることを書く。
  - `src/game/plan/plan-path.ts` の項から `detectAnalyticDivergence` の記述を削除する。
  - `src/render/orbit-line.ts` / `src/render/sampled-line.ts` を説明する箇所の配色の節に、
    実線と破線の意味づけ(第0節の表)を書く。
  - 定数 `PLAN_ARC_GHOST_*` への言及を `PLAN_ARC_DASH_PX` / `PLAN_ARC_GAP_PX` /
    `PLAN_ARC_OPACITY` に置き換える。
- `DEVELOP/OWNERSHIP.md`
  - `Game` が `PredictedTrajectoryLine` を所有することを追加する。
  - `PlanArc` の `ghostLine` を削除する。
  - `PlanPath` の `analyticDivergent` を削除する。
- `DEVELOP/CALLSTACK.md`
  - `sync` フェーズに `predictedTrajectoryLine.sync()` を追加する。
  - `PlanArc.sync` の幽霊線同期を削除する。
  - `player.orbitLine.setSuppressed()` の条件の変更を反映する。
- `DEVELOP/SPEC.md`
  - マニューバノードを置くまで計画軌道の線は描かれないが、近地点・遠地点アイコンと
    赤道交点アイコンは出ており、そこから、または予測軌道線の上をクリックして最初のノードを
    置けることを書く。
  - 計画軌道は破線で描かれること、
    天体表面到達地点で終わり以降は描かれないこと(`✕` マーカーは出ること)、
    噴射前後で濃さが変わらないことを書く。
  - 操作対象の自艦に実線の予測軌道線が出ること、それが出ている間は解析楕円が出ないことを書く。
  - 破線の間隔が画面上で一定であることを書く。
