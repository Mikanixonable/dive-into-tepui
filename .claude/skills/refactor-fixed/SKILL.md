---
name: refactor-fixed
description: このプロジェクトで確定済みの責務境界(独自Vec3とTHREE.Vector3、physics/render/game、update と sync、ctx引数の禁止、たまたま同時に切り替わるフラグの分離、GUI・マーカーの所有者)。責務の置き場所を判断するときに必ず読み、新しい判断を下したらこのファイル自体を書き換える
---

# 確定済みの責務境界

このプロジェクト固有の、間違えやすい責務分割の判断はここが正本。ここに答えがある論点は再検討しない。
一般的な判断基準は `/refactor`、モジュール個別の責務説明は CLAUDE.md、呼び出し順は
`DEVELOP/CALLSTACK.md`、状態の所有は `DEVELOP/OWNERSHIP.md`。

## 更新規約

新しい責務配置の判断を下したとき、既存の判断を変えたときは、**同じ変更セットでこのファイルを
書き換える**。

- 追記しない。**全体の判断基準が整合するように書き直す。**
- 判断が変わったら古い方は消す。「以前はこうだった」「かつては〜」を残さない。判断の変遷は
  git history が持っている。
- ここに書くのは**どのモジュールにも適用される横断的な境界ルール**だけ。個別モジュールの話は
  CLAUDE.md へ書く。

## 独自 Vec3 と THREE.Vector3 の境界

フローティングオリジンは、GPU が巨大な数値を単精度で扱うことによる描画破綻を防ぐための措置で、
CPU 側で事前に平行移動して自機・カメラ付近の浮動小数精度を高めるためのものである。
補正前か補正後かを型安全に扱うため、**この境界を独自 Vec3 と THREE.Vector3 の境界に一致させる。**

- 独自 `Vec3` は地球座標系(ECI)の座標を扱う。
- `THREE.Vector3` は描画のための座標なので、フローティングオリジンを引いた後のもののみを扱う。
- 変換は必ず `FloatingOrigin` の変換関数(`RtoThreeV3` / `VtoThreeV3`)を経由する。

## physics / render / game フォルダの境界

- `physics/` … THREE.js に依存しない部分のみ。純粋関数実装が多いが、THREE 依存がなければ非純粋な
  クラスを置いてもよい。
- `render/` … THREE.js に依存する部分のみ。上記フローティングオリジンの問題により、独自 Vec3 座標は
  極力持ち込まない。
- `game/` … その両方に依存する部分のみ。

## update と sync の境界

`game/` 配下の多くのモジュールが持つ per-frame 関数の境界。

- `update` … 論理値の更新のみを行う。THREE のオブジェクトに触らない。
- `sync` … 既に計算済みの論理状態を THREE.Scene(と HUD の DOM)へ反映する。ここまで済んでいれば、
  あとは `render` するだけで描画できる。

`build`(シーンへの登録)と `render`(実際に `renderer.render` を呼ぶもの)を含めた命名規則は
CLAUDE.md の「Naming: render / update / build / sync」節が正本。

### `game/camera/` の各カメラは `view: ViewFrame` を持ち、THREE への反映は `CameraSystem` に一元化する

`ChaseCamera`/`GunsightCamera`/`CombatCameraSystem`/`OverviewCamera` はいずれも `update` で
`physics/projection.ts` の `ViewFrame` を計算し、**返り値ではなく自身の `view` フィールドへ書き戻す**
(状態を更新しつつ副産物を返す関数を作らないという `/refactor` の TypeScript 規則そのもの)。
`view` を `THREE.PerspectiveCamera` へ反映する処理(`syncCameraToViewFrame`)と `ProjectFn` を組む処理
(`projectionFromView`)は `camera-system.ts` の module-private 関数として一箇所にあり、**`CameraSystem`
だけがこれらを呼ぶ** — 個々のカメラは自分の `sync`/`projection` を持たない。カメラ種別が増えても
「`view` を持つ」以外の追加の約束事を必要としないための境界。

## 時刻付き状態列の積分・記録・引き当ては `OrbitEntity` に一本化する

「1ステップ進めながら、間引いたサンプルを残し、任意時刻を引く」操作の実装は
`physics/orbit-entity.ts` の `OrbitEntity` ただ一つ。**第二の実装を書かない。**
向きにも用途にも依存しない — 過去列(`GameEntity.current`)・未来列(`GameEntity.predicted`)・
計画の予測区間(`plan/plan-arc.ts`)がすべて同じ `step` / `at` / `samplesOldestFirst` を使う。

- 間引きの粒度は `sampleInterval`、保持範囲は `keepDuration` で呼び出し側が指定する。
- 折れ線へ渡す点列は `samplesOldestFirst()` から取る。`history` と `state` を呼び出し側で
  継ぎ合わせない(「history は state より古い」という不変条件は `OrbitEntity` の持ち物)。

### 積分の刻み幅は `step` の呼び出し側が決める

`OrbitEntity` は刻み幅を決めない。渡された `dt` で1ステップ進めるだけ。
**用途の違う呼び出し側どうしで刻み幅のポリシーを共通化しない** — 精度と計算量の折り合いは
用途ごとに違い、共通化すると片方の都合がもう片方を縛る。

- `Predictor`(全エンティティ・3時間・フレーム予算で漸進) → `predictor.ts` の `stepDtForRadius`
- `PlanArc`(自機のみ・最長28日・変化時に一括) → `plan-arc.ts` の `stepDt`(表示期間で粗くする)

`Simulator` のサブステップ分割も同じ分担で、`GameEntity.stepSim` は渡された `dt` に従うだけ。

## 回転座標系は (姿勢, 角速度) の対で表し、その中身は `ephemeris.ts` が持つ

回転する基準系は、時刻ごとの姿勢 `q`(相対 → 慣性系の回転)と角速度 `omega` の対
(`ephemeris.ts` の `FrameRotation`)だけで表す。**固定軸まわりの回転を前提にしない** —
月回転系は白道の昇交点が歳差するため、回転軸自体が時刻とともに向きを変える。

- **中身は `physics/ephemeris.ts`。** 天体ごとに `sunOrbitRotation` / `moonOrbitRotation` を持つ。
  回転系を増やすときも、その天体の運動はここへ実装する。
- **`physics/frame.ts` は表示座標系の識別子と座標変換だけ。** `Frame` から対応する天体暦の回転を
  引くだけの module-private `frameRotation` に分岐を 1 箇所へ閉じ込め、順逆変換の 4 関数は
  すべてそこを経由する。軌道要素・歳差周期・回転軸といった物理量を自前で持たない。

## ctx・context・opt・params といった引数は原則使わない

場当たり的なオブジェクト引数は禁止。明示的な引数か、事前に共有した参照で渡す。
現況と残っている例外は `memos/hedalu244/refactoring_plan/STOP_USING_CTX.md`。

## 渡すのはクロージャではなくオブジェクトの参照

他モジュールのデータや処理へ届かせたいとき、`(t) => other.sample(t)` のような**転送クロージャを作って
渡さない**。そのオブジェクトの参照そのものを渡す。クロージャ注入は「誰が誰を呼んでいるか」を型からも
呼び出し元からも隠してしまい、注入の配線が増えるほど実行順序が読めなくなる。

- **いつ渡すかは、使うタイミングで決める。** 毎フレームの呼び出しの中だけで使うなら引数で渡す。
  DOM の pointer イベントなど**フレームの流れの外**で使うなら、コンストラクタで受けて保持する。
- **`ProjectFn` だけは関数で渡す。** これは処理の委譲ではなく「その瞬間の視点」という値で、
  `CameraSystem.activeCameraProjection` は呼んだ時点のアクティブカメラのスナップショットを返す。
  したがって**受け取った側が保持してはいけない** — 毎フレーム渡し直し、受け手は per-frame の
  表示文脈として上書きする。

## 「たまたま」同時に切り替わるフラグは別個にする

一つのフラグによって本質的に異なる多数の挙動が切り替わる形は、責務の疎結合を妨げる。
「たまたま」一致しているだけのものは別個のフラグに分離し、同時に切り替える必要があるなら、
**切り替える側(トグラー)を一箇所に置いて両方を書き換える。**

- `PlanEditor.editMode`(入力・編集の可否)・`CameraSystem.overviewMode`(視点・描画)・
  `DisplayTimeManager.forceCurrent`(未来表示の可否) → 同時トグルは `MapModeToggler` の責務。
- `OverviewCamera.cameraFrame`(視点が固定される座標系)と `PlanDisplay.trajectoryFrame`
  (予測線を描く座標系) → プレイヤーが独立に選ぶ別々の値。

## 一般化しないと決めたもの

似た形の実装があっても、**個別に調整される要素**なのでまとめない。共通化の判断基準そのものは
`/refactor` の「重複実装の禁止と早急な一般化の分かれ目」。

- **`stages/` 配下の各ステージの挙動。** すべて並列に実装されているし、そうあるべき。共通化するのは
  `Stage` 基底と `stage-utils/` に既に括り出したもの(補給・スコア・タイマー・ウェーブ)まで。

逆に、**参照が1箇所しかなくても分割する**のは、一般化した側を今後使う可能性があるとき、および
巨大な責務を切り分けるとき。

## GUI とマーカーの所有者

> **GUI は、その GUI が書き換える状態の所有者が持つ。所有者が1つに定まらない GUI は、GUI の方を
> 分割する。**
> 表示・非表示も所有者が自分の `sync` で押し出す。
> GUI の見た目を維持することを制約にしない。

マーカーも同じ原則で扱う。**マーカーは対象の持ち主が自分の `sync` の中で出す**(`syncMarker` を
別途公開しない)。対象が1つに定まらないマーカーだけが `marker/` に置かれる — 集合全体を見ないと
決まらない `GroupedMarkers` と、自機と敵の両方に依存する `LeadMarkers` の2つ。

**「どう置くか」は `MarkerManager` の側**に集める。投影して置く(`setPosition`)・方向を仮想距離へ
飛ばして置く(`setDirection`)・画面外の対象を画面端の円周へ回して置く(`setBearing`)はいずれも
表示機構であって、対象の持ち主ごとに書き直すものではない。持ち主が決めるのは「何を・どの記号で
出すか」だけ(敵は塗りの ▲、補給は塗り抜きの △、というように記号で区別する)。

### 例外として扱ってよいもの

- `SettingsPanel`(BGM・一時停止・タイトルへ戻る)… **複数モジュールにまたがることが本質**の GUI
  なので、所有者を `main.ts` に置く。
- `Hud.hint()` / `toast()` … 共有サービス(`Sfx` と同型)。所有者の議論の対象外。
- `hud/context-menu.ts` / `hud/buttons.ts` / `hud/frame-labels.ts` … DOM・イベント・表示文字列だけを
  担う共有部品。状態を持たないので「所有者」を問う必要がない。**この形は積極的に増やしてよい。**

### HudPanels が `Game` を丸ごと受け取る形は許容する

`hud/panel.ts` の `HudPanels.update(game, dt)` は player / targeter / simulator / simSpeedManager /
activeStage / cameraSystem からチェリーピックして4パネルを更新する。**全情報を集約表示することその
ものに価値がある** GUI なので、`Game` を読むこと自体は問題としない。ただし**表示専用**であること —
他モジュールの状態や DOM を書き換えないこと — は維持する。分割すると、ゲームオブジェクトを担うのが
責務である `Player` などに表示責務が乗り、そちらの肥大化の方が高くつく。

将来もし分割するときの当たり(現時点では実施しない): SHIP STATUS の RCS 制動・並進出力・微調整・
進行方向ホールド・弾薬と ORBIT 一式は `Player` 所有、TARGET は `Targeter` 所有、CONTACTS は
`Simulator`/`Stage` 側。MET / TIME WARP / 視点の RCS 追従は所有者が別(`Simulator` /
`SimSpeedManager` / `ChaseCamera`)なので、**そこは GUI の方を切り直して**別パネルへ分けるか
所有者側のパネルへ移す。
