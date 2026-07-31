# 軌道表示責務の分割（TrajLine / predict / frameRotating の疎結合化）

素案 [SPLIT_TRAJ_LINE_DRAFT.md](SPLIT_TRAJ_LINE_DRAFT.md) の実行計画。先行の
[SPLIT_PREDICT_SYSTEM.md](SPLIT_PREDICT_SYSTEM.md)（plan と predict の分離）・
[SPLIT_MAP_MODE.md](SPLIT_MAP_MODE.md)（mapMode 三分割）を土台に、「軌道を **描画する** 責務」そのものを再整理した。

**状態: Step 0–5 完了。** typecheck / test:physics 41/41 / 実行時例外0 で検証済み。
本書は完了記録 + レビュー結果（Step 5）+ 残タスク。各責務の設計意図は素案と各モジュール冒頭コメントに委ねる。

---

## 達成した構造

3D シーンは常に慣性系（ECI）で描き、frameRotating は「個々の軌道描画物をどの座標系に固定するか」の
局所変換に閉じる（シーン全体は差し替えない）という方針で、素案 A/XX/X/B-1/B-2 を実装した。

| 分類 | モジュール | 責務 |
|---|---|---|
| **A** | [orbitline.ts](../src/render/orbitline.ts) `OrbitLine` | 楕円軌道（現状維持） |
| **XX** | [physics/frame.ts](../src/physics/frame.ts) | 慣性系⇄回転系変換。Frame enum + branded 型。THREE 非依存の葉 |
| **X** | [render/sampled-line.ts](../src/render/sampled-line.ts) `SampledLine` | 点列(時刻付き OrbitState)→単色折れ線。bake(OrbitState を toFrameState で frame 相対化し位置 r を頂点へ) + un-bake(毎フレーム剛体回転) + floating origin |
| **B-1** | [predict/predicted-line.ts](../src/game/predict/predicted-line.ts) `PredictedLine` | arc 単位の再利用ユニット（plan 非依存）。入力変化検出 + 2 段スロットル |
| **B-2** | [predict/plan-trajectory.ts](../src/game/predict/plan-trajectory.ts) `PlanTrajectory` | corners→arc 分解、多ノードキャッシュ集約、picking/ghost 変換。所有は predict 側 |
| — | [plan/plan.ts](../src/game/plan/plan.ts) `Plan` | **純 corners**（dirty/markDirty/maybeRefresh/trajSamples 全撤去） |
| — | [predict/predict-system.ts](../src/game/predict/predict-system.ts) | 期間解決 + frame 状態 + ghost + B-2 の所有・駆動。plan は `sync` の引数で参照渡し（クロージャ注入なし） |

**依存方向（確認済み）**: predict-system → B-2 → B-1 → X → XX。一方向で X/XX が葉。

達成した疎結合の要点:

- **frameRotating の①②分割**: カメラ固定先（`mapCamera.cameraFrame`）と軌道固定先（`predict.frame`）を
  別フィールドにし、HUD `onFrameSelect` が UX 既定として同期トグルするだけ。`markDirty` 呼び出しは消滅
  （bake やり直しは X が (点列,frame) 変化として自己検出）。
- **XX が描画とカメラの共有インフラに**: 当初「カメラもたまたま同じモジュールを参照する **だけ**」と書いた
  独立利用が実際に成立。[overview-camera.ts](../src/game/camera/overview-camera.ts) は相対座標（`RelativeVec3`）を
  正データに持ち、ECI への変換を frame.ts へ一任している（brand の付け外しをカメラ側でしない）。
- **描画・ghost・クリック判定が単一変換を通る**: すべて B-2 の `toDisplay`/`projectPoint`/`nearestSample`
  経由。plan-editor は frame/XX を座標変換で参照しない。picking が走査する列と SampledLine が bake する列は
  同一の per-arc サンプル（`samplesRef()`）なので、描画とクリック判定が画面上でずれない（§旧5-4 の不変条件を維持）。
- **markDirty 責務漏れの解消**: frame トグルでの RK4 空回り・表示期間変更での全再計算が無くなり、再計算理由は
  「ノード/アンカー編集（B-1 の入力変化）」と「窓の前進（end スロットル）」だけになった。`onDurationSelect` の
  非連続変化は B-2 の `invalidate()` で即時反映（force フラグは B-2 の表示キャッシュ側に閉じ、Plan の corners は不変）。
- **un-bake の凍結除去**: 旧 `trajYawRef`（un-bake を頂点へ焼き込み RK4 スロットルでしか更新されず 2 秒鋸歯を生む）を、
  X の毎フレーム剛体回転（`toInertialQuat(frame, simTime)` を line.quaternion へ）へ置換。

---

## レビュー結果（Step 5）— 残タスク

構造・疎結合は §達成した構造 のとおり計画どおり達成できている。以下は残る改善余地。

### 1.【解決済み】速度パイプラインを sampled-line まで供給（エルミート補間の布石）

（当初レビューでは `toFrameState`/`toInertialState`/`RelativeOrbitState`/`sunAngularRateAt` が本番未使用の
死蔵コードと指摘したが、エルミート補間へいつでも進めるよう、**削除ではなく本番へ配線する**方針を採った。）

- **[sampled-line.ts](../src/render/sampled-line.ts) の `LineSample` を `{r,v,t}` に拡張**し、bake を
  位置版 `toFramePos` から **`toFrameState`（OrbitState を frame 相対へ変換）へ切替**。頂点には位置 `rel.r`
  だけを焼き、速度 `rel.v` は将来のエルミート補間の接線として供給（現状は未使用、実装時にここで保持して密にする）。
  → `toFrameState` / `RelativeOrbitState` / `sunAngularRateAt` が本番で使用中になった。
  （後日の型統合で `LineSample` は削除。`OrbitState` が `{t,r,v}` になったので `syncGeometry` は
  `readonly OrbitState[]` を直接受ける。予測点列も entity の履歴も同じ型でそのまま渡せる。）
- 予測点列 `TrajectorySample`（`{t,r,v}`）は元から v を持ち B-1 経由で sampled-line まで届いていた
  （型 `{r,t}` と bake が捨てていただけ）。B-1/B-2/predict/plan-editor は無改変。
  （`TrajectorySample` も後日 `OrbitState` へ統合され、型としては消滅した。）
- **位置は不変**: `toFrameState(...).r` は `toFramePos(...)` と一致（[frame.test.ts](../tests/physics/frame.test.ts)
  の「sunRotating の位置は −sunAz(t) の回転（state・pos が一致）」が保証）。頂点はビット一致で描画は無変化。
- **残る唯一の Hermite フック**: `toInertialState`（速度の un-bake）は、エルミートが接線を慣性系へ戻して
  描くときに必要になる。現状の un-bake は位置のみ剛体回転（`toInertialQuat`）で足りるため未使用だが、
  テスト付きの意図的な足場として残す（frame.ts コメント参照）。

### 2.【軽微】plan-editor がツールバー表示状態を仲介

plan-editor は座標変換の frame 参照は消えたが、`updateEditing` の `toolbar` opts で `Frame` 型を受け取り
`_hud.setMapToolbarState(...)` を呼ぶ。ツールバー状態（durationKey/frame/focus/plannedPlayerLabel）は
すべて predict/mapCamera 側の状態で editor の関心ではない（editor 固有の HUD 出力は `setPlanPanel` のみ）。
plan-system が直接 HUD へ書けば editor から `Frame` import も消え、責務が揃う。traj-line 分割の本筋ではないので任意。

---

## 作業範囲外（別マイルストーン / 将来 TODO）

A/XX/X/B-1/B-2 の構造化までが範囲。以下は範囲外:

- **C — 履歴軌道**: 下地は実装済み。`OrbitEntity.history`（[entities.ts](../src/game/orbit-entity/entities.ts)）が
  過去 `OrbitState` を `historyLength` 件まで保持し（デブリ=0、弾/自機/敵=1）、記録は `state` の setter が行う。
  残るのは自機/敵の `historyLength` を伸ばし、`history` をそのまま X（SampledLine）へ渡すだけ。
- **エルミート補間**: X に解像度パラメータ（解像度=1 で折れ線、上げると滑らか）を足し、bake で得た
  frame 相対速度 `rel.v` を接線に使う。順変換（`toFrameState`）と v の供給は配線済み（レビュー #1）。
  残るは syncGeometry での `rel.v` 保持＋頂点密化と、接線 un-bake の `toInertialState` 接続だけ。
- **月回転系など追加の座標系**: XX の Frame enum に値を足すだけで X/B-1 が対応できる設計にしてある（実装は将来）。
- **frameRotating 対応の楕円（A+X）**: 楕円計算は A、回転考慮の描画は X へ委譲する派生。利用予定が出たら A から分離。
- **B-1 の実利用**: 敵機・デブリの将来軌道予測を戦闘/マップに表示。抵抗ありの減衰軌道は §旧5-3 の BC（弾道係数）
  パラメータ化を [predict.ts](../src/physics/predict.ts) と合わせて行う（現状は plan 用途に合わせ抵抗なし固定）。
- **噴射（burn）まわりの UX・誘導**: [plan-guide.ts](../src/game/plan/plan-guide.ts) の `PlanGuide` の責務。
  本リファクタは非干渉（白い計画軌道は `OrbitLine`＝A、目標は `plan.firstNode().postState` 直読みのみで
  predict/trajLine/frame に非依存）。
