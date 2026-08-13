# 自機・カメラ・ステージの初期化順序の是正

**病巣は2つある。**

- **病巣 I — 操作対象艦の種付け**(症状 D / Step 5-6)。
- **病巣 II — 初期世界の作者が `Game` と `Stage` に割れている**(症状 F-L / Step 7-10)。

2つは `EntityManager.initialActivePlayer` で繋がっている。病巣 I の Step 5 と
病巣 II の Step 8 は、どちらもこの1つのフィールドを消すことに収束する。

---

## 診断 I — 「操作対象艦の種付け」

病巣: **操作対象艦の正本(`ActivePlayerController.current`)の初期値を、`EntityManager` が
決めて一方通行の口(`initialActivePlayer`)で配っている。** 「どの艦を操作するか」は
`EntityManager`(どのエンティティが存在するか)ではなく `ActivePlayerController` の責務であり、
正本を持つ側が自分で解決すればこの口ごと要らなくなる。

---

## 症状の確認(調査済みの事実)

### D. 種を配るためだけの口

`EntityManager.initialActivePlayer`(`entity-manager.ts:61,83-85`)の読み手は2箇所だけ
(`game.ts:127`、`stage.ts:170`)。`restoreFromSave` は
`players.find(p => p.id === save.activePlayerId) ?? players[0] ?? null` という
**「どの艦を操作するか」の判断**をしている — これは `EntityManager`(どのエンティティが存在するか)
ではなく `ActivePlayerController`(どれを操作するか)の責務。

---

## 是正案 I

`/refactor-fixed` 5-4「小さな段階にわけ、各段階で問題が生じていないことの確認を取りながら進める」
に従い、単独で確認できる粒度に割ってある(依存関係は末尾の「実施順と依存」)。

### Step 5 — `ActivePlayerController` が初期の操作艦を自分で決める

`initialPlayer` の読み手は `ActivePlayerController` のコンストラクタだけになっているので、
最後の種付け経路を畳む。

- `ActivePlayerController` のコンストラクタが `initialSave?.activePlayerId` を受け、
  `entities.players` から自分で解決する(`find(id) ?? players[0] ?? null`)。
- `EntityManager.initialActivePlayer` と、`restoreFromSave`/`spawnInitialPlayers` の
  戻り値によるその設定を削除。
- `Stage.begin()`(`stage.ts:170`)は `this._activePlayers.current` を読む
  (`StageDeps` に `activePlayers` は既に入っており、`Stage` は `ActivePlayerController` より
  後に構築される)。
- `game.ts:127` の `const initialPlayer` が**読み手ゼロになるので削除。**

### Step 6(任意・隣接)— `editor.onFocusNode` クロージャの解消

`game.ts:155-158` は、40行後に構築される `this.frameControls` へ**クロージャ経由の前方参照**で
届かせている。`/refactor-fixed` 7「渡すのはクロージャではなくオブジェクトの参照」の違反。
`FrameControls` の依存(`hud.layers`/`ephemeris`/`cameraSystem.overviewCamera`/`displayWindowManager`)は
`CameraSystem` の直後に全て揃っているので、**`FrameControls` を `PlanEditor` より前へ移し、
`PlanEditor` が `frameControls` を引数で受けて自分で `setFocus` を呼べばよい。**
自機・カメラの話ではないので別件にしてよいが、同じコンストラクタの同じ種類のぎこちなさ。

---

## 診断 II — 「初期世界の作者が `Game` と `Stage` に割れている」

新規開始時、世界の初期状態は**2つの主体が2パスで**組み立てている。

1. **`Game`/`EntityManager` パス**: `Game` が `stageClass.initialPlayerCount`(static)を読み、
   `EntityManager.spawnInitialPlayers` が `new Player(hud, sfx, scene, effects, markerManager)` を
   **init 引数なしで** N 隻構築する(`entity-manager.ts:95`)。名前 `'PLAYER'`・id `'PLAYER'`・
   状態 `Player.makeInitialState()` の地球 LEO が既定として入る。
2. **`Stage` パス**: 後から構築された `Stage` が `begin()` で
   `this._entities.initialActivePlayer` を**取りに行き**(`stage.ts:170`)、`init(player, entities)` へ
   渡し、さらに `player?.initAmmo(...)` で弾薬を**後から注入**する(`stage.ts:172`)。

**パス2はパス1が作ったものを上書きしている。** `/refactor-fixed` 13
「既定状態を組んでから上書きする形は、**「上書き前の状態」という誰も望んでいない中間状態**を
必ず1つ作り、その間に走る処理が何を見るかを非自明にする」がそのまま当てはまる。

### 症状 F — 初期弾薬の正本が2つある

`PlayerFire` のフィールド初期化子(`player-fire.ts:41-43`)が既に初期弾薬を決めている:

```ts
rounds = C.MAG_ROUNDS;
mags = C.INITIAL_MAGS - 1;
barrel = C.MAGS_PER_BARREL;
```

そして stage1/stage2/stage00 の `initialAmmo` は
`{ mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS }` ── **同じ値を書き直しているだけ。**
つまり艦は「既定弾薬を持って生まれ、直後に同じ値で上書きされる」。
本当に違うのは stage0(`{0,0}`)と debug 3種(`{20, MAG_ROUNDS}`)だけ。

`Player.initAmmo`/`PlayerFire.initAmmo` の呼び出し元は `stage.ts:172` **ただ1箇所**で、
`PlayerFire.initAmmo` が併せて戻す `barrel`/`cooldown`/`wasEmptyClick`/`wasFiring` は
新品の `PlayerFire` では既にその値なので、**リセット部分は二段初期化のためだけに存在している。**

### 症状 G — static と instance の非対称、そして誰にも読まれない宣言

`initialPlayerCount` は **static**(`stage.ts:94`、`Game` がインスタンス生成前に読む)、
`initialAmmo` は **abstract instance**(`stage.ts:121`)。どちらも「このステージが初期世界について
宣言すること」なのに置き場所が違う。

その帰結として **`CreativeStage` は `initialAmmo = {mags:0, rounds:0}` を書かされているが、
`initialPlayerCount = 0` なので `begin()` の `player?.` が必ず外れ、この値は永久に読まれない**
(`creative-stage.ts:35,41`)。**そのステージにとって意味を持たない値の宣言を義務付けられている**のは、
メンバーの置き場所が間違っているサイン。

### 症状 H — `initialPlayerCount` は実は 0/1 しか動かない

`spawnInitialPlayers` は `Player` へ name も id も渡さないので、2隻以上生成すると
**全隻が id `'PLAYER'` で衝突する**。「隻数」という一般化された宣言のように見えて、
実際には 0 か 1 しか成立しない。一方 `CreativeStage.placeObject` は
`playerIdAllocator` と `Player-N` の連番で正しく複数隻を置いている(`creative-stage.ts:201-205`)。
**正しく複数を置く方法は既にステージ側にある。**

### 症状 I — `init` が「配置しつつ副産物を返す」

`init(player, entities): number` は世界を書き換えながらブリーフィング用の敵数を返す。
`/refactor` の TypeScript 規則「**状態を更新し、副産物を返す関数を作らない**」に反する。
実害も出ていて、`stage1.ts:51` / `stage2.ts:58` は直上に並ぶ `addEnemy` 呼び出しちょうど5個に対して
**`return 5` とリテラルを書いている** ── 6機目を足したときに黙って食い違う。

**ただし機械的に `scoreCounter.totalEnemiesSpawned` へ差し替えることはできない**:
`stage00.ts:54-61` は `spawnWave` で実際に敵を出しながら `return 0` している(無限サバイバルなので
ブリーフィングに機数を出さない)。両者は別の値であって、片方でもう片方を代用できない。

### 症状 J — `StageInitData` は死んだ型

`stage.ts:84-88` が `{mags, rounds, briefingHtml}` を宣言しているが、使われるのは
`Pick<StageInitData, 'mags' | 'rounds'>` だけ。`briefingHtml` は同名の abstract メソッド
(`stage.ts:224`)と情報が重複しており、この型を丸ごと使う箇所は存在しない。

### 症状 K — `begin()` の呼び出し規約が型で守られない

「具象ステージは自分のコンストラクタの末尾で必ず `this.begin()` を呼ぶ」(`stage.ts:166-167`)は
コメントによる規約でしかない。`/refactor-fixed` 13「呼び忘れが型で守られない」。
なお同節は既定の形として **`Stage.setup`** を挙げているが、**そのメソッドは repo に存在しない**
(現在は `begin()`)。スキル文書側の記述が古いので同じ変更セットで直す。

### 症状 L — `Player` のコピーを持っているのは1箇所だけ(ユーザーの問いへの回答)

**結論: ステージ側は既に正しい。容認の議論は不要。**

`Stage` 本体・`Logistics`・`ScoreCounter`・`spawner/` は `Player` をフィールドで**一切持たない** ──
`init` / `update` / `sync` / `behaveAllEnemies` / `spawnForPlayer` / `updateLogistics` すべて
**引数**で受けている。`stage00.ts:286` の `generateWave` に至っては `Player` ですらなく
`KinematicState` だけを受け取る。

唯一の例外が **`StageStatusPanel.player`**(`stage-utils/stage-status-panel.ts:43`、
`sync` のたびに 134 行で再代入)。常設のラジエーター/ソーラーのトグルボタンが、
クリック時に「いまの艦」へ届くために保持している。

**そしてこれは既に古い参照を掴む形になっている**: `Stage.syncStatusPanel`(`stage.ts:202-209`)は
`!player` のとき `statusPanel.hide()` して early return するので、**`this.player` は更新されず
喪失した艦を指したまま残る。** 今はパネルが非表示なのでクリックが届かず顕在化しないが、
DOM の可視性に守られているだけの状態依存であり、`/refactor-fixed` 21bis の
「亡骸を配列に残したまま」と同族。

**「1隻しかいないステージなら差し替えが起きないからコピーは自然」は成り立たない。**
`ActivePlayerController.reclaimDead()` は**全ステージで無条件に**毎フレーム走り、
艦が死ねば `entities.players` から除かれて `current` は `null` になる
(`recordPlayerLost` が決着を出すかどうかとは**独立**)。つまり `ship → null` という差し替えは
どのステージでも必ず起きる。コピーが陳腐化するのは、ステージが最も注意すべきその瞬間。
**したがってコピーを容認する条件は存在せず、容認の形を設計する必要もない。**

---

## 是正案 II

### Step 7 — 初期弾薬を `Player` の構築引数にする

- `PlayerInit` の新規配置バリアントへ `ammo?: { mags: number; rounds: number }` を足し、
  `PlayerFire` のコンストラクタがそれを受ける(無指定なら現在のフィールド初期化子の値)。
- **`Player.initAmmo` / `PlayerFire.initAmmo` を削除**(呼び出し元は `stage.ts:172` の1箇所だけ)。
- これで艦は最初から正しい弾数で生まれ、「上書き前の中間状態」が消える。

### Step 8 — 初期世界の作者を `Stage` に一本化する(本丸)

`/refactor-fixed` 21「一般形は自機0..n隻・任意配置で、攻略ステージのほうがその特殊化」を
**構造として実現する**。現在の基底クラスは `init` が「何も置かない」と言いながら
`initialPlayerCount = 1` で「1隻いる」と言っており、**自分自身と矛盾している。**

- `EntityManager` のコンストラクタから `{playerCount}` バリアントを削除し、
  新規開始は**艦0隻で始める**。`EntityManagerInit` は `saved?: GameSaveData` へ縮む
  (判別共用体が presence/absence だけになるので、共用体を維持する理由が消える。
  `/refactor-fixed` 13 の「両方を別引数で受けて片方を無視しない」には抵触しない)。
- **`Stage` に `protected addPlayer(init?: PlayerInit): Player` を足す** ── 既存の
  `protected addEnemy(enemy, entities)`(`stage.ts:212`)と対になる形。中身は
  `new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, init)` →
  `this._entities.addPlayer(ship)` → `this._activePlayers.claimIfNone(ship)` で、
  **`CreativeStage.placeObject`(`creative-stage.ts:203-205`)が既に踏んでいる経路そのもの。**
- 各ステージの `init` が自分の艦を置く。stage0/00/1/2/debug/debug-load は
  `this.addPlayer({ ammo: ... })` の1行。**`StageDebugAltSystem` は最初から正しい状態で構築する**
  (`this.addPlayer({ state: ... })`)ので、`player.state` への上書き(`stage-debug-alt-system.ts:82`)が
  消える。`CreativeStage` は今どおり何も置かない。
- **`static initialPlayerCount` を削除**(症状 H のとおり 0/1 しか動かない宣言)。
- **`abstract initialAmmo` を削除**(各ステージが自分の `addPlayer` へ直接渡す)。
  `CreativeStage` の意味を持たない `{0,0}` 宣言が消える。
- **`EntityManager.initialActivePlayer` を削除**(病巣 I の Step 5 と同じ結論)。
  `Stage.begin()` は `initialActivePlayer` を取りに行かず、`init()` が自分で置いた艦を持つ。
  `init` の `player` 引数も不要になる ── **「艦を渡してもらって初期化する」から
  「自分で作る」へ主体が反転する。**

**⚠ 構築順の帰結: `ViewManager` を `new stageClass(...)` より後ろへ移す必要がある。**
Step 8 の後、新規開始時は `ActivePlayerController` 構築時点で艦が0隻なので、
`ViewManager` が初期ビューを解決する `canEnter('combat')` が常に false になり、攻略ステージまで
マップで始まってしまう。`ViewManager` の依存(hud / editor / cameraSystem / displayWindow /
mapPicker / activePlayers)に `Stage` は含まれないので、その構築を `new stageClass(...)` の直後へ
移すだけでよい(`viewManager.setTouchControls` の行も一緒に移す)。
**Step 8 では `ViewManager` の位置を必ず直すこと。**
これは偶然の依存ではなく、「どのビューで始めるかは世界が組み上がった後にしか決まらない」
という意味づけが構築順に現れた形。

### Step 9 — `init` の戻り値と `briefingHtml` の引数を畳む

- `briefingHtml(enemyCount: number)` → `briefingHtml()`。機数を出したいステージは
  `this.scoreCounter.totalEnemiesSpawned` を自分で読む(`addEnemy` が既に数えている)。
  stage1/stage2 の `return 5` マジックリテラルと、stage00 の「実際は出すが 0 を返す」食い違いが
  両方とも消える。
- `init` の戻り値を `void` にする(副作用のある関数は値を返さない)。
- **`StageInitData` を削除**し、`initialAmmo` が消えた後に残る用途が無いことを確認する。

### Step 10 — `StageStatusPanel` の艦参照を `Player | null` 一本にする

`sync(player, message, kills)` / `hide()` の2口を `sync(player: Player | null, ...)` に統合し、
`null` のとき自分で隠して `this.player = null` も書く。`Stage.syncStatusPanel` 側の
`if (!player || ...)` ガードが消える(`/refactor-fixed` 21bis
「受け手が『無ければ何もしない』を自決できるなら、呼び出し側にガードを書かせない」)。
`overviewMode` と `hudSubStatus() === null` の判定は呼び出し側に残る(受け手が知らない条件なので)。

---

## 採らない案 II

### ✗ Option B: `initialAmmo` を static にして `Game` が読み、`EntityManager` へ渡す

ユーザーの最初の案。`initialAmmo` の**注入**は消えるが、

- `initialPlayerCount` と `init()` による初期配置の**二重の作者は残る**
  (「どっちが主体か曖昧」の本体が解けない)。
- `CreativeStage` が意味を持たない `initialAmmo` を宣言し続ける
  (static になっても、艦を置かないステージが弾薬を宣言する不自然さは変わらない)。
- `StageDebugAltSystem` の `player.state` 上書き(二段初期化)が残る。
- 症状 H(id 衝突)も残る。

Step 8 なら「弾薬はステージが置く艦の積載であって、外から注入するものではない」という
一段上の答えになり、上の4つが同時に消える。**Option B は Step 8 の部分実施でしかない。**

### △ `recordPlayerLost` の既定を一般形(決着しない)側へ倒す

`/refactor-fixed` 21 は「基底の既定実装は一般形の側に寄せる。既定を攻略ステージ向けに置くと、
制限の無いステージのほうが override を持つことになり、どちらが一般形かコードから読めなくなる」
と言っており、**現状はまさにその反転**(基底が決着させ、`CreativeStage` が
`hud.hint` だけに override している ── `creative-stage.ts:347-350`)。

ただし実数は **7対1**(stage0/00/1/2/debug/debug-alt/debug-load が基底の挙動を使い、
`CreativeStage` だけが外す)。倒すと override が7個に増え、**規則が守ろうとしている
「どちらが一般形か読める」がかえって損なわれる。** 能力フラグ化
(`readonly endsOnPlayerLoss`)も、既定をどちらに置いても同じ数の宣言が要る。

**現状維持を推奨するが、規則との緊張は実在するのでユーザーの判断を仰ぐ。**
なお**この論点は Step 7-10 とは独立**で、コピー保持の可否にも影響しない(症状 L のとおり、
決着するかどうかに関わらず `reclaimDead` は走る)。

### ✗ `Stage` が `Player` をフィールドで保持する

症状 L のとおり、`ship → null` の差し替えは全ステージで起きるので陳腐化する。
現在の「毎フレーム引数で受ける」形が正しく、Step 8 でも**この形は変えない** ──
`init` が艦を**作る**のと、`update`/`sync` が艦を**引数で受ける**のは別の話。

## 実施順と依存

```
Step 5  ActivePlayerController が初期艦を解決   独立
Step 6  FrameControls を前倒し(任意)       独立
Step 7  初期弾薬を Player の構築引数へ       → Step 8
Step 8  初期世界の作者を Stage へ一本化      ← Step 5,7 / ViewManager の位置も動かす
Step 9  init の戻り値と briefingHtml を畳む   ← Step 8
Step 10 StageStatusPanel の艦参照           独立
```

各ステップ単独で `npm run typecheck` が通る。`src/physics/` は触らないので `test:physics` は不要。
実行時確認が要るのは Step 8(初期配置)・Step 10(ステータスパネル)。

## 効果(残りのステップ完了時)

- 消えるメソッド: `Player.initAmmo` / `PlayerFire.initAmmo`。
- 消えるフィールド: `EntityManager.initialActivePlayer` / `Game` の `initialPlayer` ローカル。
- 消える静的/抽象メンバー: `Stage.initialPlayerCount` / `Stage.initialAmmo`。
- 消える型: `StageInitData`。
- 消える引数: `Stage.init` の `player`、`briefingHtml` の `enemyCount`。
- 消える判断: `EntityManager` の「どの艦を操作するか」。
- 消える二段初期化: 艦の弾薬(既定 → 上書き)、`StageDebugAltSystem` の `player.state` 上書き。
- 消えるマジックリテラル: `stage1.ts:51` / `stage2.ts:58` の `return 5`。
- 直る潜在バグ: `StageStatusPanel` が喪失した艦を掴み続ける(症状 L)。
  `initialPlayerCount > 1` で id が衝突する(症状 H — 宣言ごと消える)。
- 責務の言い切りが変わる: **`Game` は世界の初期状態を組まない。組むのは `Stage`、
  復元するのは `EntityManager`。**

## 同じ変更セットで直す文書

`CLAUDE.md`(`entity-manager.ts` / `stages/` / `stage-dictionary.ts` の各節。
特に `initialPlayerCount` を静的宣言として説明している箇所)、
`DEVELOP/OWNERSHIP.md`(正本一覧)、`DEVELOP/CALLSTACK.md`、
`DEVELOP/SPEC.md`(初期配置・初期弾薬の記述)。

`/refactor-fixed` は書き換えない。ここで扱うのは2〜3モジュール間の責務の調整であって、
プロジェクト全体に及ぶ横断的な規則ではないので、記録先は上の設計文書で足りる。
ただし13節が例に挙げている **`Stage.setup` は実在しない**(現在は `begin()`、Step 8 後は
`init()` が自分で置く形)ので、その記述だけは実態へ直す。

## 範囲外(気付いたが今回は触らない)

- **`recordPlayerLost` の既定をどちら側に置くか**(「採らない案 II」参照)。現状維持を推奨、要判断。
- `Game.advanceSimulation`(`game.ts:250-269`)がアクティブ艦だけ `behave` の特別扱いをし、
  残りを `entities.updatePassivePlayers` へ回す形。1艦時代の名残に見えるが、per-frame の
  呼び出し順の話であって初期化順ではない。
- `mapPicker.setDocking`(`game.ts:193`)・`Game.setPerfMeter`・`ViewManager.setTouchControls` の
  遅延注入。`/refactor-fixed` 13 が「1メソッド1回」の注入として認めている形なので現状可。
- **行数**: `creative-stage.ts` 357 / `stage00.ts` 305 / `stage.ts` 285 行。
  200行基準を超えるが、分割は初期化順とは別の作業。
