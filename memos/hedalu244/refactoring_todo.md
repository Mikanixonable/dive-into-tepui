# 方針

- トップレベルの適切なオーケストレーション化
  main.tsやgame.tsに実装が直接書かれるべきでない
- 関数、モジュールの疎結合化と責務の整理
  - 過剰責務（モジュールや関数が長すぎる）の解消
  - 過小責務（たらいまわし配線のみの関数、モジュール）の削除、解体、統合
  - 責務漏洩（この処理はこの関数にあるべきでない。この関数はこのモジュールにあるべきでない）の整理
- 重複実装、類似実装の解消、コード、値を適切に再利用する
- 不適切な命名の解消
- 不要なクロージャ注入は行わない。特定のオブジェクトに影響を及ぼしたいならそのmutableなオブジェクトを直接渡す。関数の引数にオブジェクトを作るのは柔軟性が高い反面、複雑なクロージャー関係が生まれて可読性を下げる。
- 場当たり的なオブジェクト引数の禁止。ctxやcontext、opt、paramsなどの引数は原則使わない。STOP_USING_CTX.mdを参照。

判断基準そのものは `/refactor`（一般方針）と `/refactor-fixed`（確定した責務境界）が正本。

このファイルは **todo リスト**であり、経緯を残す場所ではない。完了した項目は消す。

## 参照共有を明示する命名規則
モジュールのプライベートフィールドに外部のモジュールがある場合について、そのインスタンスの保持責務を持つモジュール（コンストラクタでnewしていることなどが判断材料）と、外部から受け取って参照コピーだけ保持しているモジュールがある。これらは明確に区別できなければいけない。参照だけ保持している例において、それが外部で変更されることが重要である場合には、そもそも参照を保持するのではなく、引数で受け取るべきである。

### MapPickableの依存関係
  1. `Targeter` が `MapPickable` を import し、`pickEnemyAt` が毎クリック偽の `MapPickable[]` を
     組み立てて `pickNearest` を呼ぶ。`/add-feature` としては正解(ヒットテストの複製を避けた)だが、
     戦闘側がマップ用の型に依存する形になった。`pickNearest` を `MapPickable` ではなく
     `{ pos: Vec3 }` 制約の汎用関数にしておけば依存は生じなかった。

### 重複実装懸念
  2. `Targeter` が `ContextMenu` を直接持ち、`currentMenuTarget` + `onSelect` ディスパッチという
     **`MapContextGizmo` と同型のパターンを再実装**している(→ 4-5)。

### 9. `Navball` が天球グリッドの可視状態を持つ

指示書 WP-D2b が「グリッドトグル6つはこのウィンドウ内に置く」と指示した帰結で、
`refactor-fixed` にも判断として記録済み。ただし姿勢儀(機体座標)と天球グリッド(ワールド座標の表示物)は
別概念で、`Navball.gridVisibility` は `Navball` の責務外の状態。
「GUI はその GUI が書き換える状態の所有者が持つ」という既存原則の帰結ではあるので、
規約違反というより**トグルの置き場所の選択が状態の置き場所を決めてしまった**例。要判断。

| 黄道/赤道の面・極・グリッド6トグル | `render/celestial-grid.ts`(新、`EnvironmentScene` 所有)、可視状態は `Navball.gridVisibility` | ⚠️ Ctx を広げた(→ 4-1) |

### 巨大モジュールの分割
`ship-placer-panel.ts` / `plan-editor.ts` / `dock-view.ts` はモジュール 200行 の基準を
大きく超える。`ship-placer-panel.ts` はフィールド宣言だけで40行以上あり、「軌道要素フォーム」と
「ラグランジュ点フォーム」で分割の余地がある。`plan-editor.ts` は Δv 編集(キー/ボタン/ドラッグ/
ラッチ)と `NodeGizmo`/`PlanGizmo3D` の配線が同居しており、分割の余地がある。`dock-view.ts` は
格納艦/部品/ショップの3タブを1クラスの `buildShipsTab`/`buildPartsTab`/`buildShopTab` 以下に
持ち、部品タブ関連(`buildPartsTab`〜`buildWarehouseList` 等)だけで200行を超えており、
タブ単位での分割の余地がある。

- **行数** — `game/hud/dock-view.ts` 1086 / `game/creative/ship-placer-panel.ts` 853 /
  `game/map-context-actions.ts` 847 / `game/plan/plan-editor.ts` 787 /
  `game/hud/save-browser.ts` 614 / `game/const.ts` 587 / `render/ships.ts` 582 /
  `game/game.ts` 514。200 行基準を大きく超える。
  `game.ts` はコンストラクタでの配線(for 文・条件分岐なし)と、update/handleInput/sync の
  3フェーズの呼び出し順制御からなる。フェーズ側には視点(マップ/戦闘)や自機の有無による
  条件分岐が残っており、これ以上削るならフェーズそのものを別モジュールへ移す判断が要る。


## marker周りの責務漏洩(情報が古そう。要調査)
markerはそれを表示するオブジェクトが持つべき、という原則があったはずだが、全然守られていない。
GameEntityに重ねて表示するマーカーを、GameEntity側が持つという形で一本化したい。syncやdisplayTimeの問題も一挙に解決するはず。

例えば、ammoのmarkerがammoではなくlogisticsが管理している。これはパターンを崩すのでダメ。

groupedmarkerの責務がenemy.markerItemに漏洩している。
enemyのmarkerはplayerやammoと同様、単にmarkerを持っていてそれを更新するという形であるべき。GroupedMarkerItemを返す関数が実装されているべきではなく、enemyはそのmarkerがそのまま表示されるのか、groupedされて表示されるのかを知るべきではない。
groupedMarkerは任意のentityのmarkerをまとめられるように再利用性を高く保っているのに、enemy側に専用実装があったら再利用性が低くて意味がない。

groupedMarkerは与えられたentity配列（markerEntityみたいなinterfaceを作ってもいいかも）からmarkerを回収し、まとめられるものは非表示にしてまとめたものに置き換え、まとめられないものはそのまま表示するという責務を行う。GroupedmarkerItemを作る作業などを漏洩してはいけない。

`MarkerManager` が `combatMarkers` / `leadMarkers` / `equatorNodeMarkers` を保持しているのは
仮置き（コード上にもTODOコメントあり）。「表示機構」であるMarkerManagerとは別の分類なので、
上記の整理と合わせて適切な所有者を決める。





# やる必要がない可能性があるもの
以下に書かれているものは場合によっては依存関係が悪化したりリファクタリング方針に反したりする可能性がある

## beltPhysicsとbeltSectionの変換処理の見直し
beltPhysicsにbeltSection[]を「書き込む」という処理をしていて、ステートフルで良くない（メモリ効率はいいかもしれないが気にするほどじゃないはず）
beltPhysicsからbeltSection[]への変換と逆変換ということにシ、逆変換においては新規オブジェクトとして作るべきでは？

belt-physics.ts の機体⇔ワールド変換の分散もあるらしい。

## const.tsの解体（優先度低）
一か所で使用されている定数はそのモジュールの責務である可能性が高い。モジュールの分割がある程度進み、責務が明確になった段階で、const.tsの解体を行う。

## dtとsimDtの混在の是正
挙動を変えてしまいうる

## plan-displayがcameraModeを見る実装が適切か要検討
実質的な挙動は変わらないが将来的な堅牢性が変わる

## touchControlsとinput、playerの責務整理
ホールドとトグルの管理がplayerに漏れている。
トグルフラグをplayerがhandleEdgeInputで切り替えて、それをtouchControlに反映するという流れになっていて、配線が大回り。
案としては、KEY_MAPPING側がキーと連動したトグル管理をKEY_MAPPINGに委ねることだが……
しかし、すべてのトグル管理をKEY_MAPPINGに預ける必要はないし、預かる必要もない（cameraSystem.mapModeのトグルなどはそれが自助すべき）問題視されているのは、touchControlsのボタン点灯で参照されているもののみ………つまり過剰実装になる可能性が高い。

## 引数整理
参照されていない引数を減らしていきたい

## playerのfireのロジック まだまだ簡略化できそう、修正もできそう。

## enemy.ts の Enemy コンストラクタが _hud: Hud を受け取るが未使用。

## Stage.init の規約は「戻り値は初期敵数」だが Stage00.init は常に 0 を返す。
戻り値の使用状態を検査

## enemy-generator.ts の長大な引数リストの重複の共通化
下手にやるとctx注入と同じになる


## MAP VIEW パネル(カメラ用)に「弾薬」トグルが同居している(`camera/overview-camera-panel.ts:35-40`)。
  カメラ関連 GUI の集約という観点では逆向きの混在。
## `render/orbit-line.ts` の `densifyNear` に「要調査」コメントあり: 頂点を密に置きたいのは本来
  フローティングオリジン近傍だが、呼び出し側は自機位置を渡している。
## 戦闘ビューの方位マーカーは `orbitAxes` が地心速度基準のままで、中心天体に追従しない。
  `strongestAttractor` があるので直せるが、重力源の一般化とは別の仕様変更。
## 影判定(`lenSq(...) < R_EARTH_EQ²`)が `game-entity/enemy.ts` と `player/player-fire.ts` に
  同じ実装で2つある。

## ring-viewやbody-visiblityがgame/にある
責務的にはrender/に近い気がする。game/にピクセル単位の描画の最適化問題を持ち込むのは避けたい。

## 物理的正確さとパフォーマンスのトレードオフの検証
シミュレーションのサブステップやRK4の4ステージにおいて計算を間引いている箇所については、それはあくまでもパフォーマンス向上だけが目的の計算省略であり、実測して問題がなければ物理的正確さを優先すべき事案である。
計算時間の実測と、誤差の実測の両面から検証したい。


### `Manager` / `System` / `Physics` 接尾辞の使い分けの意味のなさ、別軸で分類できないか
「所有して毎フレーム駆動するもの」の接尾辞が4系統ある。`Manager` と `System` はどちらも中身を説明していない。

- `*Manager`: `EntityManager` `MarkerManager` `UnlockManager` `SaveManager` `DisplayTimeManager` `SimSpeedManager` `FlashEffectManager` `ViewManager`
- `*System`: `CameraSystem` `CombatCameraSystem` `EffectsSystem` `PowerSystem` `RadiatorSystem` `ThermalSystem`
- `*Physics`: `ContactPhysics` `BeltPhysics` `CollisionResponse`(型のみ)
- 動作主体名: `Simulator` `Predictor` `Targeter` `MapPicker` `Docking`

### ハロー軌道の勝手な近似（そもそも不可能なら仕方ない）

WP-E3 は「Richardson の三次近似解を使う(推奨)」で、指示書 §6-4 は
「推奨案が破綻すると分かった場合は**勝手に別案へ倒さず報告して判断を仰ぐこと**」。
実装(`physics/halo.ts`)は**線形化(一次)解のみ**で、三次の振幅拘束は実装していない。
ハロー軌道は「面外振動数に λ を流用して面内と共鳴させる」近似。
モジュール先頭コメントにその旨は明記されているので隠蔽はされていないが、
推奨案から外れた判断であり、報告・承認を経たかはコミットからは読み取れない。

なお同コメントの「Richardson (1980) の三次近似のうち…**実装していない**」は
`/comment` 方針の「なにをしないか は書かない」に触れる。ただしゲームの積分器が制限三体問題ではなく
配置後にドリフトする、という注意は非自明なので残す価値がある。書き方の整理が要る箇所。

| ハロー・リサジュー軌道 | `physics/halo.ts`(新) + `tests/physics/halo.test.ts` | ⚠️ 指示書の Richardson 三次近似ではなく線形化解(→ 4-8) |

- **`halo.ts` の三次級数展開** — 振幅拘束は入れたが、位置・速度そのものは一次解のまま。
  厳密な周期解にするには三次の級数(a21..d32 の全係数)まで要る。ゲームの積分器が制限三体問題
  ではない以上どのみちドリフトするので、優先度は低い。

## 軌道面法線の綴りが2つある

軌道面法線を求める経路が2つ並存している。

- `orbitAxes(state).nrm`(`physics/orbital.ts`) — 進行方向・法線・面内直交の3軸を組む。
- `orbitalElementsFromState(r, v).hHat`(同ファイル) — 古典軌道要素を求める過程で法線も出る。
  `targeter.ts` が相対 AN/DN の計算に使っている。

法線だけが欲しいなら `orbitAxes` の方が安く、軌道要素も併せて要るなら `orbitalElementsFromState`
を1回呼ぶ方が安い。どちらを正とするか、あるいは `OrbitalElements` から軌道基底を導けるようにして
一本化するかを決めていない。**呼び出し側の都合で使い分けてよいのか、それとも片方が
もう片方を使うべきなのか**が論点。
## スナップショットが小惑星・破片を往復させない

`SnapshotService.capture`/`buildSaveData` が保存するのは players/enemies/ammos/bases だけで、
`EntityManager.restoreFromSave` も同じ4種しか組み直さない。小惑星(`Asteroid`)と破片
(`DebrisPiece`)はセーブに載らないので、**復帰した周回では世界からその2種が消える。**
復帰時は `Stage.begin()` が `init()` を飛ばすため、ステージが配置したぶんも作り直されない。

これは負荷計測で表面化した(小惑星300体を置くステージが、復帰した起動では自機1隻だけになる)。
`Stage.checkWin()` が常に false のステージでは `SaveSlots.noteRunEnded` が呼ばれず
`lastStageId` が残り続けるので、一度オートセーブが書かれると以後ずっと復帰する。

論点は「小惑星をセーブに載せるか」「載せないなら復帰時に `init()` の配置ぶんだけを
やり直せるようにするか」。前者は `Asteroid` の質量・半径・姿勢と id を持てば足りるが、
破片500個ぶんまで持つとスナップショットが肥大する。
