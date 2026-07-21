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

深刻度順 **ではなく** 、低リスクなものから順に着手し、見通しをよくする

1. 入れ子型のctxのflatten、その結果生じた重複の削除 — 対象: `HitCtx`、`CheckLossCtx`
2. 重複、未使用フィールド、そもそも自分の責務下でアクセスできるもの（stageからみたtotalEnemyなど）の削除 — 対象: `CombatCtx`(`totalEnemies`)、`StageCtx`(`totalEnemies`/`magsLeft`/`roundsInMag`)、`SimulatorCtx`(未使用の`combatCtx`)、`StageWinCtx`(`scoreCounter`/`totalEnemies`)
3. 分解→再結合型の除去 — 対象: `PlanCtx`(`playerR`/`playerV`/`sunPhase0`/`moonPhase0`)、`HitCtx`(`enemies`/`bullets`)、`EnemyAiCtx`(`enemies`/`addBullet`)、`MapHudCtx`(`simTime`/`sunPhase0`/`moonPhase0`)
4. 軽微な（フィールド数3個程度）のctx型のファクトリ廃止、直接引数化 — 対象: `PlanCtx`、`EnemyAiCtx`、`MapHudCtx`、`CollisionPhysicsCtx`、`StageWinCtx`
5. 利用範囲の小さい（ctxを渡されているが実際そのうち3個程度のフィールドしか見ていないもの）関数の直接引数化（呼び出し元で大型ctxをバラしてから、あるいはそもそもctxを経由せずに渡す） — 対象: MarkerSystemなど　ここはctx単位の作業ではなく関数単位の作業となるため作業単位は要調査。
6. 転用、ファクトリの持ち回りの解消（高リスク、高い判断力を要する） — 対象: `CombatCtx`、`HitCtx`、`CheckLossCtx`、`StageCtx`(→`WaveManager`転用)、`SimulatorCtx`(`hitCtx`ファクトリ持ち回り)
7. フィールド化の検討（実施しない可能性が高い。要相談） — 対象: `CombatCtx`(`player`/`activeStage`/`fx`/`unlockManager`)、`StageCtx`(`simulator`/`scoreCounter`)、`TargeterCtx`、`FireCtx`

### 型別データベース(深刻度順)

型一覧と個別のパターン分析を統合し、型ごとに「情報」「深刻度」「問題」「対応策」をまとめる。
フィールド数は「現状 → 削減見込み」の形で示す(削減見込みは、ファクトリ関数が実際に読んでいる
`this.〜`の分解元を1行ずつ辿り、同じソースから複数フィールドが取り出されていないか確認した結果)。

#### 深刻

##### `CombatCtx`

- **情報**: `game/stages/stage.ts`定義。フィールド7→6個。生成: ファクトリ`game.ts#combatCtx(simTime)`。
  呼び出し: `Ship.attacked`(`Player`/`Enemy`)、`Stage.recordEnemyDeath`/`recordPlayerLost`。さらに
  `HitCtx.combatCtx`/`CheckLossCtx.combatCtx`として2つの別ctxへ入れ子。
- **深刻度**: 深刻。このドキュメントが名指しした「特にcombatCtxは顕著」の実例そのもの。
- **問題**:
  - 入れ子: `HitCtx`/`CheckLossCtx`にそのまま埋め込まれている。
  - 転用: `hit.ts`の`target.attacked(p, ctx.combatCtx)`のようにそのまま他関数へ横流ししている。
  - フィールド重複: `totalEnemies`(`activeStage.scoreCounter.totalEnemiesSpawned`)は同じctx内の
    `activeStage`と重複。`recordEnemyDeath`は`Stage`のメソッドとして呼ばれる(`ctx.activeStage.recordEnemyDeath(...)`)
    ため`this.scoreCounter.totalEnemiesSpawned`が直接使え、ctx越しに渡す必要がない。
- **対応策**: `totalEnemies`フィールドを削除(7→6、低リスクで即実施可)。入れ子(`HitCtx`/`CheckLossCtx`)の
  解消は該当エントリを参照。残る6フィールド(`simTime`/`player`/`activeStage`/`setPhase`/`fx`/`unlockManager`)は
  互いに独立したソースを持つため、これ以上の合成による削減はできない——先へ進めるには`player`/`activeStage`/
  `fx`/`unlockManager`(いずれも`readonly`でコンストラクタ以降再代入されない安定参照)を消費側クラスへ
  一度だけ注入する設計変更が必要で、これは「クラスのフィールド化」の判断(要相談)に該当する。

##### `HitCtx`

- **情報**: `game/orbit-entity/hit.ts`定義。フィールド5→4個(`combatCtx`込み)。生成: ファクトリ
  `game.ts#hitCtx(simTime)`(内部で`combatCtx(simTime)`を呼ぶ)。呼び出し: `HitSystem.checkBulletHits`/
  `checkBoardCrossings`の2メソッド。
- **深刻度**: 深刻。`combatCtx`をまるごと`attacked()`へ転用しており、`CombatCtx`クラスタの一部。
- **問題**: `combatCtx`の入れ子(`CombatCtx`参照)。`enemies`(`this.simulator.enemies`)と`bullets`
  (`this.simulator.bullets`)が**どちらも`this.simulator`から個別に取り出されている**(分解→再結合)。
- **対応策**: `enemies`/`bullets`を`simulator: Simulator`1個に統合(5→4)。`combatCtx`の入れ子は、
  `checkBulletHits`/`checkBoardCrossings`内で個別に読んでいる`combatCtx.player`/`combatCtx.simTime`を
  フラットな`player`/`simTime`フィールドとして`HitCtx`自身に持たせ、`attacked()`呼び出し時だけ別途
  `CombatCtx`を組み立てて渡す形に直す(doc「ばらして目的のctxに組み替える」)。

##### `CheckLossCtx`

- **情報**: `game/orbit-entity/entities.ts`定義。フィールド2個(`dt`, `combatCtx`)。生成: `game.ts`内で
  インライン構築(`{ dt, combatCtx: this.combatCtx() }`、専用ファクトリ関数はない)。呼び出し: 全
  `OrbitEntity`系`checkLoss`(`OrbitEntity`/`DebrisPiece`/`Bullet`/`Enemy`/`Player`の5クラス)、
  `Simulator.cleanup`。
- **深刻度**: 深刻。フィールド数自体は少ないが`combatCtx`をまるごと内包する入れ子であり、`CombatCtx`
  クラスタの一部。
- **問題**: `Bullet`/`DebrisPiece`の`checkLoss`は`combatCtx.simTime`しか使わないのに対し、`Enemy`/`Player`
  の`checkLoss`は`combatCtx.fx`/`combatCtx.activeStage`を使ってそのまま`recordEnemyDeath`/
  `recordPlayerLost`へ再転送している——実装ごとに必要なサブセットが異なるのに一律で全部入りの
  `CombatCtx`を運んでいる。
- **対応策**: 単純な「重複フィールド除去」だけでは解決しない(`CombatCtx`参照)。`recordEnemyDeath`/
  `recordPlayerLost`自体が`CombatCtx`をまるごと要求する設計を見直さない限り、`CheckLossCtx`の入れ子だけ
  解消しても呼び出し側で再度組み立てる手間が移動するだけなので、`CombatCtx`本体の解決(フィールド化含む)
  と合わせて検討する。

##### `StageCtx`

- **情報**: `game/stages/stage.ts`定義。フィールド8→5個。生成: ファクトリ`game.ts#stageCtx()`。呼び出し:
  `Stage.init/update`(全4ステージ)経由で`WaveManager`の全メソッド(`spawnWave`/`update`/
  `updateWaitingForAmmoPhase`/`updateSpawningEnemiesPhase`/`updateActiveCombatPhase`/
  `despawnOutOfRangeEnemies`/`countActiveWaveGroups`)へ転用。
- **深刻度**: 深刻。転用範囲が`Stage`の定義コメント(「Stage の init/update に渡す」)の想定を超えて
  `WaveManager`という別クラスまで及んでいる。
- **問題**:
  - 転用: `WaveManager`の各フェーズ関数が実際に使うフィールドは呼び出し毎に異なる
    (`updateWaitingForAmmoPhase`は`magsLeft`/`roundsInMag`だけ、`spawnWave`は`player`/`addEnemy`だけ等)——
    ctxが微妙に重複した責務分割不足のサイン。
  - フィールド重複: `magsLeft`/`roundsInMag`は同じctx内の`player`(`ctx.player.magsLeft`)と重複。
    `enemies`/`addEnemy`はどちらも`this.simulator`由来。`totalEnemies`は(`addEnemy`が呼ぶ)
    `activeStage.scoreCounter`由来で、`Stage`メソッド内では`this.scoreCounter`として直接アクセスできる
    ため不要。
- **対応策**: `magsLeft`/`roundsInMag`を即削除(`ctx.player.magsLeft`等で代替、低リスク)。`enemies`/
  `addEnemy`/`totalEnemies`を`simulator: Simulator`1個へ統合すれば`{phase, player, simulator, setPhase,
  simTime}`の5フィールドまで縮む。`WaveManager`への転用そのものは、`WaveManager`側が`StageCtx`を受け取らず
  必要な値(`player`/`simulator`/`magsLeft`/`roundsInMag`等)を個別引数で受け取るよう分解して解消する。
  `WaveManager`が`recordSpawnEnemy()`を呼ぶには`Stage00.setup()`経由での`scoreCounter`注入(要相談、
  フィールド化)が必要になる。

##### `SimulatorCtx`

- **情報**: `game/orbit-entity/simulator.ts`定義。フィールド3→2個。うち`hitCtx`は値ではなく`HitCtx`を
  生成するクロージャ。生成: ファクトリ`game.ts#simulatorCtx()`。呼び出し: `Simulator.integrateSimulation`。
- **深刻度**: 深刻。ctxがctxを生成するファクトリ自体をフィールドとして持ち回る、通常のctxファクトリ問題
  より一段階悪い変則パターン。
- **問題**: 「ctxのファクトリ関数をやめる」が二重に破られている(ファクトリを作った上でそのファクトリ
  自体をctxに埋め込んで転送)。さらに調査の結果、`combatCtx`フィールドは`simulator.ts`のどこからも
  呼ばれていない**未使用フィールド**と判明(`integrateSimulation`が実際に使うのは`ctx.player`と
  `ctx.hitCtx(nextSimTime)`のみ)。
- **対応策**: 未使用の`combatCtx`フィールドを即削除(3→2、ノーリスク)。残る`hitCtx`ファクトリは、
  `integrateSimulation`のシグネチャに`player`を直接引数として渡し、`hitCtx`の組み立てタイミング(いつ
  `hitCtx`を作るか)を`game.ts`側が完全に持てるよう設計を見直す(例: `nextSimTime`だけを`Simulator`から
  `game.ts`へ返す、あるいはヒット判定コールバックを分離する)。

##### `MarkerCtx`

- **情報**: `hud/markers.ts`定義。フィールド8個。生成: ファクトリ`game.ts#markerCtx()`——1フレーム中に
  4回(`syncHud`内3箇所+`render`内のPIPオーバーレイコールバック1箇所)ほぼ同一内容で呼ばれる。呼び出し:
  `MarkersSystem`のpublicメソッド3個経由でprivateメソッド8個以上に転用。
- **深刻度**: 深刻。転用はほぼ`MarkersSystem`内で完結している(クラス外への横流しではない)が、
  特にまとめようのないデータが一つのctxに押し込められていて場当たり的。
- **問題**: 大型のctxを生成し、それをprivate関数内で多数のメソッドに転用している。
- **対応策**: それぞれのprivateメソッドを見ると、利用されているフィールドは多くない。まず各プライベートメソッドを直接引数化し、updateMarkersないでctxをバラシて各メソッドに必要なフィールドだけを渡す形にする。その結果を見てから次の手（ctxをやめ、どのような形でupdateMarkersに渡すのが最適か、複数回ファクトリが呼ばれていることがどのような問題になっているか）を検討する。

#### 中程度

##### `PlanCtx`(重複型 `MapModeExternalState` 含む)

- **情報**: `game/plan/plan.ts`定義。フィールド5→3個。生成: ファクトリ`game.ts#planCtx()`。加えて
  `map-mode-system.ts`の`MapModeExternalState`が**完全に同一のフィールド構成**の別名型として重複定義。
  呼び出し: `Plan.refresh`/`maybeRefresh`、`PlanDisplay`(4メソッド)、`PlanGuide`(3関数)という3クラスに
  転用。
- **深刻度**: 中程度。転用は`plan/`ディレクトリ内(同一の意味的ドメイン)で完結しており、`game.ts`が
  外部へ`combatCtx`を横流しするケースほど深刻ではない。ただし複数クラスに同一ctxが行き渡っている点と、
  型そのものの重複は見過ごせない。
- **問題**: `playerR`/`playerV`は`this.player.state`から、`sunPhase0`/`moonPhase0`は`this.ephemeris`から
  それぞれ2フィールドずつ取り出されている(分解→再結合)。`MapModeExternalState`との型定義の重複。
  複数クラス(`Plan`/`PlanDisplay`/`PlanGuide`)への転用。
- **対応策**: `{ player: Player, ephemeris: EphemerisSystem, simTime: number }`の3フィールドに統合すれば
  直接引数化の閾値(4以下)に入り、`PlanCtx`という名前付き型・ファクトリ関数を丸ごと廃止できる
  (`Plan.maybeRefresh(player, ephemeris, simTime, duration)`等)。`MapModeExternalState`は削除して統合後の
  3引数に一本化する。`playerR`/`playerV`→`player`の統合で`Player`型への依存が`plan/`に増える点は要検討。

#### 軽微

##### `TargeterCtx`

- **情報**: `game/targeter.ts`定義。フィールド5個。生成: 呼び出し1箇所(`game.ts`内インラインリテラル)。
  呼び出し: `Targeter`内3メソッド(`updateCombatTargeting`/`handleTargetLockByRightClick`/
  `resolveAutoTarget`、同一クラス内)。
- **深刻度**: 軽微。ファクトリ関数を使わずインラインリテラルで組み立てられており、転用も同一クラス内に
  閉じている。
- **問題**: フィールド数5は「5個以上の大型ctx」の下限に該当するが、深刻な転用や入れ子はない。
- **対応策**: 現状で大きな問題はない。`player`/`enemies`/`activeCamera`はいずれも`Targeter`がフィールド
  として保持していない値なので、コンストラクタ注入 or フィールド化の余地はあるが、フィールド化の判断
  (要相談)に含める。

##### `FireCtx`

- **情報**: `game/player/player-fire.ts`定義。フィールド4個。生成: ファクトリ`game.ts#fireCtx()`。
  呼び出し: `PlayerFire`内7メソッド(`fireGun`/`spawnBullet`/`dropCasing`/`spawnMuzzleFlash`/
  `consumeRound`/`dropBarrel`/`spawnEjectedMagazineFrame`、同一クラス内)。
- **深刻度**: 軽微。同一クラス内での使い回しであり転用ではない。フィールド数4は直接引数化の閾値内。
- **問題**: `addBullet`は`this.simulator.addBullet`から取り出されたクロージャだが、他に`simulator`由来の
  フィールドがこのctx内に無いため単独では統合の意味がない。
- **対応策**: ファクトリ関数`game.ts#fireCtx()`を廃止し、呼び出し側(`updateFrame`/`handleEdgeInput`の
  2箇所)でオブジェクトリテラルを直接書く形にできる。`simTime`/`zoomActive`/`fx`は`PlayerFire`自身の
  フィールド化も検討候補(要相談)——ただし`simTime`/`zoomActive`は`Game`側の最新状態を毎フレーム反映する
  必要があり、フィールド化すると同期漏れのリスクがある。

##### `EnemyAiCtx`

- **情報**: `game/orbit-entity/enemy.ts`定義。フィールド4→3個。生成: ファクトリ
  `game.ts#enemyAiCtx(simTime)`——呼び出しは`handlePostSimulation`の1箇所のみ。呼び出し: `Enemy`内
  3メソッド(`behave`/`attackingCountInGroup`/`firePlasma`、同一クラス内)。
- **深刻度**: 軽微。同一クラス内での使い回し、転用なし。
- **問題**: `enemies`(`this.simulator.enemies`)と`addBullet`(`this.simulator.addBullet`を呼ぶクロージャ)
  が**どちらも`this.simulator`から個別に取り出されている**。ファクトリ関数の呼び出し箇所が1箇所しかない
  のに独立した関数として切り出されている。
- **対応策**: `enemies`/`addBullet`を`simulator: Simulator`1個に統合(4→3)。ファクトリ関数
  `game.ts#enemyAiCtx()`は呼び出しが1箇所のみなので廃止し、呼び出し側でオブジェクトリテラルを直接書く。

##### `MapHudCtx`

- **情報**: `game/map-mode/map-hud.ts`定義。フィールド4→3個。生成: 呼び出し1箇所(`map-mode-system.ts`内
  インラインリテラル、`PlanCtx`から値を積み替えて構築)。呼び出し: `MapHud.updateLabels`単体。
- **深刻度**: 軽微。単一呼び出し、転用なし。
- **問題**: `simTime`/`sunPhase0`/`moonPhase0`は`PlanCtx`(`ctx`)から個別に取り出されており、`PlanCtx`が
  `{player, ephemeris, simTime}`に統合されればここでも`ephemeris`をそのまま渡せる。なお構築コード自体は
  `PlanCtx`をいったんばらしてから`MapHudCtx`という別ctxに組み替えており、doc「ctxを転用する際は面倒でも
  一度ばらして目的のctxに組み替える」を既に実践している数少ない良い例。
- **対応策**: フィールド数4のため現状でも直接引数化の対象。`PlanCtx`統合後は`{ephemeris, simTime,
  duration}`の3フィールドとしてさらに整理できる。

##### `CollisionPhysicsCtx`

- **情報**: `game/orbit-entity/collision.ts`定義。フィールド2個(`player`, `entities`)。生成: ファクトリ
  `game.ts#collisionCtx()`。呼び出し: `CollisionPhysics.resolve`単体。
- **深刻度**: 軽微。「小さいctxは通常の引数として直接渡す」の典型対象。
- **問題**: フィールド数が少なすぎて型定義・ファクトリ関数を作るまでもない。`entities`は
  `this.simulator.allEntities()`由来。
- **対応策**: `resolve(dt, player, entities, onPlayerCasingImpact)`のように直接引数化し、
  `CollisionPhysicsCtx`型と`game.ts#collisionCtx()`ファクトリを廃止する。

##### `CameraUpdateCtx`

- **情報**: `game/camera/camera-system.ts`定義。フィールド7個。生成: 呼び出し1箇所(`game.ts`内インライン
  リテラル)。呼び出し: `CameraSystem.updateActiveCamera`単体(以降は`ChaseCamera.update`/
  `MapCamera.update`へ個別引数に分解して転送——転用していない)。
- **深刻度**: 軽微。フィールド数は多いが単一メソッド専用で転用がなく、実害は小さい。
- **問題**: フィールド数7は「5個以上の大型ctx」に該当するため列挙対象だが、`CameraSystem`自身がすでに
  持つ値(`mapMode`等)まで含めていない点はむしろ良い(doc冒頭の「mapModeとactiveCameraは両方
  cameraSystemのフィールド」という悪い例には該当しない)。
- **対応策**: 優先度は低い。`player`/`input`はそれぞれ`Game`側の安定参照だが、他のフィールド
  (`zoomActive`/`sunAz`/`focusRel`/`dt`/`origin`)は毎フレーム変わる値なので、大きな整理効果は見込みにくい。

##### `PipRenderCtx`

- **情報**: `game/pip-renderer.ts`定義。フィールド6個(うち`setMuzzleFlashesVisible`/`updateOverlay`の
  2つはコールバック)。生成: 呼び出し1箇所(`game.ts`内インラインリテラル)。呼び出し: `PipRenderer`内
  2メソッド(同一クラス内)。
- **深刻度**: 軽微。転用なし、クラス内で完結。
- **問題**: 特になし。コールバック2個は`EffectsSystem`/`MarkersSystem`への一段のインダイレクションだが、
  `PipRenderer`がそれらへ直接依存しない設計上の意図的な選択であり、悪いパターンではない。
- **対応策**: 対応不要(優先度最低)。

##### `StageWinCtx`

- **情報**: `game/stages/stage.ts`定義。フィールド3個(`scoreCounter`/`totalEnemies`/`simTime`)。生成:
  `Stage.recordEnemyDeath`内で組み立て。呼び出し: `Stage.checkWin`/`onWin`(同一クラス内)。
- **深刻度**: 軽微。`Stage`自身が生成し自身のメソッドへ渡すだけの内部的なやり取り。
- **問題**: `scoreCounter`は`this.scoreCounter`(`Stage`自身のフィールド)そのものであり、`checkWin`/
  `onWin`は`Stage`のメソッドとして呼ばれるため、実は`ctx.scoreCounter`を経由せず`this.scoreCounter`を
  直接読める。`totalEnemies`も(`CombatCtx`と同様に)`activeStage.scoreCounter.totalEnemiesSpawned`——
  `this.scoreCounter`から独立した値ではない。
- **対応策**: `checkWin(totalEnemies: number, simTime: number)`のように2引数まで減らせる(`scoreCounter`は
  `this`から読む)。`StageWinCtx`型・組み立てコードを削除できる。

##### `EnvironmentSyncParams`

- **情報**: `render/environment-scene.ts`定義。フィールド9個。生成: 呼び出し1箇所(`game.ts`の`sync`内
  インラインリテラル)。呼び出し: `EnvironmentScene.sync`単体、直後に`const {dt, origin, ...} = params`と
  即時分割代入。
- **深刻度**: 軽微。ドキュメント末尾の「例外的に許されるパターン」(即時分割代入・呼び出し側もオブジェクト
  リテラル)にほぼ合致するが、無名インラインオプション型ではなく`export interface`として名前付きで
  定義・エクスポートされている点だけが例外規定と異なる。
- **問題**: フィールド数9で「5個以上の大型ctx」に該当するが、転用や入れ子はない。
- **対応策**: 優先度は低い。`export interface`をやめて`sync`の引数にインラインの無名型として書き直せば、
  ドキュメントの「例外的に許されるパターン」に完全準拠する軽微な変更。

#### 良好(対応不要)

##### `EnvironmentLightingParams`

- **情報**: `render/environment-scene.ts`定義。フィールド4個。生成: コンストラクタ引数として受け取り、
  即座に`private readonly lighting: EnvironmentLightingParams`としてフィールド化。
- **深刻度**: 良好。ドキュメントが推奨する「クラスのフィールドとして実体を記憶する」パターンを既に
  実践している。
- **問題**: なし。
- **対応策**: 対応不要。他の型のフィールド化を検討する際の参考実装として位置づける。

### 共通して見つかった構造的な問題

`this.simulator.enemies`/`this.simulator.bullets`/`this.simulator.addEnemy`/`this.simulator.addBullet`が
**`StageCtx`・`HitCtx`・`EnemyAiCtx`・`FireCtx`・`CollisionPhysicsCtx`の5つのctxにまたがって個別のフィールド
としてバラバラに取り出されている**。`Simulator`インスタンス自体はGame構築時に1回だけ生成される安定参照で
あり、これらのctxが`simulator`というひとつの既存オブジェクトを指す形に揃えば、どのctxからエンティティ
配列を読むかという表記のばらつきも解消できる。`FireCtx`の`addBullet`と`CollisionPhysicsCtx`の`entities`
(`this.simulator.allEntities()`)も同じ`simulator`統合の対象になり得るが、どちらも元々1フィールドしか
`simulator`由来のものがなく(単独では「重複」にならない)、統合してもフィールド数は減らない点に注意——
それでも命名の一貫性という意味では価値がある。
