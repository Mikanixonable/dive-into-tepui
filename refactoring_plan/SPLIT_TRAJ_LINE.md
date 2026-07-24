# 軌道表示責務の分割（TrajLine / predict / frameRotating の疎結合化）

素案 [SPLIT_TRAJ_LINE_DRAFT.md](SPLIT_TRAJ_LINE_DRAFT.md) を、現状コードとユーザからの設計方針を踏まえた実行計画へ落とし込む。
先行する [SPLIT_PREDICT_SYSTEM.md](SPLIT_PREDICT_SYSTEM.md)（plan と predict の分離）・[SPLIT_MAP_MODE.md](SPLIT_MAP_MODE.md)（mapMode 三分割）の完了状態を土台とし、
本書は「軌道を **描画する** 責務」そのものの再整理を扱う。

---

## 0. 結論（実現性・確定方針・検証結果）

**実現性は高い。** 素案の A / X / B-1 / B-2 / C の分類は現状コードの責務境界と素直に対応する。以下を確定方針とする:

1. **3D シーンは常に慣性系（＝シミュレーション座標系）で描く。** frameRotating で **シーン全体の描画を差し替えない**（大幅な密結合になるため）。
   frameRotating は「予測軌道という **個々の描画物** をどの座標系に固定して見せるか」だけの、局所的な表示変換に閉じる。
   - 検証済み: **シミュレーションは地球中心の慣性系（ECI）**。中心重力＋J2＋**差分（潮汐）第三体**（時変の太陽・月位置）で積分し、
     `EARTH_OMEGA` は共回転大気の抗力にしか使わない（フレーム自体は非回転）。→ 慣性系を描画の基底にできる（§2 冒頭で詳述）。
2. **予測サンプルのキャッシュは B-2 を plan に隣接**させて司る。B-1 は arc 単位の再利用ユニットで、B-2 が per-arc に生成・所有する。Plan は corners（+アンカー）へ純化。
3. **frameRotating（軌道の固定先）と camera.fixOnRotatingFrame（カメラの固定先）は疎結合**。現状 1 フラグに融合しているのを分割する。
   軌道側は将来の月回転系等に備え **enum** にする。
4. **回転を含む時間依存の座標系変換（順・逆）を独立モジュール `XX` に切り出す**（FloatingOrigin と同型のインフラ）。
   慣性系 OrbitState と回転系相対 OrbitState を **branded type** で区別する（[vec3.ts](../src/physics/vec3.ts) の `Vec3` と同じ手法）。X の変換はこのモジュールを通す。
5. **B-2 の arc はノード境界で途切れてよい**（位置不連続は噴射と無関係。噴射誘導は planGuide の責務・本作業外）。

C（履歴軌道）とエルミート補間は範囲外（§6）。まず A/XX/X/B-1/B-2 の構造を作ることを目標とする。

---

## 1. 現状の問題

### 1-1. `TrajLine` に汎用描画とプラン固有の色分けが同居
[trajline.ts](../src/game/predict/trajline.ts) の `TrajLine` は「点列を折れ線として描く」汎用処理（`rebuild`/`clear`/`setOrigin`/`setVisible`）
と、「ノード時刻で区切ってグレー→白→オレンジに色分けする」プラン固有処理（`sync` 内のセグメント分割 + `SEGMENT_COLORS`）を
1 クラスに抱えている。前者は B・C の共通基盤（素案 X）になれるが、後者は B-2（plan 由来）だけの都合。再利用の妨げ。

### 1-2. 予測軌道の「固定座標系」まわりが密結合（フラグ融合・un-bake の凍結・カメラとの混同）
太陽回転系表示の正しいモデルは、**慣性系サンプルを回転系へ焼き（bake）、描画時に慣性系へ戻す（un-bake）** という二段変換:
この bake/un-bake は **この予測軌道メッシュ（＝ X の描画物）にだけ**適用される局所処理である。地球・軌道線・自機などシーンの他の描画物は
最初から慣性系で計算・描画されており、回転系を経由しない（本作業は軌道描画だけが対象で、それ以外のシーンには一切触れない）。
- **bake（メッシュ更新時のみ）**: 各サンプル `(r_i, t_i)`（慣性系）を **その時刻の回転系座標** `rotateY(r_i, −sunAz(t_i))` へ変換して頂点に焼く（＝回転系に固定）。点ごとに角が違う **非剛体**。
- **un-bake（毎フレーム）**: 現在の描画時刻 `T`（＝ simTime）で **この軌道メッシュを**慣性系へ戻す `rotateY(·, +sunAz(T))`。全頂点一律の **剛体**（`group.rotation.y` 一発）。
- 両者は描画時刻 `T` について **逆変換**。合成は `rotateY(r_i, sunAz(T) − sunAz(t_i))`。`t_i = T`（near-end）では恒等＝**その軌道物体の現在の慣性系位置に一致**し、
  過去/未来の点は回転系のズレとして残るので、単なる楕円でない複雑な形が描ける（これが太陽回転系表示の意義）。
- こうして un-bake すると、この軌道メッシュも他の描画物と同じ **慣性系**の一員としてシーンに置かれる。**カメラは完全に別責務**で、その慣性系シーン全体を（通常の視点移動と同様に）
  動いて描くだけ。camera.fixOnRotatingFrame の on/off で視界内の見え方は当然変わるが、それは **視点の問題**であって 3D 空間（慣性系に置かれた軌道）は何も変わらない。

現状コードの密結合:
- **un-bake を頂点へ焼き込み凍結**: `toDisplayFrame(r, t) = rotateY(r, trajYawRef − sunAz(t))`（[predict-system.ts](../src/game/predict/predict-system.ts)）で、
  `trajYawRef`（= un-bake の `sunAz(T)`）を **メッシュ再構築の瞬間で固定**している。本来 un-bake は毎フレーム新鮮な `sunAz(simTime)` であるべき剛体回転なのに、
  再構築（サンプル参照変化）まで据え置かれる。再構築は `Plan.maybeRefresh` の `performance.now()` スロットル（最大 `PREDICT_REFRESH_INTERVAL_MS`=2 秒、
  dirty 200 ms、[plan.ts](../src/game/plan/plan.ts)）でしか起きないので、タイムワープ中は軌道全体が `sunAz(T_再構築) − sunAz(T_現在)` ぶんズレて 2 秒ごとにスナップで戻る（鋸歯）。
  ※ `sunAz` は年周期（`2π/YEAR`）なので実害は極小（既定ズームで sub-pixel、最寄りズーム `MAP_MIN_DIST`=9e6 +×4096 でようやく ~1.4px）。だが構造上のアンチパターン。
  ※ 正しい直し方は **un-bake を毎フレームの `group.rotation.y = sunAz(simTime)` にする**こと（凍結の除去）。「削除して純 `−sunAz(t)` だけ」ではない（それだと near-end が現在位置から外れる）。
- **フラグ融合**: 「軌道の固定先（frameRotating）」と「カメラの固定先（fixOnRotatingFrame）」を 1 つの `frameRotating`（[map-camera.ts](../src/game/camera/map-camera.ts) 所有）でまとめて切り替えている。
- **RK4 の空回り**: frameRotating トグルで ECI サンプルは変わらないのに、頂点を焼き直すためだけに `onFrameToggle` が `plan.markDirty()` を呼び RK4 全体を再計算している。

### 1-3. `markDirty` が複数の異なる「再計算理由」を 1 フラグに畳んでいる（単一責務違反）
[plan.ts](../src/game/plan/plan.ts) の `dirty` は「予測キャッシュ（ECI サンプル列）が古いか」を表すはずだが、異質な理由が混在して同じフラグを立てている:

| markDirty を呼ぶ箇所 | 本当の理由 | ECI サンプルは変わるか |
|---|---|---|
| `addNode`/`removeNode`/`retimeNode`/`applyNodeDv`/`consumeFirstNode`/`clear`/`trackAnchor`（内部） | ノード編集 → RK4 やり直し | **変わる**（正当） |
| `onDurationSelect`（外部, plan-system） | 表示期間 day/week/month の変更 → 積分区間が伸びる | **変わる**（正当だが本来は区間キャッシュの差分更新で済む） |
| `onFrameToggle`（外部, plan-system） | 太陽回転系トグル → **bake のやり直しだけ** | **変わらない**（不当。§1-2 の空回り） |

さらに `maybeRefresh` は dirty でなくても 2 秒ごとに**無条件で RK4 を再計算**する（[const.ts](../src/game/const.ts)）。これは (a) 表示区間 end が simTime とともに前進する（窓が滑る）ぶんと、
(b) §1-2 の `trajYawRef`（un-bake）を現在時刻へ追従させるぶんを粗く補う crutch。分割後は (b) が毎フレーム un-bake へ移って消え、`onFrameToggle` の行も bake やり直しへ移り、
残る RK4 の更新理由は「ノード/アンカー編集」と「(a) 窓の前進」だけになる（ともに B-1/B-2 側）。

### 1-4. B（予測軌道）が plan 専用で、単体再利用できない
`predict-system.compute` は `nodes` 前提の plan 予測に閉じている。素案 B-1（推進を持たない単体軌道物体＝敵機・デブリの将来軌道予測）として使い回すインターフェースがない。
物理側 [predict.ts](../src/physics/predict.ts) の `envAccel` は `bcInv=0`（抵抗なし）固定で、減衰軌道の予測にはそのままでは不適。

### 1-5. 期間受け渡しが UI 密結合（`predictDurationKey`/`sliderT` の生値）
`predictDurationSec`/`displayTime` は day/week/month キーやスライダー生値から算出され描画側まで引き回されている。描画クラスが知るべきは「いつからいつまで（絶対 simTime）」であって UI キーではない。

---

## 2. 目指す責務分割

### 前提: シミュレーション座標系 = 地球中心慣性系（ECI）— 検証結果
- 中心重力 `−μ_E·r/|r|³`（[orbital.ts](../src/physics/orbital.ts) `accelInto`）＋ J2 ＋ **差分（潮汐）第三体** `μ(bodyPos−r)/|bodyPos−r|³ − μ·bodyPos/|bodyPos|³`（`thirdBodyAccelAdd`）で積分。
- 第二項が「地球中心・非回転フレームでの摂動」にするための補正。太陽・月位置は時変（ephemeris）で、フレーム内を動く。遠心・コリオリ項は無い。→ **非回転（慣性）**。
- `EARTH_OMEGA` は共回転大気に対する対気速度（抗力）にしか使わない（[envaccel.ts](../src/physics/envaccel.ts)）。フレームの回転ではない。
- 太陽の潮汐力は時刻とともに **太陽を追って向きが回る** → 慣性系（一定方向なら回転系）。ユーザ認識どおり。絶対系は地球原点（太陽原点は数値精度が悪化するため不可）。
- したがって **3D 描画の基底は常にこの慣性系**。frameRotating はシーン全体を差し替えず、個々の軌道物の描画変換に閉じる。

### A — 楕円軌道 `OrbitLine`（[orbitline.ts](../src/render/orbitline.ts)）
**現状維持。** 位置・速度→楕円要素→頂点生成、地球中心 ECI 頂点＋`line.position` 平行移動＋要素変化での再生成。改名（`EllipseOrbit`/`BallisticLine` 等）は命名フェーズで別途。

### XX — 座標系変換モジュール（新規, 慣性系 ⇄ 回転系。FloatingOrigin と同型のインフラ）
**責務: 回転を含む時間依存の座標系について、慣性系 ⇄ その回転系相対の順変換・逆変換を供給する。** 軌道トレースの座標変換は必ずここを通す。
- **座標系は enum**（`InertialFrame` / `SunRotatingFrame` / 将来 `MoonRotatingFrame`…）。現状の boolean（慣性=false/太陽=true）を置き換える。
- 二関数（`OrbitState` = r,v を扱う。回転系では速度に `−ω×r` 等の項が入るため Vec3 でなく OrbitState 単位が正しく、エルミート補間にも効く）:
  1. `toFrame(frame, t, inertial: InertialState) → RelativeState`（順: 慣性系 → その座標系相対。太陽回転系なら `rotateY(r, −sunAz(t))`）
  2. `toInertial(frame, t, relative: RelativeState) → InertialState`（逆: その座標系相対 → 慣性系。太陽回転系なら `rotateY(r, +sunAz(t))`）
- **branded type で慣性系/相対を型区別**（[vec3.ts](../src/physics/vec3.ts) の `Vec3 = {x,y,z} & {readonly __tag}` ＋ `as` 限定ファクトリと同手法）。
  `InertialState`/`RelativeState` は正式な変換関数からしか生成できず、勝手な混同を型で禁止する。
- ephemeris（`sunAzimuthAt` 等）に依存する純ロジック。THREE 非依存。

### X — 点列描画基盤 `SampledLine`（新規, [src/render/](../src/render/) 配置。`OrbitLine` の兄弟）
**責務: 点列（時刻付き OrbitState）と座標系 frame と現在時刻を受け取り、bake＋un-bake で 1 本の折れ線メッシュを描く。**
- **bake（頂点バッファ, (点列, frame) が変わったときだけ再構築）**: 各サンプルを `XX.toFrame(frame, t_i, ·)` で相対座標へ。慣性系 frame なら恒等（無変換）。
  frameRotating の on/off や点列の変化は各点の角が違う **非剛体変形**なので `group.rotateY` では表現できず、ここで焼き直す（素案「食い違ったら再生成」）。
- **un-bake（毎フレーム, 剛体）**: 現在時刻 `T`（simTime）で `XX.toInertial(frame, T, ·)` の回転を **`group.rotation.y`** として与える（太陽回転系なら `sunAz(T)`、慣性系なら 0）。
  これが §1-2 の `trajYawRef` を置き換える — 毎フレーム新鮮なので凍結陳腐化・トグル一過性破綻が消え、O(1)。
- **毎フレームの `group.position` は floating origin 補正（平行移動、`setOrigin`）**。un-bake の回転と平行移動だけが per-frame で、bake の頂点は据え置き。
- 素案おまけ: サンプルに速度があればエルミート補間で粗い RK4 を滑らかに（解像度パラメータ。§6）。

X が **持たない** もの: ノード概念・色分け（B-2）・RK4 予測（B-1）・sliderT/未来時刻（predict-system）・カメラ（別責務）。

### B-1 — 指定期間予測軌道 `PredictedLine`（新規, [src/game/predict/](../src/game/predict/)。arc 単位の再利用ユニット）
**責務: 初期状態（`OrbitState` + 環境要因）と [start, end]（絶対 simTime）と解像度から将来軌道点列を計算し、X へ委譲して描く。**
- ← `predict-system.compute` の単一 arc 版 ＋ 物理 `predictTrajectory`。入力 `(OrbitState, start, end, resolution, envParams)`。`duration = end − start` 変換は B-1 内部に閉じ、`predictTrajectory` のシグネチャは据え置く。
- 自分の arc のキャッシュ・スロットリングを内包（初期状態の同一性 + [start,end] キー、入力変化時のみ RK4。差分更新は §5）。
- 環境加速度をパラメータ化（抵抗 on/off・弾道係数。plan は抵抗なし、敵機・デブリは抵抗あり。§5-3）。
- 1 つの X を所有し、点列・frame・現在時刻を渡す。**単体で plan なしに使える**（敵機・デブリ予測へ転用可能）。plan 用途では B-2 が per-arc に生成・所有する。

### B-2 — plan 予測軌道 `PlanTrajectory`（新規, **plan 隣接**。多ノードキャッシュを司る）
**責務: plan のノード列から各 arc を B-1 で描く（B-1 の複数実行）＋多ノードキャッシュの集約。**
- plan（多ノードの正データ）と 1:1 対応するので **plan の隣（planSystem 側）に置く**。多ノードキャッシュ（各 arc の B-1 の per-arc キャッシュ）を束ねて司る。
  predict-system は `[start,end]` を供給し表示を駆動するが **キャッシュは所有しない**（SPLIT_PREDICT_SYSTEM の方針）。
- ← `predict-system.compute` の nodes 版 ＋ `TrajLine` のセグメント色分け（`SEGMENT_COLORS`）。**arc はノード境界で途切れてよい**（隙間は隙間のまま。§0-5）。
- end をまたぐ arc は途中打ち切り。依存先は Plan（corners）と B-1 のみ。arc の増減に応じ B-1 群の生成・破棄を管理。picking 用のサンプルアクセサを公開。

### predict-system（薄いオーケストレータへ）
残す: `predictDurationKey`/`predictDurationSec`、`sliderT`/`displayTime`/`resolveDisplayTime`、`plannedPlayer` マーカー＋`plannedPlayerLabel`、`hide`。
役割: plan 隣接の B-2 を駆動し（`[start=simTime, end=simTime+durationSec]` を渡す。キャッシュ非所有）、未来ゴースト（`plannedPlayer`）を表示。
失う: `toDisplayFrame`/`trajYawRef`（→ XX モジュール・X。`trajYawRef` は毎フレーム un-bake へ）、`compute`（→ B-1）、`TrajLine` 直接所有（→ B-1/B-2 経由）。

### frameRotating の帰属 ― 疎結合な二概念を分割（素案 §要調査への回答）
現 `frameRotating`（map-camera 所有）は本来独立な二つ:
- **① camera.fixOnRotatingFrame（カメラ側）**: カメラをどの座標系に固定するか（`displayYaw += sunAz(simTime)`）。慣性系に置かれたシーンを見る視点の問題。map-camera に残す。
  回転系へ固定するときはカメラも `frame.ts` でカメラ座標を得る（軌道計算とは独立に、たまたま同じモジュールを参照するだけ）。
- **② frameRotating（軌道側, enum）**: 予測軌道をどの座標系に固定して描くか。X の bake/un-bake（XX モジュール経由）に効く。predict-system が保持し B-1/X へ引数注入（暫定。将来はマネージャー化も）。

①②は疎結合。①は視点、②は個々の軌道物の固定先で、独立に選べる。現状は 1 ボタンで両方を同期トグルし、さらに②の un-bake に①/現在時刻の値を凍結で混ぜていた（`trajYawRef`）のが密結合の実体。
分割後、②は慣性系 frame なら恒等・回転系 frame なら bake+un-bake（毎フレーム un-bake は simTime を使うが、これはカメラではなく「回転系→慣性系へ戻す」自分の逆変換）。
HUD の `onFrameToggle` は UX 既定として①②を同期トグルするだけ（[MapModeToggler](../src/game/map-mode-toggler.ts) の mapMode/editMode 同期と同型）。**`onFrameToggle` は `plan.markDirty()` を呼ばなくなる**（②の bake やり直しは X が自分で検出）。

### markDirty の帰属（素案 §要調査への回答）
- `onFrameToggle → markDirty` 削除（bake やり直しは X）。`onDurationSelect → markDirty` は B-2/B-1 の区間キャッシュキーへ。編集トリガも B-2 が読む plan 入力（anchor+nodes）変化として吸収。
- 結果、**Plan から `dirty`/`markDirty`/`maybeRefresh`/`lastRefreshMs`/`trajSamples` は丸ごと消え、Plan は corners（+アンカー）だけの純データ**に。スロットル・キャッシュは plan 隣接の B-2（集約）＋各 arc の B-1（per-arc）が持つ。

### 責務対応表（現状 → 分割後）

| 現状の関数・状態 | 分割後の所有者 |
|---|---|
| `OrbitLine`（楕円全般） | **A / OrbitLine**（現状維持） |
| `TrajLine.rebuild/clear/setOrigin/setVisible/dispose`（単色折れ線） | **X / SampledLine** |
| `TrajLine.sync` のノード色分け（`SEGMENT_COLORS`） | **B-2** |
| `predict-system.toDisplayFrame`（慣性↔回転の座標変換） | **XX モジュール**（順・逆、enum、branded）。X（描画）が利用。クリック判定は B-2 が内部で利用（plan-editor は直接参照しない）。カメラも回転系固定時に利用（独立） |
| `predict-system.trajYawRef`（un-bake を頂点へ凍結） | **X の毎フレーム `group.rotation.y = sunAz(simTime)`**（凍結せず剛体 un-bake で。§1-2） |
| `predict-system.compute`（nodes なし・単 arc 相当） | **B-1** |
| `predict-system.compute`（nodes 版） | **B-2**（B-1 の複数実行） |
| 物理 `predictTrajectory`/`predictStepDt`/`envAccel(bcInv)` | **physics/predict**（B-1 が呼ぶ。抵抗をパラメータ化） |
| `Plan.trajSamples`/`dirty`/`markDirty`/`maybeRefresh`/`lastRefreshMs` | **B-2 が司る多ノードキャッシュ**（plan 隣接。各 arc の B-1 が per-arc 保持、B-2 が集約） |
| クリック判定（画面座標→最寄りサンプル/ノード） | **B-2 が提供**（内部で XX 変換 + `projection`）。plan-editor は結果を受け取るだけ（XX を参照しない） |
| `bindDisplayFrame`/`DisplayFrameFn` | **XX モジュールの部分適用**（frame 固定） |
| `predictDurationKey/Sec`, `sliderT`, `resolveDisplayTime`, `plannedPlayer`＋label | **predict-system**（現状維持） |
| `frameRotating`（現 1 boolean） | **① `mapCamera.fixOnRotatingFrame`（カメラ）／② 軌道側 frame enum（predict→B-1/X）** に分割 |

---

## 3. 分割後の依存グラフ

```
  physics/predict, ephemeris, envaccel            ephemeris
        ▲                                              ▲
        │ RK4 + 抵抗パラメータ                          │ sunAz 等
   B-1 (PredictedLine, arc単位・再利用可) ──owns──► X (SampledLine) ──uses──► XX (座標系変換, enum/branded)
        ▲                                        ▲
        │ B-2 が arc ごとに生成・所有             │ frame enum + 現在時刻を渡す
   B-2 (PlanTrajectory, plan隣接・多ノードキャッシュ) ──reads──► Plan(corners)
        ▲                                                   ▲
        │ predict-system が [start,end] 供給・駆動           │ plan-editor は B-2 にクリック判定を要求（B-2 が内部で XX + projection）
  predict-system ──────► plannedPlayer / sliderT            plan-editor（XX/frame は参照しない）

  カメラ側: mapCamera.fixOnRotatingFrame（① sunAz(simTime) の view 回転）は②の軌道 frame と疎結合。回転系固定時はカメラも XX を参照してカメラ座標を得る（独立）。HUD ボタンが UX 既定として①②を同期トグル。
  シーンの他の描画物（地球・軌道線・自機…）は元から慣性系。X は自分の軌道メッシュだけを un-bake で慣性系へ戻して同じシーンに置き、カメラが（普通に）視点移動して描くだけ。
```

- 一方向依存: predict-system → B-2 → B-1 → X → XX。X/XX は誰にも依存を返さない葉。カメラは独立に XX を参照しうる。
- 描画（X）と クリック判定（B-2 が内部で同じ XX 変換 + 同じ `mapCamera.projection` を使う）が同じ基準を通るので画面上で一致する。plan-editor は B-2 の判定 API を呼ぶだけで XX/frame を知らない。
- B-1 は plan を知らない（単体で敵機・デブリ予測に転用可能）。plan 用途では B-2 が束ねて plan の隣に置く。

---

## 4. 作業手順

各ステップは **typecheck（`npm run typecheck`）と physics 回帰（`npm run test:physics`）** を前後で通す（CLAUDE.md 準拠）。physics/predict のシグネチャは据え置き、start/end 変換は B-1 内部に閉じ込める。

### Step 0 — XX モジュール新設・frameRotating フラグ分割・un-bake を毎フレーム化
- **XX モジュール**（例 `physics/frame.ts` 付近）: frame enum（Inertial/SunRotating）と `toFrame`/`toInertial`（OrbitState、branded）を実装。ephemeris 依存の純ロジック。将来 MoonRotating を足せる形に。
- 現 `frameRotating`（map-camera）を **① `mapCamera.fixOnRotatingFrame`（カメラ側）／② 軌道側 frame enum** へ分割。HUD `onFrameToggle` は UX 既定として両者を同期トグル。
- `predict-system.toDisplayFrame`/`bindDisplayFrame` を XX の部分適用へ差し替え。**bake は `toFrame`（頂点）、un-bake は毎フレームの `group.rotation.y`（`toInertial` の回転 = `sunAz(simTime)`）に移し、`trajYawRef` の凍結を除去。**
- ※ 挙動: §1-2 の 2 秒鋸歯・トグル一過性破綻が消える（改善）。near-end が現在位置に一致する挙動は維持（un-bake がそれを担保）。定常表示は実質不変。
- 目視検証（verify skill）: ①②を個別トグルした見え方、time warp 中に描画・picking がずれないこと、frameRotating トグルの即時反映。

### Step 1 — X（SampledLine）を新設
- `TrajLine` の汎用部（`rebuild`/`clear`/`setOrigin`/`setVisible`/`dispose`）を `src/render/sampled-line.ts` へ移し **単色化**。
- 入力 (点列, frame, 現在時刻)。bake（`toFrame` で頂点、(点列, frame) 変化時のみ再構築）＋ un-bake（`toInertial` の回転を毎フレーム `group.rotation.y`）＋ `group.position`（floating origin）。
- 一旦 `TrajLine` は X を包む薄い互換ラッパとして残し、色分けだけ担わせる（Step 3 で B-2 へ昇格）。

### Step 2 — B-1（PredictedLine）を arc 単位の再利用ユニットとして新設
- `predict-system.compute` の単 arc 相当と `predictTrajectory` 呼び出しを B-1 へ。入力 `(OrbitState, start, end, resolution, envParams)`。
- 自分の arc のスロットル・キャッシュを内包（入力同一性で recompute 判定）。環境加速度を抵抗 on/off パラメータ化（§5-3）。B-1 は 1 つの X を所有し frame/現在時刻を渡す。
- この段階ではまだ plan に繋がず単体ユニットとして用意（plan 表示は Step 3 まで TrajLine 互換ラッパのまま）。

### Step 3 — B-2（PlanTrajectory）を plan 隣接に新設し、多ノードキャッシュを移管
- B-2 を **plan の隣（planSystem 側）** に新設。`TrajLine` のノード色分けを B-2 へ移し、arc ごと（前ノード postState/アンカー → 次ノード時刻 or 表示 end）に B-1 を生成・所有。**arc は途切れてよい**。
- Plan の `dirty`/`lastRefreshMs`/`maybeRefresh`/`markDirty`/`trajSamples` を撤去し、多ノードキャッシュを B-2（集約）＋各 arc の B-1 へ。Plan は純 corners に。
- predict-system は B-2 を **駆動**（`[start,end]` 供給・表示トリガ。キャッシュ非所有）。`syncDisplay` を「B-2 の update + plannedPlayer マーカー」に縮小。`toDisplayFrame`/`trajYawRef`/`compute`/`TrajLine` を撤去。B-2 は picking 用サンプルアクセサを公開。

### Step 4 — 配線の付け替えと markDirty 掃除
- クリック判定・ノード画面位置（`nearestSample`/`nodeScreenPos`/`computeAxisScreenDirs` 相当）を **B-2 側へ移す**（B-2 が XX 変換 + `projection` で画面判定を提供）。plan-editor はそれを呼ぶだけ（XX/frame は参照しない）。
- `onFrameToggle` から `markDirty` 除去。`onDurationSelect` は B-2/B-1 のキャッシュキー更新へ。（現状 plan-system の `frame()`/`bindDisplayFrame` 経由の toDisplayFrame 注入は B-2 内製へ吸収されて消える。）
- `plan.sampleAt` の消費者（predict-system の `plannedPlayer` 未来マーカー）を B-2/B-1 のサンプル参照へ差し替え。`TrajLine` 互換ラッパ削除。

### Step 5 — 最終検査（構造レビュー）
- 依存が §3 のグラフどおりか（X/XX が葉、B-1 が plan 非依存の単体ユニット、B-2 が plan 隣接で多ノードキャッシュを司る、Plan が純 corners、描画とクリック判定がともに B-2 内の XX を通る（plan-editor は XX 非参照）、3D シーンが常に慣性系）をコードで確認。
- 実行時目視: ①②個別トグルの見え方、time warp 中に描画・クリック判定がずれない、frameRotating トグルで RK4 が走らない・即時反映。

---

## 5. 残る検証事項・未定義部分

### 5-1. キャッシュ更新トリガ（窓の前進） ― B-2 が集約・各 arc の B-1 が実行
- 表示区間 end は simTime とともに前進（窓が滑る）。B-2 が plan の nodes と `[start,end]` を各 arc の B-1 へ配り、B-1 は入力変化で recompute。**毎フレーム全再計算は避けたい**（末尾 arc だけ伸び、前方 arc は不変）。
- 素直な実装: 2 秒相当のスロットルを B-1 に持たせる（編集時 5Hz、平常 2 秒）。B-2 は arc の増減だけ面倒を見る。
- 最適化（任意, 後回し可）: 末尾 arc の end 前進ぶんだけ追記する差分更新。まずスロットル版で作り、必要なら差分化。

### 5-2. `trajYawRef` を毎フレーム un-bake へ移す（凍結除去）と目視確認
- 調査結果（§1-2）: un-bake（回転系→慣性系へ戻す `sunAz(T)`）は本来毎フレーム剛体回転なのに、`trajYawRef` として bake に凍結され RK4 スロットルでしか更新されず、2 秒鋸歯を生む（実害 sub-pixel〜~1.4px）。
- 修正: bake は `toFrame`（頂点、(点列,frame) 変化時のみ）、un-bake は毎フレームの `group.rotation.y = sunAz(simTime)`（§2 X）。凍結が消え O(1)。**near-end が現在位置に一致する挙動は un-bake が担保するので不変**。
- **不変条件**: 描画（bake 頂点 + un-bake group 回転）と クリック判定（B-2 が同じ XX 変換の合成を使う）が同じ frame・同じ現在時刻から導出され、同じ `mapCamera.projection` を通ること。
- 実装時に目視検証（Step 0 / 5）: time warp 中の描画・クリック判定のズレ無し、frameRotating トグルの即時反映。

### 5-3. B-1 の環境加速度パラメータの粒度
- plan 予測は抵抗なし（`bcInv=0`）が意図的（[predict.ts](../src/physics/predict.ts)）。敵機・デブリ転用時は抵抗あり。B-1 の入力を「env-accel クロージャ」か「抵抗 on/off + 弾道係数」かは `simulator.makeEnvAccel`（[simulator.ts](../src/game/orbit-entity/simulator.ts)）との重複を避けて決める。**推奨**: `envaccel.ts` の合成点を共有し B-1 は BC（弾道係数）だけ受け取る。

### 5-4. サンプル間引き（B-1 の maxSamples）と B-2 集約の picking 精度
- picking は B-2 のサンプルアクセサ（各 arc の B-1 が `PREDICT_MAX_SAMPLES=2000` に間引いた列を集約）を走査。区間差分で育てると密度が不均一になり得る。**picking が読む列と描画が読む列を同一に保つ**（別々に間引かない）ことを不変条件に。

### 5-5. XX モジュールの粒度（OrbitState か Vec3 か・回転系速度項）
- 回転系相対の **速度**は `v_rel = R(−sunAz(t))·v − ω×r_rel`（ω = 太陽方位角速度）等の項を含む。描画位置だけなら r で足りるが、エルミート補間（§6）や再利用性のため OrbitState 単位（r,v）で持つのが素直。
- ただし太陽方位角速度は黄道傾斜で厳密には一定でない（[ephemeris.ts](../src/physics/ephemeris.ts) `sunAzimuth` は近似）。速度項の厳密さは表示用途では過剰かもしれず、**まず r の順逆変換だけ実装し、v は必要になったら足す**でよい（branded 型の枠は最初から用意）。

---

## 6. 作業範囲外（別マイルストーン / 将来 TODO）

本リファクタは A/XX/X/B-1/B-2 の構造化までを範囲とする。以下は範囲外:

- **C — 履歴軌道**: X があれば容易。現状 `prevR`（[entities.ts](../src/game/orbit-entity/entities.ts)）は 1 個前だけを衝突判定用に保持。OrbitEntity ごとに履歴長を可変にしたリングバッファ（デブリ=0、弾=1、自機/敵=一定長）を足し X で描く。
- **エルミート補間**: X に速度付き点列＋解像度パラメータ（解像度=1 で折れ線、上げると滑らか）。XX が OrbitState（v 込み）を扱えば素直に繋がる。
- **月回転系など追加の座標系**: XX の frame enum に値を足すだけで X/B-1 が対応できる設計にしておく（実装自体は将来）。
- **frameRotating 対応の楕円（A+X）**: 楕円計算は A、回転考慮の描画は X へ委譲する派生。利用予定が出たら A から分離。
- **B-1 の実利用**: 敵機・デブリの将来軌道予測を戦闘/マップに表示。
- **噴射（burn）まわりの UX・誘導**: 噴射が要るのは軌道が**曲がる**箇所（速度不連続）で、arc の位置不連続（途切れ）とは無関係。誘導は [plan-guide.ts](../src/game/plan/plan-guide.ts) の `PlanGuide` の責務。
  **調査した限り planGuide は本リファクタ範囲へ責務漏れしていない**: 白い計画軌道は `OrbitLine`（A）、目標は `plan.firstNode().postState` を直読みするだけで predict/trajLine/frameRotating に依存しない。本作業で触らない。
