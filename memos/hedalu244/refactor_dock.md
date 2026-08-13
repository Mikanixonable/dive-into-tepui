# 基地・ドック(Base / Docking / DockView)リファクタリング調査

対象: `src/game/game-entity/base.ts` (122行) / `src/game/docking.ts` (169行) /
`src/game/hud/dock-view.ts` (**615行**) と、その周辺(`ViewManager` / `ActivePlayerController` /
`EntityManager.parkPlayer` / `Ship.parts` / `save-data.ts` の `BaseSaveData`)。

`dock-view.ts` は基準(モジュール200行)の3倍で、しかもその大半が UI ではなく取引処理である。
以下、①目指している仕様 ②現在の挙動 ③改善点 ④再配置案 の順にまとめる。

---

## 1. 目指している仕様

### 1-1. 確定している仕様(`DEVELOP/SPEC.md`)

`SPEC.md:616-619` がドックビューの正本。

- **格納艦**: 収容中の艦の一覧。発進・詳細表示。「新造」で既定パーツ一式の艦を 35,000 Cr で建造し
  格納艦へ加える。建造艦は収容艦と同じ扱いで、軌道上に現れるのは発進した瞬間。
- **部品**: 左に搭載部品、右に基地の倉庫。搭載部品は修理・同種在庫との換装、在庫は売却(購入価格の50%)。
  RCS タンクは搭載中・在庫を問わず補給(1 kg あたり 2 Cr)。倉庫は基地の持ち物なので格納艦が居なくても出る。
- **ショップ**: 部品を購入して倉庫へ入れる。調達が無償のステージでは修理・補給・購入すべて無料。

関連する確定仕様:

- `SPEC.md:82,85` — 外装(放熱板・太陽電池パドル)と全損した部品は**基地ドックでしか直せない**。
  自然回復(`Ship.selfRepair`)の対象外という規則がドックの存在理由を作っている。
- `SPEC.md:84` — 推力・トルク・燃料容量・放熱・発電・発射レート・初速・威力はすべて搭載部品の集計。
  **「部品の重量は現状まだ機体質量に反映していない」と仕様側が明記**している。
- `SPEC.md:611-615` — 基地は実軌道を持つ実体。左クリックで選択、右クリックで「ドックビューを開く」。
  収容で操縦できる艦が無くなったときだけマップビューへ自動的に移る。

### 1-2. 発端の要求(`memos/mikanixonable/dev.md:181-191`、人間記入)

> - 基地は、船と部品を保有することができ、船を発進することができ、またランデブーして位置が近く、
>   相対速度が近い場合に船を収容することができる。
> - 基地は複数設置することができ、選択するとアクティブ状態にすることができる。
> - ドックビューでは宇宙船の整備が行える。…ドックビューは基地に属する
> - 基地が保有する部品はゲーム内通貨を消費して購入することで増やすことができる。

**「ドックビューは基地に属する」** が明示されている。いまの実装は逆向き(下記 3-G)。

### 1-3. 仕様が先行していて実装が追いついていない点

| 事項 | 仕様側 | 実装 |
|---|---|---|
| 収容の操作 | `ゲームデザイン.md:376`「右クリックメニューから『ランデブー対象にする』を選び、…**『収容(Dock)』コマンドを実行すると**」。距離 100 m / 相対速度 1 m/s の例示 | プレイヤーの意思表示なしに、500 m / 20 m/s で**自動吸着**(`docking.ts:105`) |
| 通貨の入手 | `ゲームデザイン.md:388`「通常モードでは、**敵の撃破やミッション達成で通貨を獲得する**」 | 収入源が**部品の売却しかない**(`dock-view.ts:586`)。初期 100,000 Cr を減らすだけ |
| 部品重量 | `SPEC.md:84` が未反映であることを明記。`COMPARATIVE_GAP_ANALYSIS:82-83` が「`Ship.mass` をパーツ重量+残推進剤の getter に」と道筋まで提示 | `Part.weight` はカタログにもセーブにも載るが**どこからも読まれない** |
| 推進剤補給 | `SPEC.md:551` が「推進剤の補給システム」を**未実装**として列挙 | ドックで RCS タンクに補給できる(実装済み)。文書の側が古い |
| ドッキング操作 | `COMPARATIVE_GAP_ANALYSIS:100-103`「姿勢の一致、ドッキングポートの方向、接近軸(V-bar / R-bar)、接近速度プロファイルのいずれも判定に入らない」「500 m / 20 m/s は…かなり緩い。実際は 0.1 m/s のオーダー」 | 距離と相対速度の2条件のみ |

### 1-4. まだ決まっていない方向

- `DOCKVIEW_UX_PROPOSAL_2026-08-09.md` — ドックビューの UX 改善提案 A〜J が**未採否**のまま残っている。
  中核は **J(差分更新への移行)**で、「全ての更新が `innerHTML` の丸ごと書き換えなので、
  金額のカウントアップ演出も装着時のスロットハイライトも安全に実装できない」と、
  他の提案の前提として位置づけられている。**本リファクタリングと同じ場所を触る**ので、
  どちらを先に通すかを決めておく必要がある(下記 6-1)。
- `SPEC.md:581` — 「基地配置を月に限定するルールの、他天体への一般化」は**可能性の記録**であり未決定。
- `GAMEFEEL_REQUIREMENTS.md:349,591` — 大規模構造物が「敵か / 中立の地形か / 補給拠点か」が未決。
  基地に HP・防御・攻撃目標としての性格を持たせるかが、ここに依存する。

---

## 2. 現在の挙動(実装から読み取れる事実)

### 2-1. 状態の所在

```
EntityManager
  ├── players: Player[]        … 軌道上にいる自機
  └── bases:   Base[]
        └── baseState: { money, inventory: AnyPart[], dockedShips: DockedShipEntry[] }
                                          └── DockedShipEntry.player: Player  ← players に居ない Player
Docking
  └── _activeBase: Base | null … ドックビューの対象(OWNERSHIP.md:321)
```

**格納艦は `EntityManager` の外に居る `Player`** で、`DEVELOP/OWNERSHIP.md` の所有木にこのノードが無い。
`Ship.parts` の正本行も OWNERSHIP.md の状態表に無い(CLAUDE.md にしか書かれていない)。文書側の穴。

### 2-2. 収容・発進・建造・削除の経路

- **収容**: `Game.advanceSimulation` → `docking.checkProximity()`(`game.ts:292`、毎フレーム1回)。
  全 `bases` × 全 `players` の距離 < 500 m かつ相対速度 < 20 m/s で `dock()`。
  `dock()` は `dockedShips.push` → `obj.visible = false` → 各種参照の後始末 → `entities.parkPlayer(ship)`。
- **発進**: `DockView.handleLaunch`(`dock-view.ts:443`)が `onLaunchShip` を呼び、**その後で**
  `dockedShips.splice`。`Docking.launch`(`docking.ts:160`)が `ship.state` を基地の +X 方向 600 m に置き、
  `entities.addPlayer` → `activePlayers.set` → `viewManager.leaveDock()`。
- **建造**: `DockView.handleBuildShip` が **費用を徴収してから** `onBuildShip` を呼び、
  `Docking.buildShip`(`docking.ts:143`)が `new Player(...)` して `dockedShips.push`。
- **基地の削除**: `MapPicker`(`map-picker.ts:645-646`)が `docking.clearActiveBaseIf(base)` の後
  `base.alive = false`。除去は `EntityManager.prune` → `Base.dispose()`。
- **セーブ**: `Base.serialize()` が `dockedShips` を `entry.player.serialize()`(= `PlayerSaveData` 一式)
  として書き出し、復元時に `Base` のコンストラクタが `new Player(...)` で作り直す(`base.ts:86-101`)。
  データは往復するが、オブジェクト同一性は往復しない(意図どおり)。

### 2-3. ドックビュー内部

一度きりのモーダルで、`refresh()` が `#dock-body` の `innerHTML` を丸ごと書き換え、
`attachTabEvents()` が 12 種のボタンにリスナを張り直す。`sync` は持たない(ドック中は時間が止まる)。

8つの `handleX` はいずれも
**「`dataset` から index/id を引く → 買えるか判定 → `base.baseState.money` を増減 → 部品/配列を書き換える → `refresh()`」**
という同じ骨格を各自で書いている。

---

## 3. 改善点

### A. `DockedShipEntry` が `Player` の正本を複製している 【最優先】

`base.ts:24-31`:

```ts
export interface DockedShipEntry {
  readonly id: string;      // = player.id
  readonly name: string;    // = player.name
  hp: number;               // = player.hp   のコピー
  maxHp: number;            // = player.maxHp のコピー
  readonly parts: Part[];   // = player.parts と同一参照
  readonly player: Player;
}
```

6フィールド中5つが `player` から引ける。`hp`/`maxHp` だけは値のコピーなので、
`DockView.syncDockedSnapshot`(`dock-view.ts:514-518`)が修理・換装のたびに書き戻して整合を保っている。

CLAUDE.md「悪いデータ構造」の3項目に同時に当たる — 正データの分散、軽微な計算で求まるものをステートに
持つ、複数箇所が整合性を保つことを要求する。しかも**整合性保持の責務が UI 側へ漏れている**
(規約が「重大な違反」と呼んでいる形)。加えて `snapshot` の語は `/refactor-fixed` 6 で禁止されている。

**直し方**: `dockedShips: Player[]` にする。`syncDockedSnapshot` は消え、
`find((s) => s.id === shipId)` は `find((p) => p.id === shipId)` になるだけ。表示は `player.hp` を直接読む。

### B. 「格納中」を表す正本が3つある

① `entities.players` に居ないこと ② `dockedShips` に居ること ③ `obj.visible === false`。

③ は sync で維持されない一度きりの書き込みで、`docking.ts:121` / `docking.ts:147` / `base.ts:91` の
3箇所に散っている(`update`/`sync` 分離の例外)。① と ② は独立に壊れうる — 発進では
`DockView` が ② から外し `Docking` が ① へ入れるので、1つの遷移が2モジュールに割れている(下記 G)。

`/refactor-fixed` 21bis の「亡骸を配列に残したまま別の真偽値で『無い』と言わない」と同型。
正本は1つ(`dockedShips` に居るか)に決め、`obj.visible` は「`players` に居ない艦は描かない」という
`EntityManager`/`Player` 側の規則から導く(あるいは `parkPlayer` が scene から外す)。

### C. 「艦を世界から外す」処理が2実装あり、内容が食い違っている

| | `ActivePlayerController.remove`(`active-player-controller.ts:61-74`) | `Docking.dock`(`docking.ts:111-139`) |
|---|---|---|
| navTarget.clearIfTargeting | ✅ | ❌ |
| targeter.clearIfTargeting | ✅ | ❌ |
| mapPicker.close / clearFocusIf | ✅ | ✅ |
| sfx.setThrust/setRcs(false) | ❌ | ✅ |
| 配列からの除去 | `removePlayer`(dispose する) | `parkPlayer`(dispose しない) |
| 次の艦への引き継ぎ | `reclaimAfterLoss()` | `players.find(alive)` を直書き |

**結果として起きること**: 格納した艦が航法ターゲット・戦闘ターゲットのまま残る。逆に、削除された
操作艦の噴射音は止まらない可能性がある(ドック側だけが直してある)。

**直し方**: `ActivePlayerController` に `park(ship)` を足し、`remove`/`park` が共通の private な
後始末を通る形にする。`Docking.dock` は `activePlayers.park(ship)` を呼ぶだけになり、
「艦が居なくなったらマップへ」の判断も1箇所に揃う。

### D. `Docking` が `Game` を丸ごと参照している

`docking.ts:34` の `private readonly game: Game`。使っているのは
`pause`/`resume`/`isPaused`/`player`/`activePlayers`/`activeStage.freeProcurement` の6つだけ。
`Game` を丸ごと読んでよいのは表示専用の `HudPanels.sync` だけ、というのが `/refactor-fixed` 12 の例外規定で、
`Docking` は書き込む側なので当てはまらない。

`ActivePlayerController` と `Stage` はどちらも `Docking` より先に生成されているので、直接受け取れる。

### E. 一時停止の所有者がいない

`game.pause()/resume()` を **main.ts(設定メニュー)・docking.ts・save-browser.ts の3箇所**が独立に呼ぶ。
`Docking.leaveDock`(`docking.ts:93`)は `if (this.game.isPaused) this.game.resume();` なので、
**設定メニュー由来の停止まで解除しうる**。ドックの範囲を超える論点なので、直すなら別件(下記 6-4)。

### F. `Docking` と `ViewManager` の相互依存・同名メソッド

- `Docking.activate` → `viewManager.setView('dock')`、`ViewManager.setView` → `docking.enterDock()`。
  循環は `setDocking()` の後付け注入で解いており、`/refactor-fixed` 13(二段初期化を作らない)に触れている。
- **`Docking.leaveDock` と `ViewManager.leaveDock` が同名で別責務。**
  しかも `DockView.onClose` は `ViewManager` の方を呼ぶ(`docking.ts:46`)。読み手が追えない。
  `Docking` 側は ViewManager からのコールバック(`enterDock`/`leaveDock`)なので、
  そう読める名前にするか、`DockView` の所有を `ViewManager` 側へ寄せる。
- `ViewManager` には既に自身の TODO がある(`view-manager.ts:20-22`) — 戦闘⇔マップの切替とドックの開閉が
  1つの `ViewId` に同居しており、分けるには `ViewBadge` まで及ぶ、と。ここは既知の判断として尊重してよい。

### G. `DockView` が業務処理をすべて持っている(615行のうち大半)

- **無償ステージの規則が UI に5重に散っている**:
  `if (!this.freeProcurement && base.baseState.money < cost) return;` が5箇所、
  `if (!this.freeProcurement) base.baseState.money -= …;` が5箇所
  (`dock-view.ts:459,486,504,572,597` / `460,488,506,573,607`)。
- **その帰結として規則が破れている**: 売却(`dock-view.ts:586`)だけ `freeProcurement` のゲートが無い。
  無償ステージでは買値0で買って売ると所持金が増える(無限増殖)。
- **DOM が業務処理の入力になっている**: `handleSwapPart`(`dock-view.ts:532`)は
  `btn.parentElement?.querySelector('select')` から換装先を読んでモデルを書き換える。
- **1つの遷移が2モジュールに割れている**: `handleLaunch` が `onLaunchShip` を呼んだ**後**に
  `dockedShips.splice`(`dock-view.ts:449-450`)。`handleBuildShip` は**費用を徴収してから** `onBuildShip`。
- **参照の引き方が2系統**: 発進・詳細は配列 index(`dataset['shipIdx']`)、修理・換装・補給は id
  (`dataset['shipId']`)。同じクラスの中で addressing が分かれている。

`/refactor-fixed` 12 は「GUI は、その GUI が書き換える状態の所有者が持つ」と定めている。
いま所有者は `Base` なのに、操作はすべて View 側にある。

### H. 価格表が `dock-view.ts` の中にあり、既定パーツと二重管理になっている

`dock-view.ts:25-29` のコメントが自ら宣言している —
**「既定パーツ(`ship.ts` の `initDefaultParts`)と同じ単位・同じ桁で書く。桁がずれると、換装した瞬間に
推力や耐久が別物になる」**。実際 `DEFAULT_TORQUE`/`DEFAULT_THRUST` は `ship.ts:76-78` の式の写しである。

`/refactor-fixed` 14(焼き込みアセットと実行時が共有する値は `src/` に1つ置く)と同型の問題。
**既定パーツもカタログの1エントリから作れば、揃える必要そのものが消える。**
`NEW_SHIP_COST = 35000` も「カタログ最安構成の合計(≈31,500)に組立分を上乗せ」とコメントにあるのに手書き。

### I. 格納艦の生存期間を誰も管理していない

- `Base.dispose()`(`base.ts:104-108`)は `orbitLine` しか片付けない。マップから基地を削除すると
  **中の `Player` のメッシュがシーンに残ったままリークする**(`obj` はコンストラクタで `scene.add` 済み、
  `dispose()` は誰も呼ばない)。
- `parkPlayer`(`entity-manager.ts:165-172`)は `equatorNodes` だけ畳み、`marker`/`orbitLine`/`trajectoryLine`
  には触れない。sync が届かないので更新されないだけで、最後の状態が残っていないか要確認。

### J. 収容判定が離散的で、ワープのゲートも無い

`checkProximity` は**毎フレーム1回の点判定**(`docking.ts:98-108`)。substep には入っていない。
相対速度は 20 m/s まで許されるので、1フレームの相対変位は `20 × dt × warp`。60fps なら

- ×1024(simDt ≈ 17 s)→ 約 340 m … 掠める通過を見落としうる
- ×4096(simDt ≈ 68 s)→ 約 1,360 m > 直径 1,000 m … **中心を通る通過も見落としうる**

`attractor.ts` の `reachedBody` が掃引(`sweptHermiteSphereToi`)に直したのと同型の問題。
また、**剛体接触は ×4 超で解決を止めている**(`SimSpeedManager.canResolvePhysicalCollisions`)のに、
収容には同等のゲートが無い — 接触は諦める速度域で吸着だけは起きる。

加えて `[...this.entities.players]` の複製を毎フレーム作っている(`dock()` がループ中に配列を壊すため)。

### K. 発進位置の 600 m が直書きで、`DOCK_CAPTURE_DIST` と暗黙に結合している

`docking.ts:162`:

```ts
ship.state = kinematicState(base.state.t, v3(br.x + 600, br.y, br.z), base.state.v);
```

- **ECI の +X 方向へ 600 m** という、軌道に対して意味を持たない方向。基地の軌道面すら見ていない。
- 600 が `DOCK_CAPTURE_DIST = 500`(`const.ts:9`)を下回ると発進直後に再収容されるが、
  その関係はコードにもコメントにも書かれていない。
- 基地と同じ速度・違う位置なので相対運動で戻ってくる。**発進してしばらく放置すると自動で再収容される**
  可能性があり、要実測(`checkProximity` はドックビューを閉じた瞬間から再び働く)。

定数は `const.ts` へ出し、`DOCK_CAPTURE_DIST` から導く。方向は `orbitAxes` を使って軌道基準にする。

### L. `dock` の語が2つの意味で衝突している

`hud/dom.ts` の `.hud-dock` / `.hud-dock-left` / `.dock-toggle`(マップの左右パネル置き場)と、
`#dock-view` / `.dock-panel` / `.dock-mode`(基地ドック)。`dom.ts:550` の
`#hud.dock-mode .dock-toggle { display: none; }` は1行の中で両方の意味を使っている。

CLAUDE.md「曖昧な区別: 区別すべきものを同じ名前で指す命名」。HUD 側を `side`/`rail` などに改名する
(改名は痕跡を残さず全置換)。

### M. id 採番が場当たり

- `Docking.nextBuiltShipNo`(`docking.ts:29`)は `EntityIdAllocator` を使わない手書きの連番で、
  復元された建造艦の id(`base-0-built-1`)を吸収しない。
  **セーブを読み直してから建造すると id が衝突する。**
- `createPart` の id は `Math.random().toString(36).slice(2)`(`parts.ts:63`)。
- `Player` の id は既定で **name** そのもの(`player.ts:102`)。

`EntityIdAllocator` へ寄せる。建造艦は id を指定せず基底の採番に任せてよい。

### N. 経済に収入源が無い

`money` を増やすのは部品の売却だけ。設計時には「敵の撃破やミッション達成で通貨を獲得する」と
決まっていた(`ゲームデザイン.md:388`)が実装されていない。
なお `SnapshotService`(`snapshot-service.ts:34`)は**全基地の所持金を合計**してスナップショットのメタに
出している — つまり既に「プレイヤーの資産」として読まれている箇所がある(基地ごとの持ち物という
モデルと食い違っている)。

### O. 文書上、ドックが CREATIVE ステージの節に書かれている

`SPEC.md` のドック仕様(616-619)は §17 CREATIVE ステージの下にある。
ドックは `Base` があれば働く一般機能で、ステージが制限するのは `freeProcurement` の1点だけ。
`/refactor-fixed` 21 の「文書も同じ構造で書く。『〜モードでのみ』という書き方をしない」に触れる。
基地・ドックを独立した節へ移し、CREATIVE の節には「調達が無償」だけを残す。

---

## 4. 再配置の案

### 4-1. 骨子

**いまの分割線は「実体 / 横断処理 / UI」だが、実際に混ざっているのは「接舷(物理)」と「整備・調達(経済)」。**
この2つは変更の理由が別なので、分ける。

1. **`Base`** — 基地の状態と、その状態に対する操作の正本。
   - `BaseState` の入れ子をやめ、`money` / `inventory` / `dockedShips: Player[]` を `Base` 直下に置く。
     型に責務が無く、10箇所以上が `baseState.` を挟んで読んでいるだけなので、剥がす方向が正しい。
   - 操作: `receive(ship)` / `release(ship)` / `store(part)` / `takeOut(part)` / `pay(cost): boolean` / `earn(amount)`。
   - コンストラクタから `hud`/`sfx`/`fx` を落とす(格納艦の復元は `EntityManager.restoreFromSave` の仕事に寄せる。
     いまは `Base` が `Player` の作り方を知っている)。
2. **部品への操作は `Ship` 側** — `repairPart(part)` / `swapPart(index, incoming): Part` / `refuel(tank)`。
   いずれも艦の持ち物を変える操作で、基地は在庫と金を動かすだけ。両者を1回で行う手続きが「取引」。
3. **価格表 `game/part-catalog.ts`(仮)** — `SHOP_CATALOG` と価格関数
   (`sellPrice` / `refuelCost` / `repairCost` / `newShipCost`)。
   **`Ship.initDefaultParts` もここのエントリから作る** — H の二重管理が構造的に消える。
4. **取引層** — 「いくら取って何を動かすか」を1箇所に集め、`freeProcurement` をそこで1回だけ効かせる。
   置き場所は2案:
   - (a) `Docking` に入れる。基地でできることが全部1つになるが、毎フレームのランデブー判定と同居する。
   - (b) 新規モジュール(`Shipyard` など)を立て、`Docking` は接舷と世界への出入りだけにする。
   **推奨は (b)。** `Docking`(接舷=物理・毎フレーム)と整備・調達(=経済・イベント駆動)は
   変更の理由が別で、`Docking` は既に `checkProximity` という per-frame の責務を持っている。
5. **`DockView`** — 表示と「どの操作を呼ぶか」だけ。`freeProcurement` は表示上の価格が 0 かを決めるためだけに読む
   (実際に 0 にするのは 4 の層)。

### 4-2. 段階分け(各段で `npm run typecheck` を通す)

| Step | 内容 | 対応する改善点 |
|---|---|---|
| 1 | `DockedShipEntry` を廃し `dockedShips: Player[]` へ。`syncDockedSnapshot` が消える | A |
| 2 | `ActivePlayerController.park` を作り、`dock` の後始末を `remove` と共通化 | C |
| 3 | 価格表を切り出し、`initDefaultParts` もそこから引く | H |
| 4 | 取引層を立て、`DockView` から業務処理を全部移す。`handleLaunch` の splice も `Docking` 側へ | G |
| 5 | `Docking` の `Game` 参照を外す。`ViewManager` との命名衝突を直す | D, F |
| 6 | 生存期間(`Base.dispose` と park の後始末)、id 採番、発進位置の定数化、`BaseState` の平坦化 | I, K, M |
| 7 | HUD 側の `dock` 改名 | L |
| 8 | 収容判定の掃引化 / ワープゲート | J |

Step 1〜3 は挙動を変えない。Step 4 で「無償ステージでも売却で金が増える」が直り、
Step 8 は物理的正確さの改善なので挙動が変わる。**仕様変更を伴うもの(1-3 の表、および N)は Step に含めず、
下記 6 の判断を仰いでから。**

---

## 5. 採らない案

- **`BaseState` を `BaseStore` のような別クラスへ切り出して `Base` が持つ形。**
  状態を1階層隠すだけで操作の置き場所は変わらず、入れ子が1つ増える。むしろ `baseState.` を剥がす方向がよい。
- **格納艦を `entities.players` に残したまま「格納中」フラグで区別する。**
  `/refactor-fixed` 21bis の「亡骸を残さない」と同型の誤り。配列を回る全ての読み手が判定を1つ増やすことになる。
- **`dockedShips` に id だけ持たせて `EntityManager` から引く。**
  格納艦は `players` に居ないので引けない。持ち主は `Base` のままでよい。
- **`DockView` を per-frame `sync` にする。**
  一度きりのモーダルであり、ドック中は時間が止まる。CLAUDE.md でも差分更新の例外として認められている。
  ただし `DOCKVIEW_UX_PROPOSAL` の J は「差分更新にしないと演出が載らない」という**別の理由**で
  差分化を求めている — per-frame にする話ではないので、両立する。

---

## 6. 判断を仰ぎたいこと

1. **`DOCKVIEW_UX_PROPOSAL_2026-08-09.md`(A〜J)を採るか。採るならこのリファクタリングとの順序。**
   提案 J(差分更新化)は本調査の Step 4 と同じ場所を触る。**Step 4(業務処理の分離)を先に通してから
   J を載せる**のが手戻りが少ないと考える(表示だけになった `DockView` を差分化する方が易しい)。
2. **収容を操作にするか**(`ゲームデザイン.md:376` の「収容コマンド」に戻すか、
   `COMPARATIVE_GAP_ANALYSIS:100-103` の姿勢一致・ポート方向・接近軸まで踏み込むか)。
   ここが決まらないと J(掃引化)の作り方も決まらない — 自動吸着のままなら掃引が要るが、
   明示コマンドなら「コマンド実行時の1回判定」で足りる。
3. **通貨の収入源をどうするか。** 撃墜報酬/ミッション報酬を入れるか、通貨自体をやめるか。
   併せて、**所持金は基地ごとの持ち物か、プレイヤー共通の資産か**
   (`SnapshotService` は既に全基地の合計を「所持金」として表示している)。
4. **一時停止の所有者を決めるか**(改善点 E)。ドックの範囲を超えるので別件にしてよいか。
5. **`Part.weight` を機体質量へ接続するか**(`COMPARATIVE_GAP_ANALYSIS:82-83`)。
   接続するとカタログの `weight` が初めて意味を持ち、価格表の位置づけ(Step 3)も変わる。
6. **基地は今後「補給拠点」に留まるか**(`GAMEFEEL_REQUIREMENTS.md:349`)。
   攻撃目標にもするなら `Base` に HP・部位・防御が要り、`Ship` との共通化の議論が発生する。

---

## 7. 併せて直す文書

- `DEVELOP/OWNERSHIP.md` — 格納艦(`players` に居ない `Player`)が所有木に無い。`Ship.parts` の正本行も無い。
- `DEVELOP/SPEC.md` — ドック仕様を §17 CREATIVE から独立した節へ(改善点 O)。
  §14 の「推進剤の補給システム(未実装)」は実装済みなので消す。
- `CLAUDE.md` — `Docking`/`DockView`/`Base` の記述を、責務の移動に合わせて書き直す。
