# Entity の Motion / View 分離計画

## 目的

`CelestialEntity` と `DynamicEntity` を、物理・時刻問い合わせを担う Motion と、3D 表示資源を組み立てて同期する View の所有者にする。Entity 自身は両者と、入力・AI・接触のゲーム上の帰結・勝敗・選択などを結び付けるオーケストレーションへ縮める。

この作業は挙動を変える機能追加ではない。物理値、描画内容、フレーム順、セーブ形式を保存したまま、依存と責務を移すリファクタリングとして行う。

## 調査結果

- `CelestialMotion` は天体の位置・速度・姿勢を時刻から返す正本として既に分離されている。一方 `CelestialEntity` は `THREE` を import し、`build` / `setVisible` / `sync` / `dispose` を抽象 API に持つ。`PointEntity`、`SphereEntity`、`StarEntity` は同じ天体の運動を、見かけの大きさに応じて異なる表示物へ反映するだけの差である。
- 天体の参照軌道線は `CelestialEntity` が `EllipseLine` を生成・同期・破棄し、環は `celestial-entity/ring-view.ts`、オーロラと表面・雲の部品は `render/` に置かれている。3D 表示の構成責務の層境界がこの単位では揃っていない。
- `DynamicEntity` は actual/predicted の軌道、姿勢、推力、熱、積分、時刻問い合わせ、接触フックと同時に、`renderObject`、scene への登録、メッシュ同期、熱発光、軌道線、赤道交点マーカーの生成・同期・破棄を持つ。`Simulator` / `Predictor` / 接触解決はこの Entity 全体を引いている。
- `DynamicSystem.sync()` は pool のフレームを開始して各 Entity の `sync()` を呼び、終了する明確な同期境界を既に持つ。Player、Base、Enemy、Bullet、Debris などの `syncModel()` は、この境界で描画を分離できる。
- DOM マーカーは `MarkerManager`、`CelestialMarkers`、レイアウトが既に所有している。今回の 3D View 分離に混ぜない。`MapView` はマップ画面の ViewFrame であり、Entity に付随する `CelestialView` / `DynamicView` と同名衝突の実害はない。

## 到達する構造と境界

```text
CelestialEntity                    DynamicEntity
├─ motion: CelestialMotion         ├─ motion: DynamicMotion
├─ view: CelestialView             ├─ view: DynamicView
└─ 選択・地図・メニュー              └─ 入力・AI・接触のゲーム上の帰結・選択
```

### Motion

- `CelestialMotion` を名前・置き場とも維持する。時刻から状態を返す純粋なモデルであり、キャッシュ以外の副作用を持たないという契約を保つ。
- 新設する `DynamicMotion` は `actual: DynamicTrajectory`、予測弧、姿勢、推力・物性・熱、および積分・`stateAt()`・予測の無効化を所有する。`DynamicTrajectory` は actual / predicted の各一本の時系列として名称も実装も残す。
- 接触の厳密な幾何・反発計算は引き続き `physics/` に置く。ダメージ、死亡、spawn、ステージ記録、音・演出の開始は Motion に移さず、各 Entity の接触ハンドラ、または後続で明示的に注入する反応へ残す。

### View

- `CelestialView` と `DynamicView` は `THREE` の表示資源、scene への登録、表示可否、`sync`、`dispose` を所有する。View が保持してよい可変状態は GPU/THREE 資源、LOD・プール・描画キャッシュだけで、ゲーム状態・物理状態の正本を持たない。
- View は Motion の公開問い合わせと、そのフレームの floating origin、camera、graphics、style だけから表示を更新する。View から simulator、predictor、入力、stage、HUD へ逆依存を作らない。
- `PointEntity` / `SphereEntity` / `StarEntity` は廃止し、`PointCelestialView` / `SphereCelestialView` / `StarCelestialView` の多態へ置き換える。差は表示構成なので Entity の型を増やさない。
- `RingView` は `src/render/` に移す。`Aurora`、`CelestialSurface`、`BodyGraticule`、雲、環などの単体部品は `render/` に保ち、天体ごとの差分を組み立てるのは `CelestialView` に集める。
- 予測線・実軌跡線・楕円・対象相対線は THREE へ反映するので `DynamicView` の所有にする。表示するかというゲーム上の選択値は Entity に残して View へ渡す。

`View` はこのリポジトリでは「3D 表示物を所有して同期する」語として用いる。画面・カメラを担う既存の `MapView` / `CombatView` は別の抽象度なので、今回改名しない。

## 実施計画

### 1. 分離後の最小契約を先に定義し、現在の依存面を測る

**対象:** `DEVELOP/CODING-RULE.md`、`src/game/celestial/celestial-entity/`、`src/game/dynamic/dynamic-entity/`、`src/game/dynamic/{simulator,predictor,entity-contact-physics,surface-contact-physics}.ts`、関連テスト。

1. `Motion` / `View` の上記境界をコード規約の層・命名規則へ追記する。`Trajectory` は一本の時系列、`Motion` は Entity に属する物理状態の束、`View` は 3D 表示資源の所有者、と明文化する。
2. `Simulator`、`Predictor`、2種類の contact physics が実際に読むメンバだけを列挙し、`DynamicSimulationParticipant` と `PredictableMotion` の必要最小面を決める。Entity の UI / THREE / stage API を写すだけの広い interface は作らない。
3. `CelestialEntity` と `DynamicEntity` への `THREE` import、`renderObject` / `scene` / 線・marker の所有、各 `sync*` / `dispose` の参照箇所を検索してベースラインにする。あわせて `Simulator` / `Predictor` の `DynamicEntity` / `DynamicMotion` / `DynamicSystem` import を記録する。移行の各段で、Motion から THREE を import していないこと、View から simulator / predictor を import していないこと、Simulator / Predictor が具体 Entity・Motion・System を import していないことを確認する。

**完了条件:** 以後のファイル移動で新たな語義を決め直さずに済み、物理 consumer を Entity の全 API から切り離す対象が確定している。

### 2. Celestial の Entity 型分岐を View の多態へ移す

**対象:** `src/game/celestial/celestial-entity/{celestial-entity,point-entity,sphere-entity,star-entity}.ts`、`src/game/celestial/celestial-system.ts`、`src/game/celestial/solar-system/*.ts`、天体のテスト。

1. `CelestialEntity` を `motion`、天体の識別・選択・地図用データ、`view: CelestialView` を持つ一つの具象所有者へ変更する。現在の `stateAt`、`def`、`id` などは Motion への委譲として互換に保つ。
2. 現在の Point / Sphere / Star の `build`、`setVisible`、`sync`、`dispose` をそれぞれの `CelestialView` 実装へ移し、Entity の同期は `view.sync(motion, frame-input)` だけにする。太陽放射照度の算出など、表示だけが使う処理も View 側へ寄せる。
3. solar-system の factory は Entity の具象型を選ばず、天体定義から適切な View を構成して `CelestialEntity` へ渡す。既存の `CelestialEntity` を返す外部 API と、各天体の表示差分は維持する。
4. `CelestialSystem.sync()` の body loop と構築・破棄の順序を保ち、Entity が個別 View の生成順や THREE 資源の詳細を知る必要がない形へ縮める。

**検証:** `npm run typecheck`、`npm run test:physics`、`npm run test:game`、既存の天体描画に関係する `test:render` を実行する。型検索で `PointEntity` / `SphereEntity` / `StarEntity` の参照が残っていないことも確認する。

### 3. Celestial の 3D 付随表示を CelestialView と render へそろえる

**対象:** `src/game/celestial/celestial-entity/{celestial-entity,ring-view,geostationary-overlay}.ts`、新設する celestial view 群、`src/render/ring*.ts`、`src/render/{aurora,celestial-surface,body-graticule}.ts`、`src/game/celestial/celestial-system.ts`。

1. `ring-view.ts` を `src/render/` へ移し、環の mesh / outline / LOD / dispose を担う render 部品として import を更新する。物理の環定義と表示の変換入力は明示的に受け、`CelestialEntity` へ戻る依存を作らない。
2. `RingView`、表面、雲、オーロラ、graticule、星、静止軌道の 3D overlay を個別 render 部品と `CelestialView` の構成に分ける。Overlay が天体の状態を読む必要がある場合は Entity ではなく `CelestialMotion` または View が渡すフレーム値を受ける。
3. `CelestialEntity` が所有する参照軌道線 (`EllipseLine`) を `CelestialView` 側へ移す。`CelestialSystem` はマップの可視性判定を Entity / View へ渡すだけにし、線の生成・同期・解放を直接扱わない。
4. atmosphere / shadow / planet-light の候補作成を、物理値を Motion から引く表示用問い合わせと、renderer のスロット更新に分ける。候補の選定と renderer への set は `CelestialSystem` に残してよいが、個体の THREE 資源を Entity へ戻さない。

**検証:** `npm run typecheck`、`npm run test:game`、`npm run test:render`。環のある天体、雲・オーロラのある地球、星、点 LOD / 球 LOD、参照軌道線、静止軌道 overlay を実行時確認が必要な別タスクで確認する。

### 4. DynamicMotion を actual / predicted の唯一の窓として切り出す

**対象:** 新設 `src/game/dynamic/dynamic-entity/dynamic-motion.ts`、`dynamic-entity.ts`、`src/game/dynamic/{simulator,predictor,predicted-arc,entity-contact-physics,surface-contact-physics}.ts`、`src/game/player/` と dynamic entity 派生、物理・ゲームテスト。

1. `DynamicEntity` から `actual`、予測弧、`state` / `prevState` / `stateAt`、姿勢、推力、物性、熱、積分・予測無効化を `DynamicMotion` へ移す。`DynamicMotion` は `DynamicTrajectory` を actual / predicted の二本としてそのまま使い、予測と実測で同一の物理パラメータを使う現在の契約を保つ。
2. Entity は `motion` を所有して、既存の派生クラスと consumer が段階的に移れるよう必要な委譲を短期間だけ残す。全 consumer が Motion の狭い面へ移った時点で、物理値への Entity 委譲を削除する。
3. `Simulator` と surface / entity contact physics は `DynamicSimulationParticipant` を受けるようにする。`Simulator` の constructor と scratch 配列は、`all()` がこの参加者を返す狭い roster、および必要なら cleanup / spawn だけを持つ狭い registry を受け、`DynamicSystem`、`DynamicEntity`、`DynamicMotion` を import しない。衝突時は参加者の物理状態を更新し、Entity の `collideWith*` にゲーム上の帰結を通知する。
4. `Predictor` は `PredictableMotion` を返す狭い roster を受け、`DynamicEntity`、`DynamicMotion`、`EntityRoster` を import しない。未来を読む理由・弧の構築・時刻問い合わせは Motion へ移し、予測を表示するかの意思は Entity / UI 側に残す。
5. Player / Enemy の AI、入力、射撃、stage への spawn・記録を Motion へ押し込まない。これらが積分前後に Motion へ命令し、接触の結果を Entity が処理する順序を既存どおりに保つ。

**検証:** `npm run typecheck`、`npm run test:physics`、`npm run test:game`。actual と predicted の状態取得、接触後の予測無効化、再突入・熱、姿勢、推力ありの実積分を既存テストで回帰させる。

### 5. DynamicView を導入し、基底の THREE 所有を追い出す

**対象:** 新設 `src/game/dynamic/dynamic-entity/dynamic-view.ts`、`dynamic-entity.ts`、`src/game/dynamic/dynamic-system.ts`、`src/game/lines/`、`src/game/marker/equator-node-marker-pair.ts`、関連 render 部品。

1. `renderObject`、scene attach / detach、`placeModel`、姿勢反映、熱発光を `DynamicView` へ移す。`DynamicView.sync(motion, frame-input)` は表示時刻の state を一度引き、floating origin・可視性・姿勢を THREE に反映する。
2. `EllipseLine`、`TargetRelativeLine`、`TrajectoryLine` を `DynamicView` が所有する。Entity の menu / UI は「何を表示するか」の値と操作だけを保持し、View に同期入力として渡す。赤道交点を含む DOM marker は今回移さず、既存の marker 層と Entity の選択・操作の結び付きを保つ。
3. `DynamicSystem.sync()` は pool の begin/end と Entity の `sync` の順序を保つ。Entity は Motion と View を結び、View が instanced pool へ変換を書き込めるよう、現在の pool input を View へ渡す。
4. まず Bullet、DebrisPiece、DetachedBooster、pickup のような表示付随物が少ない型を個別 `DynamicView` へ移す。その後 Base / Enemy、最後に Player を移す。すべてを一度に基底 class から剥がさない。

**検証:** `npm run typecheck`、`npm run test:game`、`npm run test:render`。死亡時の表示回収、プール描画、マップと戦闘ビューの可視性、予測線・実軌跡・対象相対線・赤道交点の表示切替を確認する。

### 6. Player と複合部品を Motion / PlayerView に分け、残存の混在を棚卸しする

**対象:** `src/game/player/{player,thrust-effects,rcs-effects,reentry-effects,attached-boosters,belt,belt-physics,radiator,power,player-markers}.ts`、`src/game/dynamic/dynamic-entity/{base,enemy,protein-enemy}.ts`、対応する render 部品。

1. `PlayerView` にモデル、噴射・RCS・再突入エフェクト、3D ベルト、外観上のブースター・放熱板・電力表示、Player の 3D marker 同期を移す。View が受けるのは `Player` / `DynamicMotion` が公開する値とフレーム入力だけにする。
2. 接触 proxy、放熱板の展開による物性、燃料・段分離・推力・発熱、belt の接触状態は Motion / Entity 側に残す。現在一つのクラスに同居する部品は、物理側と表示側に分け、配列の添字で外部対応表を作らない。
3. Base、Enemy、ProteinEnemy の `syncModel()` と render resource を対応する View へ移す。ProteinRuntime のように戦闘と描画の双方が読むものは、正本を Motion / Entity に残して View には読み取り面だけを渡す。
4. 全移行後、`DynamicEntity` から THREE import、`scene`、`renderObject`、直接の 3D line resource 所有を除去する。DOM marker は別作業まで既存の所有を保つ。残るメソッドを、Motion・View・ゲーム上のオーケストレーションのいずれかへ分類し、薄い委譲だけの module を畳む。

**検証:** `npm run typecheck`、`npm run test:physics`、`npm run test:game`、`npm run test:render`。変更後の Player 操作、段分離、接触 proxy、被弾・死亡、各エフェクトは必要に応じて `/verify` の実行時確認として別途実施する。

### 7. 仕上げの依存・命名・コメント点検

**対象:** 変更した全 `src/**/*.ts`、テスト、`DEVELOP/CODING-RULE.md`。

1. `Motion` が THREE / render を import せず、`View` が simulator / predictor / input / stage を import しないことを検索で確認する。さらに `Simulator` / `Predictor` が `DynamicEntity`、`DynamicMotion`、`DynamicSystem` を import せず、用途別の参加者 / roster 面だけを import することを確認する。`CelestialEntity` / `DynamicEntity` が他層へ値を渡すだけの責務なしラッパーになっていないかを、実際に残るオーケストレーションで点検する。
2. `CelestialView` / `DynamicView` と既存画面 View の用語が import 先・責務から判別できることを確認し、混乱を生む名称だけを改める。`MapView` はこの理由だけでは変えない。
3. 移設により古くなったコメント、旧 Entity を主語にするコメント、実装経緯のコメントを更新または除去し、`DEVELOP/CODING-RULE.md` のコメント規約へそろえる。
4. 各段の差分を review し、Entity に残すゲーム判断と Motion / View の正本が二重管理になっていないことを確認する。

**検証:** `npm run typecheck` は各段で必ず実行する。最終段では、触れた層に応じて `npm run test:physics`、`npm run test:game`、`npm run test:render` を実行する。

## リスクと判断基準

- View を「状態を一切持たない」と解釈して THREE 資源・LOD・pool の管理まで外へ出すと、かえって外部対応表と同期責務が生まれる。禁止するのはゲーム・物理状態の正本であり、表示資源の所有ではない。
- `DynamicMotion` を導入しても、接触の結果まで Motion に集めない。結果を Simulator に集めることも避け、当事者の Entity が自分に起きるゲーム上の帰結を処理する現行原則を保つ。
- `DynamicSimulationParticipant` は Simulator / contact physics の実使用メンバから作る。`DynamicEntity` の全面を複製する interface や、将来の Entity 種別を先回りする abstract base は作らない。
- DOM marker、HUD、Pickable / menu の分離は有益になり得るが、3D View 分離と同時に行わない。前者は表示だけでなく操作・選択のモデルも含む別の責務分割である。
- 表示と予測は表示時刻が未来に移るため、`stateAt()` の null と actual / predicted の切替が最重要の回帰点である。View が独自に軌道を保持・再計算して二つ目の正本を作らない。

## 完了条件

1. `CelestialEntity` は一つの Entity 型で `CelestialMotion` と表示構成を所有し、Point / Sphere / Star の違いは View の多態だけで表す。
2. `DynamicEntity` は `DynamicMotion` と `DynamicView` を所有し、基底から THREE scene / object / line resource の所有が消えている。DOM marker は今回の対象外とする。
3. `CelestialMotion` / `DynamicMotion` は render / THREE に依存せず、各 View はゲーム進行・物理更新の正本を持たない。
4. `Simulator` / `Predictor` は `DynamicEntity`、`DynamicMotion`、`DynamicSystem` を直接 import せず、それぞれが必要とする狭い participant / roster 面だけへ依存する。
5. `RingView` を含む天体の個別 3D 部品は `render/` にあり、CelestialView / DynamicView がそれらを構成する。
6. `npm run typecheck` と、変更した物理・ゲーム・render 層の回帰テストが通る。
