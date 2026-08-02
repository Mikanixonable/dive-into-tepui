---
name: refactor-fixed
description: このプロジェクトで確定済みの責務境界(独自Vec3とTHREE.Vector3、physics/render/game、update と sync、plan と predict の使い分け、ctx引数の禁止、たまたま同時に切り替わるフラグの分離、GUI・マーカーの所有者)。責務の置き場所を判断するときに必ず読み、新しい判断を下したらこのファイル自体を書き換える
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

### `physics/` にゲームバランスを持ち込まない

THREE 非依存かつ純粋であっても、**現実の物理・軌道力学として意味を持たない数値は `physics/` に
置かない。** ゲームの手触りを決める調整値(散布界の倍率、命中判定の甘さ、ダメージ量、演出のための
補正など)は、たとえ `Vec3` を引数に取る数式の形をしていても `game/` 配下、その挙動を持つモジュール
自身に置く。`physics/` は現実の法則を計算する場所で、そこに調整値が混ざると「この式は物理的に
正しいのか、それとも遊びやすさのために歪めてあるのか」が読んで区別できなくなる。

物理的に正しい計算を調整値で歪めて使う場合は、`physics/` から素の値を引いて `game/` 側で歪める。

## 焼き込みアセットと実行時が共有する値は `src/` に1つ置き、ツールが transpile して読む

`tools/` の焼き込みスクリプトと実行時コードが同じ値に依存するとき、**ツール側へ数値を複製しない。**
複製した瞬間、片方だけを直しても誰も気付かない — 「造形と一致させるための定数」が造形と一致して
いない状態が、実際に長く残った。

- 値は `src/` 配下の、**他モジュールを import しない** TS モジュールへ置く。
- ツールは TypeScript コンパイラ API (`ts.transpileModule`) でその場に JS へ変換して動的 import する
  (ts-node 等のパッケージは追加しない)。
- import を持てないので、`three` に依存する `render/ships.ts` には置けない。専用のモジュールを立てる。

現況: `render/earthcolor.ts`(焼き込みテクスチャの表面色)、`render/rcs-nozzles.ts`(RCS ノズルの
取付位置と噴射方向)。

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

## `plan` と `predict` は別の語として使い分ける

未来の軌道を扱う系統が2つあるので、語を固定する。混ぜると、どちらの未来の話をしているのか
識別子から判別できなくなる。

- **`plan`(計画軌道)** … 自機の軌道計画。プレイヤーがマニューバノードを置いて組み立てた
  意図そのもので、`game/plan/` 配下が担う。
- **`predict`(予測軌道)** … 全 `GameEntity` について、現在の状態のまま自由飛行した未来。
  `Predictor` と `GameEntity.predicted` が担う。

計画側の識別子・コメント・パネル文言に `predict` /「予測」を使わない(`PLAN_ARC_*` のような
定数名も含む)。逆に予測側を「計画」と呼ばない。どちらでもない「いつの状態を表示するか」は
`display`(`DisplayTimeManager` / `DISPLAY_DUR_*`)で表す。

## 時刻付き状態列の積分・記録・引き当ては `OrbitEntity` に一本化する

「1ステップ進めながら、間引いたサンプルを残し、任意時刻を引く」操作の実装は
`physics/orbit-entity.ts` の `OrbitEntity` ただ一つ。**第二の実装を書かない。**
向きにも用途にも依存しない — 過去列(`GameEntity.current`)・予測列(`GameEntity.predicted`)・
計画軌道の区間(`plan/plan-arc.ts`)がすべて同じ `step` / `at` / `samplesOldestFirst` を使う。

- 間引きの粒度は `sampleInterval`、保持範囲は `keepDuration` で呼び出し側が指定する。
- 折れ線へ渡す点列は `samplesOldestFirst()` から取る。`history` と `state` を呼び出し側で
  継ぎ合わせない(「history は state より古い」という不変条件は `OrbitEntity` の持ち物)。

### 積分の刻み幅は `step` の呼び出し側が決める

`OrbitEntity` は刻み幅を決めない。渡された `dt` で1ステップ進めるだけ。
**用途の違う呼び出し側どうしで刻み幅のポリシーを共通化しない** — 精度と計算量の折り合いは
用途ごとに違い、共通化すると片方の都合がもう片方を縛る。

- `Predictor`(全エンティティ・3時間・フレーム予算で漸進) → `predictor.ts` の `stepDtForRadius`
- `PlanArc`(自機のみ・区間ごとに一括) → `plan-arc.ts` の `stepDt`(動径の円軌道周期を等分する)

`Simulator` のサブステップ分割も同じ分担で、`GameEntity.stepSim` は渡された `dt` に従うだけ。

### 環境加速度の天体位置は `step` が自分で引く

刻み幅と違い、太陽・月をどの時刻でサンプルするかは用途ごとに変える理由がない
(どの呼び出し側もステップ中点)。だから `OrbitEntity.step` は `Ephemeris` を受け取って
自分で引く。呼び出し側が中点を計算して位置を渡す形にはしない — 同じ3行が呼び出し側の数だけ
複製され、サンプリング方針が分散する。

**同一時刻の再計算を避ける責務は `Ephemeris` のメモ化が持つ。** 呼び出し側が「1回引いて
N 体へ配る」最適化を担うと、`step` の窓口が「位置を渡す」と「`Ephemeris` を渡す」の2つに
割れる。メモは直近1件で、返す `Vec3` が不変なので呼び出し側からは観測できない。

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

場当たり的なオブジェクト引数は禁止。明示的な引数か、事前に共有した参照で渡す。既存の `*Ctx`/`*Params`
はほぼすべて明示引数か共有参照へ展開済みで、唯一残る例外が `Player.behave` のパラメータオブジェクト
(`memos/hedalu244/refactoring_plan/STOP_USING_CTX.md` に経緯がある)。新規追加も、この生き残りを
広げることも禁止。

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

## 戦闘ターゲットと航法ターゲットは別クラスにする

「ターゲット」に見える対象が2種類ある。**型も操作系も違うので、一本化しない。**

- **`Targeter`**(戦闘ターゲット)は `Enemy` しか指せない。右クリックで敵に当たったときだけ開く
  メニューで第一/第二を設定・解除する(自動選定・自動再選択はしない)。第一は射撃補助(◇/◆ 方位
  マーカー・的通過マーク・LEAD)の対象、第二は表示(シアンの軌道線・マーカー・敵一覧の色分け)のみ。
- **`NavTarget`**(航法ターゲット)は `MapPickable` なら何でも指せる(生存中の自機・敵船、月、
  ラグランジュ点)。マップの右クリックメニューから設定し、自機軌道との相対 AN/DN(面変更 burn の
  位置)を出す。ノード追加・時間加速のメニューもここから伸びる。

分ける理由は「対象の型が違う」(`Enemy` 専用 vs. 任意の `MapPickable`)だけでなく、「何のための
指定か」も違う——一方は射撃、他方はマヌーバ計画——ので、片方の都合(たとえば `Enemy` 専用の
攻撃補助ロジック)がもう片方の対象範囲を縛らないようにする。両方が同じ敵を指すことはあるが、
それは偶然の一致であって、内部で1つの id を共有させたりはしない。

## マニューバ計画(`Plan`)は艦(`Player`)自身が持つ

**`Plan` の所有者は各 `Player` インスタンスで、`PlanEditor` は所有しない。** `PlanEditor.plan` は
`activePlayer.plan` を返すだけの getter で、`PlanEditor` 自身は計画の中身(ノード列・アンカー)を
一切保持しない。

理由: クリエイティブモードでは複数の艦が同時に存在し、それぞれが自分自身のマニューバ計画を持てる
必要がある(操作対象でない艦にも、軌道計画への自動追従という形で計画が使われる)。計画編集 UI
(`PlanEditor`)は常に単一の「今操作している艦」に対して開かれるものなので、UI 側が「今どの艦を
編集しているか」を持ち、実データは艦側に置くのが自然な分割になる——`PlanEditor.setActivePlayer(ship)`
を呼ぶだけで編集対象が切り替わり、`Plan` を丸ごとコピー/移動する必要がない。

## 自機は1隻でも `EntityManager.players` に入れ、シミュレーションでは対等に扱う

**自機用の派生クラスは作らない。** 艦は常に `Player` そのもので、ステージモードの1隻もクリエイティブ
モードの複数隻も**すべて `EntityManager.players` に入る**(`Game` はコンストラクタで `new Player(...)`
した直後に `entities.addPlayer(...)` する)。`EntityManager.all()` は `players` を含む。

**`Game.player` は「そのうち今操作している1隻」への参照であって、二重の所有ではない。**
`Targeter.target` が `entities.enemies` の1体を指すのと同じ「選択」の関係で、実体の所有は配列側にある。

この形にすると、**積分・姿勢積分・衝突・被弾判定・寿命判定・予測はどれも `players` を他のエンティティと
同じループで舐めればよく、「アクティブ艦だけ除外する」分岐が要らない。** 参照同一性による除外
(`if (e !== player)`)や `= null` 既定引数で守る形は、書き忘れが型エラーにならず静かに二重処理に
なるので採らない。

操作対象を特別扱いしてよいのは、**「操作している人間」に紐づくものだけ**:

- `Player.behave`(入力を受けるのは操作対象だけ)
- `PlayerMarkers`(方位マーカー・ボアサイト・`▷`)とガンサイトズームでの自機非表示 —
  `Player.syncPlayer(..., isActive)` の `isActive` がこれを分ける
- `ThermalSystem` の HUD 警告(`Simulator` が `player.thermal.updateThermal` を操作対象にだけ呼ぶ)
- 薬莢の接触音(操作対象がマイクを持っているという扱い)

`EntityManager.sync` だけは `players` を含めない。自機はエフェクト・ベルト・軌道線まで持ち
`Player.syncPlayer` が担当するためで、これは参照同一性の除外ではなく**配列そのものを分けた**形
(private `otherEntities()`)にしてある。

## アクティブ艦(操作対象)の切替は `Game.setActivePlayer` に一元化する

`Game.player` は固定ではなく、クリエイティブモードでは実行時に差し替わる(「艦を右クリック →
操作対象にする」)。**艦の切替に伴う副作用は `Game.setActivePlayer(ship)` 一箇所に閉じ、各所有者は
自分の持ち分だけを更新する:**

- `this.player = ship`(`entities.players` のどれを選んでいるか)
- `cameraSystem.setActivePlayer(ship)` → `CombatCameraSystem.setActivePlayer` → `ChaseCamera.setPlayer`
  (視点の基準ship参照を差し替える。`rot`/`dist` は据え置きで、切替の瞬間に視点が跳ばない)
- `editor.setActivePlayer(ship)`(`PlanEditor` の編集対象。選択中ノード・開いたメニューは前の艦の
  計画を指しているので破棄する)
- `targeter.clearTargets()`(前の艦が握っていた戦闘ターゲットのロックは新しい艦には無関係)

これは「たまたま同時に切り替わるフラグ」節のトグラー集約と同じパターン——複数モジュールにまたがる
副作用を持つ切替は、切り替える側を一箇所に置いて全部書き換える。**新しい副作用(艦ごとに持つ状態)を
足すときは、ここに追加する。**

## クリエイティブモードは `Stage` のサブクラスであって、`Game` の第二の軸ではない

`CreativeStage extends Stage` として実装する。`checkWin()` は常に `false`(`StageDebug` と同じ手法)
で、勝敗判定・`UnlockManager` のクリア回数記録を素通りする。

理由: `Stage` は既に「勝敗 `phase`」「毎フレーム `update`」「ステータスパネル」「`Logistics`」を
1つだけ持つ形で `Game` に組み込まれている。クリエイティブモードを `Game` レベルの分岐(例えば
`Game` に `mode: 'stage' | 'creative'` を持たせて各所で分岐する形)にすると、`Game.update`/`sync`
の全域に分岐が入る。`Stage` のサブクラスにすれば `Game` 側は「どの `Stage` 実装が動いているか」を
知らないままでよく、既存の1本の `activeStage` 経路にそのまま乗る。

`CreativeStage` は `STAGE_DEFINITIONS`/`STAGE_CLASSES` に**登録しない**(タイトルのステージ選択タブに
出ない、`?stage=` では起動できない)。`game.ts` は `LaunchSelection.mode === 'creative'` のとき
`initStage()` を経由せず `CreativeStage` を直接 `new` し、`setup()`/`init()` を自分で順に呼ぶ——
`initStage()` は「タイトルのステージ選択タブに出す `Stage`」の初期化手順であり、出さない
`CreativeStage` がそこを通る理由がないため。

**ゲーム所有リソースの注入は `Stage.setup` の1回だけ**にする(二段初期化を足さない)。あるステージ
だけが要るリソースでも `setup` の引数を増やし、`Stage` が protected フィールドとして持つ。サブクラス
固有の初期化は `setup` を override して `super.setup(...)` の後に書く。`!` 定義代入フィールドが並ぶ
二段目の初期化メソッドは、呼び忘れが型で守られないので作らない。

## 天球グリッド(`render/celestial-grid.ts`)の可視状態は `Navball` が持つ

`CelestialGrid` 自身は可視状態を持たない(6トグルぶんの `boolean` を毎フレーム引数で受け取って
描くだけ)。**正本は `Navball.gridVisibility`。** `Game.sync` がそれを読み、
`EnvironmentScene.sync` の `gridVisibility` 引数経由で `CelestialGrid.sync` へ渡す。

理由: グリッドの ON/OFF トグル UI は Navball ウィンドウの一部として置かれている(姿勢儀と天球グリッドは
別概念だが、画面上どちらも「今どちらを向いているか」を確認する計器という位置づけで同じウィンドウに
まとめた——UI とマーカーの所有原則どおり、GUI はその GUI が書き換える状態の所有者が持つ、の帰結として
トグルの状態は Navball 自身のフィールドになる)。`EnvironmentScene`/`CelestialGrid` はどちらも描画側の
実装なので、可視性という「何を見せるか」の判断は持たせない。

## マップの被選択物候補(`MapPickable[]`)の組み立ては `Game.update` が担う

マップ上で右クリック/フォーカス選択の対象になりうるもの(天体ラベル・生存中の自機・敵船・
航法ターゲットの AN/DN アイコン・近地点/遠地点アイコン)は、**`Game.buildMapPickables()` が
毎フレーム1箇所で組み立て、`CameraSystem.update`/`Game.handleMapContextMenu` へ明示引数で渡す。**
各消費側が自分の知っている候補だけで判定する(たとえば `OverviewCamera` が `FocusMarkers` だけを
見る)形は取らない——候補の集合はどの消費側にとっても同じでなければならず、増える候補の種類ごとに
複数箇所を書き換える必要がないようにするため。

**候補列は1本に保つ。** 種類ごとに別の列を作って消費側で順に引く形にすると、片方しか見ない消費側が
必ず出て「メニューには出るがフォーカスは効かない」ように割れる。`PlanDisplay.apsisMarkers` は
`PlanEditor.sync`(`update` より後)が算出するので `buildMapPickables()` が読むのは前フレームの値に
なるが、1フレームの遅れはピック判定にとって無害なので、列を分ける理由にはしない。

呼び出し位置は **`Game.sync` ではなく `Game.update` の先頭**。フォーカス解決
(`OverviewCamera.update`)も右クリック判定(`handleMapContextMenu`)もどちらも `update` フェーズの
仕事で、`DisplayTimeManager.resolveDisplayTime` が副作用のない純粋関数だからこそ `sync` を待たずに
`update` の先頭で表示時刻を確定できる。

被選択物の種別(`MapPickKind`)は `'body' | 'ship' | 'player' | 'apsis' | 'relnode'`。自機は隻数に
かかわらず `'player'`、敵船が `'ship'`。メニュー項目の表は `Game.mapMenuItemsFor` にあるが、
**「その対象に対してその操作が意味を持つか」の判定は、その操作の所有者に問い合わせる**
(航法ターゲット項目なら `NavTarget.canTarget`)。項目を出しておいて選ばれてから黙って失敗する形は
採らない。

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
- **自機と敵の戦闘挙動。** 武装も観測機器も別物という設定なので、射撃・照準・散布界・被弾判定などは
  今たまたま同じ式でも**将来別々に調整される前提**で、`player/` 側と `Enemy` 側にそれぞれ実装する。
  同じ関数が2箇所にあってよい。共通化してよいのは、どちらの調整とも無関係な純粋な物理・幾何
  (`physics/intercept.ts` の見越し計算など)だけ。

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

### コンテキストメニューは対象を自分で保持する(`ContextMenu<T>`)

右クリックメニューは「何に対して開いたか」を**メニュー機構側が持つ**。`hud/context-menu.ts` の
`ContextMenu<T>` が `open(x, y, target, items)` で対象を保持し、`onSelect(act, target)` で選ばれた
項目とともに返す。閉じれば対象も破棄されるので、古い対象へ操作が届くことがない。

呼び出し側は「対象を覚えるフィールド + null チェック」を持たない。項目リストと選択後の振る舞い
だけを持つ。現況: `Game`(`ContextMenu<MapPickable>`)・`Targeter`(`ContextMenu<Enemy>`)・
`NodeGizmo`(`ContextMenu<number>`)。**「対象を保持するだけ」のラッパークラスを間に挟まない。**

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
