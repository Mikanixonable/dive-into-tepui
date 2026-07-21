# ctx注入パターンを書くのをやめろ

現在コードのいたるところで利用されているcontext注入パターンは、時間をかけて滅ぼすべきものである。必要な情報すべてを丸投げするというのは、必要な情報が少なくなるように責務を分割しなければならないことを隠蔽してしまう。徹底して排除するべき。

## なぜ排除しなければならないか

データ型は適切に構造化されているのが望ましい。適切な構造化とは、意味や責務と一致した構造である。場当たり的にまとめられたctxは、意味を不明瞭にするだけでなく、密結合が隠される原因になる。特に、ctxをそのまま他のモジュールに受け渡したりして転用しているのは論外。本質的には「引数として渡すためだけに作られた型」が問題なので、名前がCtxでない、context、Params、Argsなどの名前であっても同様です。


## どのようなパターンを避けるべきか

### 無駄な分解と結合をやめる。

ファクトリ関数をの中で、すでにまとまっているデータを分解し、ctxにflattenしてしまっている例がある。

例えばplanCtxについては、player、ephemerisSystem、simTimeの3つにまとめることが可能で、3つにまとめれば通常引数に展開できる。

これはGame.tsのファクトリ関数を見ると
```ts
  private planCtx(): PlanCtx {
    return {
      simTime: this.simTime,
      playerR: this.player.state.r,
      playerV: this.player.state.v,
      sunPhase0: this.ephemeris.sunPhase0,
      moonPhase0: this.ephemeris.moonPhase0,
    };
  }
```
のように、「わざわざ分解してからまとめなおす」という操作をしている。ファクトリ関数、つまり情報の供給源を観察することで、どのように整理できるか分析できるかもしれません。

特に、game.tsにおいてはちまちまと分解すべきでない。多少情報として過剰でも、分解していないオブジェクトをctxとして渡したほうがいいことがある。一つのオブジェクトから二つ以上のフィールドが同一のctxに渡される場合は、分解せずに渡した。

ただし、「情報がまとまっている」といっても、ctxの中に別のctxが含まれているパターンは話が別。そのようなパターンはこれから減らしていく予定であり、これ以上増やすべきではない。まとめて良いのはあくまでもctx以外の、既存のクラスやデータ型としてまとまったものがある場合で、ctx構造を入れ子にするべきではない。

### 特定のクラスと深く結びついたCtxの情報は、そのクラスのフィールドとすべき情報が含まれている可能性がある。

毎回引数として受け取るのではなく、クラスのフィールドとして実態を記憶してしまえば、クラスの状態が整っていればctxを受け渡す必要はない。
当然、ctx全体をクラスのフィールドに持たせるべきではなく、その中でも特にどれが必要な情報なのかを抽出して渡すべきである。
また、一つの情報が複数のクラスに重複して保存されるべきではない（共有参照を持たせている_hud、_sfx、_sceneだけは例外。このパターンを乱用すべきじゃない）ので、どのクラスが最もその情報と関連し、最もその情報を持つべきなのか検討する。
これはいきなり実装せずゆっくり判断させてほしい

### ctxの入れ子を解消する

「まとめられる情報はまとめる」の例と逆で、ctxの中に他のctxが含まれている場合は、まとめて渡すべきではない。
ctxは意味上のまとまりのない、即席のグループであるから、まとまっていても何も良いことがない。
他のモジュールにctxを受け渡す必要があるとき（ctxの変換が必要なとき）は、面倒でも一度ばらして、目的のctxに組み替えること。

ctxの型構造を検証し、重複と思われる個所がないか調べる。

### ctx内にフィールドの重複がある場合は、どちらか片方だけを渡す。

ctxでplayerとplayervelを渡しているとしたら、握っている情報としてはplayerが完全上位互換なので、playerVelをctxに含める必要はない。
ctxに他のctxが含まれているパターンはデータの重複が特に疑わしい。そんなデータ構造を作るべきじゃない。そのようなケースでは、

### ctxのファクトリ関数をやめる

ctxは意味上のまとまりのないオブジェクトであるから、ctxを作るためのファクトリ関数を作るのは無駄である。面倒でもそれぞれの箇所でオブジェクトリテラルを書く方が、疎結合化に繋がる。

### ctxの転用をやめる

特にcombatCtxは顕著で、渡されたcontextをそのまま他の関数の引数に渡している箇所が多い。ctxは意味上のまとまりのないオブジェクトであるから、そのまま他の関数に渡すと、必要な情報が何なのかが分からなくなる。複数の関数で同じctxを受け取ってはいけない。それぞれにおいて、必要な情報だけを抽出した別個のctxを作る、あるいは必要な情報を個別に渡す。

### 必要以上のctxを注入してしまっていないかを確認する。

そもそも、幅広いctxが必要になる時点で、責務分離が不十分である可能性が高い。現在挙がっているメソッドを確認し、ctxのなかで必要としているフィールドが異なるメソッド群が一つのモジュールに混在していないかを確認する。

要素が5個以上の大型ctxがどこにあるか列挙する。
ctxが微妙に重複し、微妙に異なるフィールドを持つ場合、そもそも責務の方が密結合になっていて、過剰にフィールドを要求しないようなより最適な分割が可能なのではないか。

### 小さいctxは通常の引数として直接渡す

引数が1～4個程度であれば、ctxを作らずに通常の引数として直接渡す方が良い。ctxを作ると、ctx型の定義、ctxファクトリ関数など、無駄なものが増える。ctxファクトリ関数が使いまわされているのはもっと良くない。
関数定義と同時に定義されたparamsとオブジェクトリテラルならまだ良い。

### 例外的に許されるパターン

唯一許せるのは、型定義やファクトリを作らずをせず、引数にインラインで定義されたオプション型。
これは各引数がどのような意味を持つのかを順番ではなく名前で受け渡しするためのものであるから。例えば以下のようなパターン

```ts
function foo({
    a:boolean,　// 無名の型注釈で引数を指定
    b: number,
    c?: string
}: {x: number, y: string, z: boolean}) {
    const {a, b, c} = params; // 即時分割代入

    // ここでa, b, cを使ってx,y,zを算出。paramsそのものは絶対に使わない
    
    return {x, y, z};
}

 // 利用側でもオブジェクトリテラルを使い、その場でオブジェクトを組み立てる。ファクトリ関数は使わない
const result = foo({a: true, b: 1, c: "hello"});
// 利用側もできるだけ早く分割代入（こっちはそこまで必須じゃない。「同じ関数から返されたもの」には意味上のまとまりがあることがあるから）
const {x, y, z} = result; 
```

これはparamsを即時分割代入していて、それ以降使っていないことがポイントで、もし他の使い方をしていたらそれはctxと同じ場当たり的なデータの塊になってしまうので良くない。

## 実施計画

現在残っているctx関連型一覧について、それぞれ「フィールド」「利用パターン」「問題」「対応策」をまとめる。
フィールド数は「現状 → 削減見込み」の形で示す(削減見込みは、ファクトリ関数が実際に読んでいる
`this.〜`の分解元を1行ずつ辿り、同じソースから複数フィールドが取り出されていないか確認した結果)。

数が少なくなってきている反面、厄介なのが残っているはず。転用、ファクトリの持ち回りの解消、クラスフィールド化の検討などの、高リスク、高い判断力が必要な対応を取る必要がある。どのような利用パターンがあるのか、その利用パターンにどのような存在意義があるのか、あるいはまったくの無駄なのか、どのように問題があるのかを注意深く観察してから、どうすれば解消できそうか検討する。

### Ctx型ごとの評価(深刻度順)

`combatCtx`/`fireCtx`/`enemyAiCtx`/`collisionCtx`/`planCtx`(冒頭の例で挙げた型そのもの)は現在のコードにはもう存在しない。特に `planCtx` は `getExternalState: () => ({ player, ephemeris, simTime })` という無名型のコールバックに置き換えられており、下記「概ね許容できる例」で扱う。残っているのは以下の7つの named `*Ctx` interface と、命名こそ `Params` だが同種の型1つ。

#### 1. `MarkerCtx`(`src/hud/markers.ts`)— 最も深刻

- **フィールド**: 8 → 6(`activeCamera` を削除、`enemies`+`ammos` を `simulator` 1個にまとめられる)
- **利用パターン**: `game.ts` の `markerCtx()` ファクトリが毎フレーム生成。`updateMarkers` 冒頭で `mapMode/player/enemies/target/ammos/mapLabelIds` は即座に分割代入され、各 private メソッドへ個別に渡される(模範的)。ただし `updateLeadAndDirMarkers(ctx, o, pv, project)` だけは ctx をまるごと転用している。
- **問題**:
  - `activeCamera` フィールドが**完全にデッドコード**。コメントには「PIP オーバーレイ専用の投影に使う」とあるが、実際の `updatePipOverlay` は `ctx` を受け取らず `activeCamera` を独立した引数として個別に受け取っている(`game.ts:486`)。`markers.ts` 内で `ctx.activeCamera` を読んでいる箇所は存在しない。存在しない用途のためにフィールドが残っている典型例。
  - `this.simulator.enemies` と `this.simulator.ammos` が同じ `this.simulator` から2フィールド取り出されており、13行目のルール(同一ソースから複数フィールドを取るなら分解しない)に反する。
  - 8個中1メソッドだけ ctx をまるごと受け取る(`updateLeadAndDirMarkers`)のは、他の private メソッドが徹底して分解引数を使っているのと一貫しない。
- **対応策**: `activeCamera` を削除する。`enemies`/`ammos` は `simulator: Simulator` を渡す形にまとめるか(hud/ が game/orbit-entity/ の型に依存することになるので判断が要る)、現状維持のまま `simulator` を渡さない方針を明文化するかを検討する。`updateLeadAndDirMarkers` も他と同様に分解引数へ揃える。

#### 2. `SimulatorCtx`(`src/game/orbit-entity/simulator.ts`)— ctxを返すctxという入れ子

- **フィールド**: 2 → 2(重複ソースはない。問題はフィールド数ではなく構造)
- **利用パターン**: `game.ts` の `simulatorCtx()` が `{ player, hitCtx: (simTime) => this.hitCtx(simTime) }` を生成し、`Simulator.integrateSimulation` に渡す。内部で `ctx.hitCtx(nextSimTime)` を呼んで `HitCtx` を都度組み立てる。
- **問題**: `hitCtx` フィールドは「別の ctx を組み立てるファクトリ関数」そのものであり、43行目の「ctxの入れ子を解消する」に反する変則パターン(直接ネストではなく、クロージャ越しのネスト)。しかも `ctx.hitCtx(nextSimTime)` が返す `HitCtx.simulator` は、呼び出し元である `Simulator` 自身への参照 — `Simulator` が `game.ts` を経由して自分自身を受け取る循環構造になっている。`this` で足りるはずの情報を、わざわざ `Game` を往復させて受け取っている。
- **対応策**: `HitCtx` から `simulator` フィールドを削除し(下記参照)、`HitSystem.checkBulletHits`/`checkBoardCrossings` は `Simulator` 側から `this` を直接渡すようにする。そうすれば `SimulatorCtx` はもはや ctx 生成クロージャを持つ必要がなくなり、`hitCtx` を除いた身軽なスナップショット(あるいは通常引数)に置き換えられる。

#### 3. `HitCtx`(`src/game/orbit-entity/hit.ts`)

- **フィールド**: 6 → 5(`simulator` を削除できる。理由は上記 `SimulatorCtx` 参照)
- **利用パターン**: `checkBulletHits(ctx)` は ctx をまるごと使う。直後に呼ばれる `checkBoardCrossings` へは `hitCtx.target, hitCtx.player, hitCtx.simulator, hitCtx.boardMarks` と個別に再分解して渡している(`simulator.ts:109-111`)。1つの `HitCtx` オブジェクトが、2つの異なるメソッド(必要とするフィールド集合が異なる)に流用されている。
- **問題**: `simulator` フィールドは常に呼び出し元(`Simulator.integrateSimulation`)自身と同一インスタンスであり、`ctx.simulator.enemies`/`ctx.simulator.bullets` として使われている箇所は `this.enemies`/`this.bullets` で置き換え可能。「毎回引数として受け取るのではなく、既に持っている情報を経由させている」という36節の逆パターン。
- **対応策**: `simulator` を削除し、`checkBulletHits`/`checkBoardCrossings` は `Simulator` から `this` を明示的な引数として渡す(あるいは `HitSystem` のメソッドを `Simulator` のメソッドとして持たせることも検討)。2つのメソッドが要求するフィールド集合が違う以上、ctx を共有せず、それぞれに必要な引数だけを渡す形が素直。

#### 4. `TargeterCtx`(`src/game/targeter.ts`)

- **フィールド**: 5 → 5(ソース重複はなし。`game.ts` 側はファクトリ関数を作らずインライン object literal で構築しており、この点は模範的)
- **利用パターン**: `updateCombatTargeting(ctx)` → `handleTargetLockByRightClick(ctx)` には ctx をまるごと渡す一方、`resolveAutoTarget(ctx.enemies, ctx.player, ctx.activeCamera)` へは個別分解して渡す。同一クラス内で使い方が割れている。
- **問題**: 深刻ではないが、62節の「複数の関数で同じctxを受け取ってはいけない」に軽く抵触する。`handleTargetLockByRightClick` が今後肥大化すると、どのフィールドが実際に必要なのか ctx を読まないと分からなくなる。
- **対応策**: `handleTargetLockByRightClick` も `resolveAutoTarget` と同様に個別引数へ分解する(`input`, `player`, `enemies`, `project` の4つ)。

#### 5. `CameraUpdateCtx`(`src/game/camera/camera-system.ts`)

- **フィールド**: 6 → 6(重複ソースなし。`game.ts` の `syncCamera` がインラインで構築、ファクトリ関数なし)
- **利用パターン**: `updateActiveCamera(ctx)` 1メソッドのみで使用し、`mapMode` 分岐の中で `mapCamera.update(...)`/`chaseCamera.update(...)` へそれぞれ必要な部分集合だけを個別引数として渡す。ctx をそのまま他へ転用してはいない。
- **問題**: フィールド数がやや多いが、1メソッド内で完結し即座に分解されているため実害は小さい。強いて言えば `mapCamera` 用フィールド(`focusRel`, `sunAz`)と `chaseCamera` 用フィールド(`origin`, `player`)がほぼ排他的であり、ctx全体を1つの塊として扱う意義は薄い。
- **対応策**: 優先度は低い。手を入れるなら `updateActiveCamera` を通常の6引数関数にしても実害はない(呼び出し側は1箇所のみ)。

#### 6. `StageCtx`(`src/game/stages/stage.ts`)

- **フィールド**: 5 → 5(重複ソースなし)
- **利用パターン**: 唯一の named ctx で `private stageCtx()` という専用ファクトリ関数を持つ(呼び出し箇所は `activeStage.update(dt, this.stageCtx())` の1箇所のみ)。`abstract update(dt, ctx: StageCtx)` という多態メソッドの契約として存在し、各ステージ(`stage0`/`stage1`/`stage2`は `simTime`/`player` の2フィールドだけ、`stage00` は5フィールド全部)が必要なフィールドだけを取り出して他メソッドへ委譲している。
- **問題**: 「hud/sfx/sceneは含めない」という設計意図がコメントで明記されており、既にこの文書の方針を意識して整理された型。強いて言えば呼び出し箇所が1つしかないファクトリ関数(`stageCtx()`)は56節の「ctxのファクトリ関数をやめる」に技術的には抵触するが、実害はほぼない。
- **対応策**: 優先度は最も低い。多態メソッドのパラメータオブジェクトとしては妥当な設計であり、これ以上手を入れる必要はない。

#### 7. `PipRenderCtx`(`src/game/pip-renderer.ts`)

- **フィールド**: 6 → 4(`firing`+`playerShipObj` は `this.player` から、`mapMode`+`camera` は `this.cameraSystem` からそれぞれ2フィールドずつ取り出されている)
- **利用パターン**: `game.ts` の `render()` がインラインで構築(ファクトリ関数なし)。`renderFrame(ctx)` から private `renderCombatWithPip(ctx)` へ ctx をまるごと転送しているが、これは同一クラス内の1メソッド分割にすぎない。
- **問題**: 機械的には `player`/`cameraSystem` を渡せばフィールド数を減らせるが、`pip-renderer.ts` は意図的に `Player`/`CameraSystem` 型を import していない(レンダーパス専用モジュールとして game ロジック型から切り離す設計 — `hud/markers.ts` の「game.tsをimportしない」と同種の境界)。フィールド分解はレイヤー境界を守るためであり、単純な重複ではない。
- **対応策**: 現状維持でよい。件数を削るなら、この文書の13節「同一ソースから複数フィールドをまとめる」ルールに **層境界をまたぐ場合は例外とする** という注記を追加しておくと今後の判断がぶれない。

#### 番外: `EnvironmentSyncParams`(`src/render/environment-scene.ts`)

named `Ctx` ではなく `Params` だが、STOP_USING_CTXの定義(7節)上は同じ扱い。9フィールドと最大級だが、`sync(params)` の冒頭で即座に全フィールドを分割代入し、以降は `params` を経由せず `syncEarth`/`syncSkyBodies`/`syncLighting` へ個別の位置引数として払い出している。`game.ts` 側もインラインの object literal で、`ephemeris.sunPhase0`/`moonPhase0` や `cameraSystem.mapMode`/`mapCameraFar` のように同一ソースから複数フィールドを取ってはいるが、これは `render/` が `game/` のクラス型(`EphemerisSystem`/`CameraSystem`)に依存しないためのレイヤー境界越えの分解であり、`PipRenderCtx` と同じ理由で妥当。**深刻度は低い。現状維持でよい。**

#### 概ね許容できる例(参考)

- `Player.behave(params: {...9 fields...})`(`src/game/player/player.ts`)— 76節の「例外的に許されるパターン」そのもの。匿名の引数内型注釈 + 即時分割代入 + 呼び出し側もインライン object literal。named 型もファクトリ関数も存在しない。
- `MapModeSystem` に注入される `getExternalState: () => { player, ephemeris, simTime }`(`src/game/game.ts`/`src/game/map-mode/map-mode-system.ts`)— 冒頭の `PlanCtx` 例はこの形に解消済み。ただし `map-mode-system.ts:240` の `this.display.update(this.plan, state, ...)` は一度 `state` を変数に取ってからまるごと転送しており、受け手(`PlanDisplay.update`)側で即時分割代入されているとはいえ、事実上の無名ctxが暗黙に生き続けている点は軽く注意しておく価値がある。