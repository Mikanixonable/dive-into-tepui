# `update` → `sync` のステート引き継ぎをやめ、表示専用の値は `sync` で引いて捨てる

## 目的

`update` が書き `sync` だけが読むフィールドが、いま複数のクラスに散っている。典型は
「そのフレームに描くマーカーの座標を `update` で求め、`sync` がそれを読んで遮蔽判定と投影を
する」形で、座標のほかに**遮蔽判定に要る天体の解決時刻(pivot)まで**フィールドで持ち越して
いる。

これは `update` / `sync` の分離の目的から外れている。**`update` がフィールドを更新するのは、
原則として次フレームの `update` が読むためであるべき**で、そのフレームで表示するためだけの値を
`update` が抱えるのは、次の2つを同時に招く。

- **同じ値が2つの時刻を持ちうる。** `update` が置いた時刻と `sync` が使う時刻が食い違っても
  型でもテストでも捕まらず、「マーカーは表示時刻の位置、遮蔽する天体は別の瞬間の位置」という
  形で静かに壊れる。
- **`update` の責務が膨らむ。** シミュレーションを進める位相に、描画のためだけの計算が混ざる。
  実際 `CreativeStage.update(dt, …)` は配置プレビューの軌道要素と入力検証の結果を計算しており、
  これはシミュレーションが止まっている間は更新されない。

**そのフレームで消費して捨てる値は、`sync` の中で引いてその場で捨てる。** `sync` が引けないなら、
引くのに要る入力(表示時刻・このフレームの天体の解決)を `sync` の引数へ足す。表示窓は `dt` を
含まないので、`sync` が受け取っても `update` / `sync` の位相分離を崩さない。

あわせて、**同じ誤りが再び入らないよう判断基準を `DEVELOP/CODING-RULE.md` 1.10 へ明記する。**
基準が無いまま個別に直すと、次に `update` を書く人が同じ形を作る。

## 決めたこと

### A. 判断基準は「次フレームの `update` が読むか」で切る

`update` がフィールドへ書いてよいのは、**次フレームの `update` が読むもの**だけとする。
`sync` だけが読むものは書かない。**例外は2つだけで、どちらもコメントで理由を書く。**

1. **`update` の副産物で、`sync` が引き直せないもの。** 積分1歩の結果(燃焼率・被弾・接触)は
   その物体自身の状態であって「表示のための状態」ではない。
2. **フレームの外(ポインタ・DOM イベント)から読まれるもの。** 右クリックメニュー・プロパティ
   ウィンドウは `update` でも `sync` でもない時点で走るので、そのフレームの値を保持する必要が
   ある。

この基準で当てると、マーカーの**座標**は 2 に当たるので保持したままになり(右クリック候補として
公開されている)、**遮蔽判定の pivot と天体一覧**だけが消える。手順4 の洗い出しでも同じ切り方を
使う。

覆すなら: 例外1を認めない形にすると `DetachedBooster.lastBurnRatio` などを `sync` で再計算する
ことになるが、積分は既に終わっているので再計算できない。例外2を認めない形にすると、ポインタ
処理を `update` の中へ畳む別の設計変更が要る。どちらも本計画の範囲外。

### B. `sync` が表示時刻を要るときは `DisplayWindow` を受け取る

`DisplayWindow`(`src/game/display-window-manager.ts`)は `dt` を持たないので、これを渡しても
`sync` が論理状態を進める材料にはならない。`DisplayWindowManager.current` が既にあり、
`Game.sync` は冒頭でこれを読んでいるので、配る経路は新たに作らなくてよい。

**既存の `displayTime: number` を取る `sync`(`CelestialSystem.sync` / `DynamicSystem.sync` /
`Stage.sync`)は本計画では触らない。** 番号1つで足りているものを型へ広げても守られる不変条件が
増えず、この計画と無関係な差分が広がる。

覆すなら: 渡すものが `displayTime: number` になり、手順2・3の引数の型が変わるだけで手順の並びは
変わらない。ただし表示時刻と座標系が同じ窓から出た対であることを型で保てなくなる。

### C. 遮蔽判定に要る「天体一覧 + 引く時刻」の対は `FrameAnchorSource` で渡す

`isOccluded` / `occlusionOpacity` はカメラ位置・対象点・**天体の位置**の3つが同じ瞬間のもので
ないと答えが狂う純幾何判定で、必要なのは `(bodies, pivot)` の対である。この対は
`FrameAnchorSource`(`src/physics/frame.ts` の `bodies` / `bodiesPivot`)が既に契約として公開
しており、`Game.sync` の冒頭が毎フレームこのフレームの値へ差し替えている。**対を2つの引数へ
割って配らない** — 割ると片方だけ別の時刻を渡せてしまう。

新しい型は作らない(CODING-RULE 1.6)。

### D. 手順1〜3 で挙動は変えない

値を求める場所と渡し方だけを変える。手順2・3 の実施後、画面に出る位置・遮蔽・ラベルは
実施前と同じでなければならない。**唯一の例外は `CreativeStage` の配置プレビューで**、いまは
シミュレーションが止まっている間(ポーズ中・決着後)に更新されないが、手順3 の後は止まっていても
フォーム入力に追随するようになる。これは現状の不具合の解消であって仕様変更ではない。

## 達成目標

- **`DEVELOP/CODING-RULE.md` 1.10 に、`update` が書き `sync` だけが読むフィールドの禁止と、
  例外2つ、`sync` が `DisplayWindow` を受け取ってよい根拠が書かれている。**
- 次の 6 フィールドが `src/` から消えている(いずれも `grep -rn "<名前>" src/` が 0 件)。
  - `FocusMarkers.celestialBodiesPivot`
  - `NavTarget.celestialBodies` / `NavTarget.celestialBodiesPivot`
  - `EquatorNodeMarkerPair.celestialBodies` / `EquatorNodeMarkerPair.celestialBodiesPivot`
  - `PlanDisplay.celestialBodiesPivot`
- `grep -rn "this.preview\|this.issues" src/game/stages/creative-stage.ts` が 0 件
  (フィールドではなく `sync` のローカルになっている)。
- `src/` で `update` 系と `sync` 系のメソッドを両方持つ 26 ファイルすべてについて、
  `update` が書き `sync` だけが読むフィールドが、決めたこと A の例外1・2 のどちらかに当たると
  判定され、当たるものにはその理由がコメントに書かれている(手順4 の判定表がそのまま根拠)。
- `npm run typecheck` / `npm run test`(全層)/ `npm run build` が通る。
- マップビューで表示窓のスライダーを未来へ動かした状態で、天体の裏側に回る位置のマーカー
  (ラグランジュ点ラベル・AN/DN・EqAN/EqDN・計画のアプシス)が、実施前と同じタイミングで
  消える/現れる。

## 手順

### 手順 1. 判断基準を `CODING-RULE.md` 1.10 へ書く

**目的.** 個別の是正より先に基準を置く。手順2〜4 はこの基準を根拠に判定するので、基準が
無いまま直すと「なぜそれを消したのか」が残らない。**この時点でコードは変えない。**

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md` 1.10「フレーム処理の位相」 | 各位相の説明の後ろへ、下の3点を足す |

書き足す内容(文面はこのまま使ってよい):

- **`update` がフィールドへ書いてよいのは、次フレームの `update` が読むものだけ。** そのフレーム
  で表示するためだけの値は `sync` の中で引いてその場で捨てる。`sync` が引けないなら、引くのに
  要る入力を `sync` の引数へ足す。`update` が書き `sync` だけが読むフィールドは、同じ値が2つの
  時刻を持ちうる状態であり、食い違っても型でもテストでも捕まらない。
- **例外は2つだけで、どちらもコメントで理由を書く。** (1) 積分1歩の副産物のように `sync` が
  引き直せないもの — これはその物体自身の状態である。(2) ポインタ・DOM イベントから読まれる
  もの — フレームの外で走るので、そのフレームの値を保持する必要がある。
- **`sync` は表示窓(`DisplayWindow`)を受け取ってよい。** `dt` を含まないので論理状態を進める
  材料にならない。逆に `dt`・時間送り倍率・入力を `sync` へ渡してはならない。

**達成条件と検証.** `DEVELOP/CODING-RULE.md` 1.10 に上記3点がある。コードの差分が無いこと
(`git diff --stat -- src tests` が空)。

### 手順 2. 遮蔽判定の pivot を `FrameAnchorSource` の受け渡しへ置き換える

**目的.** マーカーの遮蔽判定が使う「天体一覧 + 引く時刻」を、`update` から持ち越すのをやめて
`sync` の引数で受け取る。**この時点で挙動は変えない** — 渡る値は現在フィールドに入るものと同じ
(どちらも `Game.sync` 冒頭で差し替えた表示時刻の値)。

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `src/game/camera/focus-markers.ts` | `celestialBodiesPivot`(187〜188行)を消す。`syncLabels(project, cameraPos)`(385行)へ `frameAnchors: FrameAnchorSource` を足し、`occlusionOpacity`(396〜398行)がそこから `bodies` / `bodiesPivot` を読む。`update` 末尾(377行)の代入を消す |
| `src/game/camera/camera-system.ts` | `sync(velocityReference)`(258行)へ `frameAnchors` を足し、`syncLabels` 呼び出し(266行)へ渡す |
| `src/game/nav-target.ts` | `celestialBodies` / `celestialBodiesPivot`(84〜87行)を消す。`update` の代入(190〜191行)を消す。`sync(cameraSystem)` へ `frameAnchors` を足し、3箇所の `setNodePosition`(327・334・341行)へ渡す |
| `src/game/marker/equator-node-marker-pair.ts` | `celestialBodies` / `celestialBodiesPivot`(24〜27行)を消す。`update` の代入(67〜68行)を消す。`sync(project, show, cameraPos)`(113行)へ `frameAnchors` を足し、`setNodePosition`(119行)へ渡す |
| `src/game/dynamic/dynamic-system.ts` | `syncEquatorNodes(cameraSystem)`(471行)へ `frameAnchors` を足し、各 `equatorNodes.sync`(475行)へ渡す |
| `src/game/plan/plan-display.ts` | `celestialBodiesPivot`(92〜93行)を消す。`update` の代入(122行)を消す。`sync(…)`(137行)へ `frameAnchors` を足し、`occludedByCelestialBody`(208〜211行)と `plannedPlayerLabel`(216行〜)がそこから読む |
| `src/game/plan/plan-editor.ts` | `sync(cameraSystem, simTime, fo)`(673行)へ `frameAnchors` を足し、`planDisplay.sync` へ渡す |
| `src/game/game.ts` | `cameraSystem.sync`(524行)・`navTarget.sync`(568行)・`dynamicSystem.syncEquatorNodes`(569行)・`editor.sync`(581行)へ `this.frameAnchors` を渡す |

`Game.sync` は 520行で `frameAnchors.update(celestialBodies, displayTime)` を済ませているので、
524行以降で渡す値はこのフレームの表示時刻の解決になる。**この順序を崩さないこと**(下のリスク表)。

**達成条件と検証.**

- `grep -rn "celestialBodiesPivot" src/` が 0 件。
- `grep -rn "private celestialBodies" src/game/nav-target.ts src/game/marker/equator-node-marker-pair.ts` が 0 件。
- `npm run typecheck` と `npm run test:game`。
- `npm run dev` でマップビューへ入り、PREDICT パネルのスライダーを未来へ動かした状態で、
  地球の裏側へ回る月・ラグランジュ点ラベルと、自機の EqAN/EqDN・計画のアプシスアイコンが、
  実施前と同じタイミングで消えて現れる。

### 手順 3. `CreativeStage` の配置プレビューを `update` から `sync` へ移す

**目的.** 配置フォームのプレビュー軌道要素と入力検証の結果は、描くこと以外に使われない値なのに
`Stage.update(dt, …)` で計算されている。`sync` で求めてその場で捨てる形にし、フィールドを消す。
**シミュレーションが止まっている間もフォーム入力に追随するようになる**(決めたこと D)。

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `src/game/stages/creative-stage.ts` | `preview`(67行)・`issues`(69行)のフィールドを消す。`update`(438行)末尾の代入(447〜448行)を消す。`sync`(211行)の冒頭で `placerPanel.isOpen ? placerPanel.getForm() : null` からその場で求め、`placerPanel.setIssues`(224行)と `syncPreview`(293行)へローカルとして渡す。`syncPreview` の引数 `celestialBodies` / `displayTime` を手順2 と同じく `frameAnchors` へ寄せる |

`computePreview` / `computeFieldIssues` は `_simulator.simTime` と `_celestialSystem` しか読まない
純粋な導出なので、`sync` から呼んでも副作用は生じない(`getForm()` は DOM の読み取りのみ)。

**達成条件と検証.**

- `grep -n "this.preview\|this.issues" src/game/stages/creative-stage.ts` が 0 件。
- `npm run typecheck` と `npm run test:game`。
- `npm run dev` でクリエイティブステージのオブジェクト配置モーダルを開き、軌道要素の値を
  変えるとプレビューの白い軌道線と ▷ マーカーが追随する。**ポーズ中(Esc)でも追随する**
  (実施前は止まる)。フィールドの検証メッセージも同様に追随する。

### 手順 4. 残る `update` / `sync` ペアを基準で洗い、判定を残す

**目的.** 手順1 の基準を、`update` 系と `sync` 系を両方持つ全クラスへ当てる。該当するものを
直し、例外に当たるものはその理由をコメントに残して、次に読む人が再判定しなくて済むようにする。

**変更が必要な箇所.** 対象は `update` 系と `sync` 系のメソッドを両方持つ 26 ファイル。
下は現時点での一次判定で、**手順4 ではこの表を検証したうえで確定させる**(「該当」の3件は直し、
「例外」はコメントを確認・不足なら足す)。

| ファイル | 引き継いでいるフィールド | 一次判定 |
| --- | --- | --- |
| `src/game/celestial/point-field-view.ts` | `sunPos` / `hasStar` | **該当**。`sync` の引数へ移す。`dirtyIndices` / `positions` / `cursor` は数フレームに分けて再評価するラウンドロビンの状態なので例外1 |
| `src/game/player/belt.ts` | `visibleCount` | **該当の疑い**。残弾から導けるので `sync` で引けるか確かめる |
| `src/game/player/radiator.ts` | `wear` | **該当の疑い**。パーツ HP の写しなので `sync` で引けるか確かめる |
| `src/game/pickable/map-pickables.ts` | `candidateItems` / `_lastSimTime` | 例外2。`map-context-actions.ts` の右クリック・プロパティウィンドウが `pickables` / `lastSimTime` をフレームの外から読む |
| `src/game/plan/plan-display.ts` | `apsisIcons` / `impactIcons` / `tickIcons` / `ghost` | 例外2。`apsisMarkers` を `MapPickables.refresh` が、`apsisTimeOf` を `map-pickable-menu.ts` がフレームの外から読む |
| `src/game/marker/equator-node-marker-pair.ts` | `icons` | 例外2。`mapPickables()` が右クリック候補として公開する |
| `src/game/nav-target.ts` | `anPos` / `anTime` / `dnPos` / `dnTime` / `closestPos` / `closestTime` / `timeLabel` | 例外2。同上 |
| `src/game/plan/plan-path.ts` | `frame` / `frameAnchors` / `unbakeTime` / `sources` / `displayFrom` / `displayTo` / `activeCount` | 例外2。`toDisplay` / `toDisplayDir` / `nearestSample` がポインタイベント起点で呼ばれる(92〜96行のコメントが既に理由を書いている) |
| `src/game/camera/focus-markers.ts` | `shownLabels` | 例外2。`bodyPickables` が候補を公開する |
| `src/game/dynamic/dynamic-entity/base.ts`, `detached-booster.ts`, `player.ts` | `thrust` / `torque` / `rcsThrust` / `boosterThrust` / `lastBurnRatio` | 例外1。積分1歩の入力・結果そのもの |
| `src/game/targeter.ts` | `boardMarks` | 例外1に近い。`age` を持ち次フレームの `update` が読む純粋な寿命付き状態 |
| `src/game/vfx/flash-effect-manager.ts`, `effects-system.ts` | `effects` | 同上 |
| `src/game/display-window-manager.ts` | `_current` | **この計画が使う配り口そのもの。** `resolve` が確定させ `current` が公開する形を維持する |
| 上記以外の 26 ファイル | — | 一次判定で引き継ぎ無し。手順4 で再確認する |

洗い出しは次のスクリプトで機械化する。**`.claude/skills/refactor/scan-phase-state.mjs` として
新規に置き**、手順1 で足した基準からこれを参照できるようにする(`comment-cleanup` の
スキャナと同じ位置づけ)。

- 入力: 対象ディレクトリ。
- 出力: ファイルごとに「`update` 系メソッドで `this.X =` され、`sync` 系メソッドだけが読む X」の
  一覧と、その合計件数。
- 判定はしない — 例外1・2 のどちらに当たるかは人が決める。

**達成条件と検証.**

- `node .claude/skills/refactor/scan-phase-state.mjs src` が動き、件数を出す。作業前後の件数を
  報告に書く。
- 上の表の「該当」「該当の疑い」がすべて決着し、直したものはフィールドが消えている。
  例外に残したものは、その行のコメントに例外1・2 のどちらかとその理由が書かれている。
- `npm run typecheck` / `npm run test`(全層)/ `npm run build`。
- `npm run dev` でマップを開き、小天体の点群(`point-field-view`)が実施前と同じ位置・同じ
  明るさで出る。自機のベルトの節点数と放熱板の損耗表示が実施前と同じ。

## 見積り

| 手順 | 触るファイル | 根拠 |
| --- | --- | --- |
| 1 | 1 | `CODING-RULE.md` 1.10 のみ。コード差分なし |
| 2 | 8 | フィールドを持つ 4 クラス + それらの `sync` を呼ぶ中継 3 (`camera-system` / `dynamic-system` / `plan-editor`) + `game.ts` |
| 3 | 1 | `creative-stage.ts` のみ。`computePreview` / `computeFieldIssues` は移動せず呼び出し位置だけ変える |
| 4 | 1(新規) + 3〜5 | スキャナ 1 + 「該当」1 (`point-field-view`) + 「該当の疑い」2 (`belt` / `radiator`) + 例外コメントの追記 |

合計 **13〜15 ファイル**(重複なし)。手順2 が引数を1つ足すだけの機械的な変更なのに 8 ファイルに
なるのは、`sync` の呼び出しが `game.ts` から 2〜3 段中継されているため。

実行時コスト: 手順2 は per-frame の呼び出し1回あたり引数が1つ増えるだけで、遮蔽判定そのものの
回数も入力も変わらない。手順3 は `computePreview` が毎フレーム 1 回走る点が変わらず、走る位相が
`update` から `sync` へ移るだけ。**どちらもフレーム時間に測れる差は出ない**見込みで、出たなら
それは想定外なので原因を調べる。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `Game.sync` で `frameAnchors.update(…)`(520行)より前に、`frameAnchors` を渡す `sync` を呼ぶ | 遮蔽判定が1フレーム前の表示時刻の天体位置を使う。**ワープ中や表示窓を大きく動かしたときだけ**マーカーの明滅として出るので、静止画では気付けない | 手順2。`game.ts` の 520行と 524〜581行の並びを目で確かめる |
| `FocusMarkers.syncLabels` を `CameraSystem.sync` の内側から呼ぶ経路(266行)で `frameAnchors` を渡し忘れ、暫定値(`bodyAnchorSource([], 0)` 相当)で判定する | 遮蔽が常に「遮られていない」になり、天体の裏側のラベルが表に出続ける | 手順2。マップビューで地球の裏側の月ラベルを見る |
| `EquatorNodeMarkerPair.sync` の呼び出し元(`DynamicSystem.syncEquatorNodes`)が艦・基地の両方を回っていることを見落とし、片方だけ引数を通す | 基地の EqAN/EqDN だけ遮蔽が効かない | 手順2。基地を持つステージでマップを開く |
| 手順3 で `computePreview` を `sync` へ移すとき、`update` 側に残った呼び出しを消し忘れて二重に走らせる | プレビューは正しく出るが、毎フレーム 2 回 `orbitalElementsOf` が走る | 手順3。`grep -n "computePreview\|computeFieldIssues" src/game/stages/creative-stage.ts` の呼び出しが各1箇所 |
| 手順3 で `placerPanel.getForm()` を `sync` から呼ぶことを「`sync` が DOM を読んでいる」と見て避け、`update` に残す | 目的が達成されない。`sync` は DOM の**書き込み**を担う位相であり、読み取りは禁じられていない | 手順3 |
| 手順4 で「`sync` だけが読む」の判定を、フレームの外から読む経路(ポインタ・右クリック・プロパティウィンドウ)を数えずに行う | 保持が要るフィールドを消し、右クリックメニューが空になる/古い値を出す | 手順4。`map-context-actions.ts` と `map-pickable-menu.ts` からの参照を全部たどる |
| 手順4 で `point-field-view` の `dirtyIndices` まで消しにかかる | 全インスタンスを毎フレーム GPU へ書き戻すことになり、点群を出したマップのフレーム時間が跳ねる | 手順4。負荷確認ウィンドウのフレーム時間 |
| 例外1・2 に当たるフィールドへ理由コメントを書かずに残す | 次に基準を当てる人が同じ判定をやり直す。基準を書いた意味が半分失われる | 手順4。表の「例外」行それぞれの宣言箇所 |
| `DisplayWindow` を `sync` へ渡す形を、`dt` を渡してよい根拠として読まれる | `sync` がシミュレーションを進める経路が開く | 手順1。書き足す文へ「逆に `dt`・時間送り倍率・入力を `sync` へ渡してはならない」を必ず含める |
