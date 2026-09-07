# ドッキング機能一式の破棄

行番号はすべて `a701460d`(`origin/main` = `84517bbf` を取り込んだマージ commit)時点のもの。

**「決めたこと」の 1〜6 は 2026-09-07 にユーザーが承認済み。** 実施中に問い返さない。

## 目的

ドッキングは**未完成のまま main へ入った失敗作**で、作者(mikanixonable)が作り直す前提で
破棄を決めた。いまの形のまま部分的に残すと、作り直しの土台にならないどころか妨げになる。

**なぜ「部分的に直す」ではなく「破棄」なのか。** 作り直しの完成形は
「戦闘ビュー・マップビューと並列な第三のビュー(基地ビュー)」であり、
現状はそれと構造が合っていない。

- 基地固有の UI(`BasePanel`)を `Docking` が握っている。ビューではなくプロパティウィンドウの
  中身として実装されているため、ビューとして作り直すときに移せる部分がない。
- 接続点ガイドが `CombatView` のコンストラクタ引数として戦闘ビューへ直結している。
- 「アクティブな基地」がどこにあるかが3モジュールに分かれ(`refactor_modules.md` 論点22)、
  畳む経路が片側しか通らない。**この論点は本計画で構造ごと消える。**
- `ObjectWindows.setDocking()` は二段初期化(規約 1.12)、`Docking` の `setView` は
  クロージャ注入(規約 1.12)。どちらも生成順の都合だけで生まれている。

前日のリファクタリングでビューごとのモジュール整理が済んでいるので、ゼロから第三のビューを
足すほうが、未完成品から想像で継ぎ足すより確実に安く済む。

## 決めたこと

**すべてユーザーが覆せる。** 覆したときにどの手順が変わるかを併記する。

### 1. 残すもの

| 残すもの | 根拠 |
| --- | --- |
| `Base`(`DynamicEntity` / `Controllable` / `ObjectPickable` としての基地) | ドッキングと独立している。生成は creative の物体配置とセーブ復元の2箇所だけ |
| 基地の操作(推力・姿勢・スロットル・RCS)と `Controllable` インタフェース | 「操作可能という点で自機と共通の構造」は**すでに main にある** — `Controllable` が正本 |
| `buildBaseModel()` の中の `buildDockingBay()`(`render/base-station-model.ts:190`) | 造形の話であって機能ではない。基地の見た目からハッチとベイを消す理由がない |
| `baseState.money` | → 下の 3 |
| `validateBaseReferenceFields`(基地の基準天体制約) | 配置側の制約でドッキングと無関係 |

### 2. 「ドッキング後の結合の局所シミュレーション」は残さない

**残す価値のあるものが実在しない。** `Docking.updateDockedPhysics()`(`docking.ts:233-243`)は
毎フレーム `ship.state.v` へ相手の `v` を代入しているだけで、位置の拘束も相対姿勢の拘束も、
接触力の解決も持たない。艦と相手は同じ速度で別々に積分され、加速度が違えばそのまま離れていく。
拘束を解く実装は存在しないので、残しても再実装の足がかりにならない。

**覆されたら**: 手順2で `dockedPairs` / `updateDockedPhysics` / `getDockedTarget` /
`undock` だけを別モジュールへ残す。ただし `Player.getPortWorldPos/Normal`(手順4で削除)も
道連れで残す必要がある。

### 3. `money` は残し、`inventory` と `dockedVessels` は消す

- `money` は基地の外に読み手が3つある — `RunSummary.money`(`game.ts:205`)→
  `SnapshotMeta.money`(`launcher/save/slot-data.ts:26`)→ 記録一覧の「所持金 N Cr」表示
  (`launcher/save-browser/snapshot-pane.ts:201`)。消すと**セーブ索引の形が変わる**ため、
  既存の索引を捨てることになる。基地ビューを作り直せばすぐ戻る値なので、残すほうが安い。
- `inventory` は基地パネル3タブの外に読み書きが**一つもない**(セーブの往復のみ)。
  買う手段が消えれば永久に空配列なので消す。
- `dockedVessels` は意味そのものがドッキング。消す。

**残る歪み**: 増減させる経路が消えるので、`money` は常に「100,000 × 基地数」になる。
覆されたら手順4で `money` も落とし、`RunSummary` / `SnapshotMeta` / `snapshot-pane` /
`legacy-save.ts:66` / `snapshot-service.ts:36` の5箇所を追う(セーブ索引版の扱いも決め直す)。

### 4. `SAVE_VERSION` は上げない

`BaseSaveData.dockedVessels` を型から落としても、旧スナップショットは
「読まれないフィールドが JSON に残る」だけで読み込みは通る。**格納艦は黙って消える。**
版を上げれば正直になるが、格納艦を持たないものも含めて**既存スナップショットが全部読めなくなる**。
基地は creative でしか置けず(ステージ 0/00/1/2 は基地を置かない)、格納艦を持つ記録は限られる
ので、全部捨てる代償のほうが大きいと判断した。

**覆されたら**: 手順4で `save-data.ts:216` の `SAVE_VERSION` を 3 へ上げる。

### 5. `Player` と `Base` の共通基底を作り直すのは、この計画の範囲外

`Controllable`(`dynamic/dynamic-entity/controllable.ts`)がすでにその役割を持っている。
`updateBaseControls` / `syncBase` が `Player` 側と重複している件は独立した論点で、
破棄と混ぜると差分が読めなくなる。**この計画では触らない。**

### 6. 基地の左クリックは「何も起きない」にする

`Base.onMapSelect`(`base.ts:529-533`)は `commands.selectBase()` とヒントを出しているが、
`selectBase` の先は `Docking._activeBase` を書くだけで、**今も観測できる効果はヒントだけ**。
`onMapSelect = null` にして、敵・補給・天体と同じ「左クリックで掴めない対象」へ揃える。

**覆されたら**: 手順2で `Player.onMapSelect` と同じ「プロパティウィンドウを開く」にする
(MAP.md の記述もそちらへ合わせる)。

## 達成目標

全手順の実施後、次がすべて満たされること。

1. 次の検索が **0 件**。

   ```
   git grep -nEi 'dock' -- src tools tests \
     ':!src/assets' \
     ':!src/render/pipeline/lighting/ltc-table.generated.ts' \
     ':!src/render/base-station-model.ts'
   ```

   除外の理由: 前2つは base64 の中でたまたま `dock` に当たる生成物・アセット。
   `base-station-model.ts` は `buildDockingBay()`(2件)を**意図して残す** — 基地モデルの
   ハッチとベイは造形であって機能ではない(→ 決めたこと 1)。この3つ以外に例外を作らない。
2. `git grep -nE 'Docking|DockingGuide|BasePanel|DockedVesselEntry|dockedVessels|dockedShips|BASE_MAX_VESSELS|ResourceTransferDialog|freeProcurement|getPortWorld|getSlotWorld|getHatchWorld|attachDockedVesselMesh|detachDockedVesselMesh' -- src tools tests`
   が **0 件**。
3. `git grep -n 'ドッキング\|基地パネル\|格納艦\|新造\|物資・電力の融通' -- DEVELOP/SPEC` が **0 件**。
   `ドック` は左ドック(UI レール、MAP.md:156 / RENDERING.md:123,127)の意味だけが残る。
4. 削除対象9ファイルがリポジトリに存在しない。
5. `npm run typecheck` が通る。`npm run test:game` `npm run test:render` が通る。
6. **目視**: creative ステージで基地を配置し、右クリックする。「ドッキング」「基地パネルを展開」
   「基地に収納」「物資・電力の融通」のいずれも出ない。「操作対象にする」を選び WASDQE で
   噴射でき、プルームと RCS パフが出る。基地へ 300 m 以内まで艦を寄せても、
   軸線・リング・`◎` マーカーが出ない。

## 手順

### 手順 2. `Docking` と `DockingGuide` を消し、配線を切る

**目的.** 機能の入口を全部落とす。この手順が終われば、ゲーム中からドッキングへ到達する手段が
一つも残らない。`base-view*` と `resource-transfer-dialog` は参照ゼロの孤児になるが、
**この手順では消さない**(手順3で消す) — 一度に触るファイルを増やさないため。

| ファイル | 何をするか |
| --- | --- |
| `src/game/docking/docking.ts` | **ファイルごと削除**(339行)。`src/game/docking/` は空になるのでフォルダごと消える |
| `src/game/docking/docking-guide.ts` | **ファイルごと削除**(131行) |
| `src/game/game.ts` | 54行の import、104行の `docking` フィールド、325-331行の生成と `setDocking`、336行の `this.docking.guide` 引数、381行の `dispose`、495行の `updateDockedPhysics()` を落とす |
| `src/game/view/combat-view.ts` | 17行の import、41行のコンストラクタ引数 `dockingGuide`、68行の `hide()`、129行の `sync()` を落とす。`onLeave()` は空になるが**メソッドは残す**(`ViewFrame` の必須メンバ) |
| `src/game/pickable/object-windows.ts` | 24・35行の import、63-67行の `setDocking`/`docking` フィールド、131行の `closePanel()`、162-168行の `collapseBasePanel()`、304-306行の `selectBase`、310-321行の `toggleBasePanel`、352行の `clearActiveBaseIf`、356-369行の `dock`/`undock`/`transferResources`、397-406行の `dockState`/`isBasePanelExpanded`、55行の `expandedBaseWindowKey` を落とす。128-134行の `onClose` は `partWindows.closeFor` と `forgetWindow` だけを残す |
| `src/game/pickable/object-commands.ts` | 11行の `DockState` 型、21行 `selectBase`、23行 `toggleBasePanel`、39行 `dock`、41行 `undock`、43行 `transferResources`、63行 `dockState`、65行 `isBasePanelExpanded` を落とす。`Base` の import は `setControlledBase`/`removeBase` が残るので保持 |
| `src/game/hud/windows/menu-actions.ts` | `MenuAction` から `'toggleBasePanel'`(19行) `'dock'`(21) `'undock'`(22) `'storeInBase'`(23) `'transferResources'`(24) を落とす。`MenuCommon` から `dock`(44) `undock`(45) `storeInBase`(46) `transferResources`(47) を落とす。**`storeInBase` はどのメニューにも置かれていない死んだ項目**で、ここで一緒に消える |
| `src/game/player/player.ts` | 711-715行の `dockState`/`dockItems`、723行の `...dockItems`、738-743行の `'dock'`/`'undock'`/`'transferResources'` 分岐を落とす |
| `src/game/dynamic/dynamic-entity/base.ts` | 465-466行の `dockItems`、472行の `...dockItems`、473-476行の「基地パネルを展開/収納」項目、493-496行の `'toggleBasePanel'`/`'dock'` 分岐を落とす。529-533行の `onMapSelect` を `null` にする(→ 決めたこと 6)。`ObjectCommands` の import は残る |
| `src/game/dynamic/dynamic-system.ts` | 190-196行の `park()` を落とす(唯一の呼び出し元が `docking.ts:281`)。232-235行の `findPlayer` は 247行に内部呼び出しが残るので**消さず** `private` にする |

**達成条件と検証.**

- `git grep -nE 'Docking|DockingGuide|dockState|DockState|toggleBasePanel|isBasePanelExpanded|selectBase|storeInBase|transferResources' -- src` が 0 件。
- `git grep -nE '\.park\(' -- src` が 0 件。
- `src/game/docking/` が存在しない。
- `npm run typecheck` が通る。`npm run test:game` `npm run test:render` が通る。
- **目視**: creative で基地と自艦を置き、両方を右クリックする。「ドッキング」「ドッキング解除」
  「基地パネルを展開」「物資・電力の融通」が出ない。基地へ 300 m 以内へ寄せても軸線・リング・
  `◎` マーカーが出ない。

### 手順 3. HUD からドッキング由来のものを落とす

**目的.** 手順2で参照ゼロになった HUD モジュールと、それに引きずられて死んだ拡張点・
死んだ CSS を落とす。**この手順で挙動は変わらない**(すでに到達できないものを消すだけ)。

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/base-view.ts` | **削除**(430行) |
| `src/game/hud/panels/base-view-vessels-tab.ts` | **削除**(134行) |
| `src/game/hud/panels/base-view-parts-tab.ts` | **削除**(319行) |
| `src/game/hud/panels/base-view-shop-tab.ts` | **削除**(93行)。`SHOP_CATALOG` を読む唯一の場所 |
| `src/game/hud/panels/base-view-shared.ts` | **削除**(165行)。13個の export すべて、この5ファイル以外からの参照が 0 |
| `src/game/hud/windows/resource-transfer-dialog.ts` | **削除**(378行) |
| `src/game/hud/windows/rcs-fuel-transfer.ts` | **削除**(58行)。唯一の使い手が上のダイアログ |
| `src/game/hud/windows/index.ts` | 4行目の `ResourceTransferDialog` の再 export を落とす |
| `src/theme.ts` | 319行 `Z_RESOURCE_TRANSFER_DIALOG`、441行 `'--z-resource-transfer-dialog'` を落とす |
| `src/game/stages/stage.ts` | 148行 `freeProcurement` を落とす。読み手は `docking.ts:218` の1箇所しかなかった |
| `src/game/stages/creative-stage.ts` | 56行 `readonly freeProcurement = true;` を落とす |
| `src/game/dynamic/dynamic-entity/ship.ts` | 42行 `FIRE_INTERVAL` / 43行 `ENEMY_BULLET_DAMAGE` から `export` を外す(外部の参照元は `base-view-shared.ts` だけだった。ファイル内 124行の自己利用は残る)。141-142行のコメント「parts 配列は BasePanel/Player の換装経路で splice され」を、実際に残る経路(コンストラクタとセーブ復元)へ直す。237行「基地ドックの修理を要する」・240-241行「復旧にはドックでの修理が要る」を、**回復手段が無い**という事実へ直す |
| `src/game/hud/style/map-panel-style.ts` | 84行 `#hud.dock-mode #hud-predict-toggle { display: none; }` を落とす。`dock-mode` クラスを付ける側は**すでに存在しない**(旧ドックビューの残骸) |
| `src/hud/style/settings-view-style.ts` | 10-24行の `.settings-dock` 一式(12行)を落とす。同じく付ける側が存在しない |

**達成条件と検証.**

- 削除対象7ファイルが存在しない。
- 達成目標 1 の検索(3つの除外つき)の残りが、`base.ts` の接続点まわり(手順4で消す)だけになる。
- `git grep -nE 'freeProcurement|SHOP_CATALOG|NEW_VESSEL_COST|REPAIR_COST_PER_HP|rcsFuelTotals|balanceRcsFuel' -- src` が 0 件。
- `npm run typecheck` が通る。`npm run test:game` `npm run test:render` が通る。
- **目視**: 設定ビューを開き、コンパクト幅(横 640px 以下)まで縮めて崩れないこと
  (`.settings-dock` は付いていないので変わらないはずだが、消した後に確かめる)。

### 手順 4. `Base` から接続点・格納艦・在庫を、`Player` からポートを落とす

**目的.** 実体側に残った、もう誰も読まない状態と幾何を落とす。ここまでで「ドッキング」を
指すものがコードから消える。

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/base.ts` | 55行 `BASE_MAX_VESSELS`、64-66行 `BASE_HATCH_LOCAL_POS`/`NORMAL`、68-79行 `BaseDockSlot`/`BASE_DOCK_SLOTS`、81-91行 `DockedVesselEntry`、93-97行 `BaseState` から `inventory` と `dockedVessels`、117-121行の初期値から同2つ、216-235行のセーブ復元から `inventory`/`dockedVessels` の復元(`Player` の再構築と `attachDockedVesselMesh` を含む)、238-295行の7メソッド(`getHatchWorldPos`/`getHatchWorldNormal`/`getSlotWorldPos`/`getSlotWorldNormal`/`getAvailableSlotIndex`/`attachDockedVesselMesh`/`detachDockedVesselMesh`)、394-396行の `dispose` の格納艦回収、410-411行の `serialize` の `inventory`/`dockedVessels` を落とす。1行目のファイル冒頭コメント(「艦艇のドッキングと格納、部品と資金の保有、そこからの発艦を持つ」)を実態へ書き直す。441-447行 `listDetail` は自艦なしのとき `''` を返す(敵・補給と同じ形)。460-461行のメニュー副題から「格納艦艇: N隻」を落とす。520行のプロパティ行「格納艦艇数」と、それを説明する 508-509行のコメントを落とす。173-180行のコンストラクタのコメントと引数 `fx` を落とす(下の注記) |
| `src/game/player/player.ts` | 76行 `SHIP_PORT_OFFSET`、250-258行 `getPortWorldPos`/`getPortWorldNormal` とその上のコメントを落とす。4行目の import から `LOCAL_FORWARD` を落とす(**player.ts での使用箇所は 257行だけ**。`qFromBasis`/`qRotate` は残る) |
| `src/game/save/save-data.ts` | 126-131行の `inventory?` / `dockedVessels` / `dockedShips` と、それらを説明するコメントを落とす。**1行目の `AnyPart` の import は残す** — 89行の `EntitySaveData.parts` が使っている |
| `src/game/dynamic/dynamic-system.ts` | 422-423行のコメント「基地は常設の軌道構造物で、接近・ドッキングは軌道面合わせそのものなので」から理由付けを直す(**挙動=常設は残す**) |

**コンストラクタ引数 `fx` は落ちる。** `base.ts` の中で `fx`(`EffectsSystem`)を使うのは
222行の格納艦生成 `new Player(hud, worldSfx, scene, fx, markerManager, …)` **だけ**なので、
180行の引数と18行の import ごと落とす。`hud` は 211行(`PlayerThrottle`)、`worldSfx` は
212-213行(`ThrustEffects`/`RcsEffects`)で使い続けるので**残す**。
落とした引数は生成側2箇所 — `dynamic-system.ts:129` と `creative-stage.ts:353` — から外す。
173-174行のコメント(「hud/worldSfx/fx/markerManager は格納艦(Player)の組み立てに要る」)は
説明する対象が消えるので、コメントごと落とす。

**達成条件と検証.**

- 達成目標 1 の検索(3つの除外つき)が **0 件**。
- `git grep -nE 'BASE_MAX_VESSELS|DockedVesselEntry|getPortWorld|SHIP_PORT_OFFSET|baseState\.inventory' -- src` が 0 件。
- `npm run typecheck` が通る。`npm run test:game` `npm run test:render` が通る。
- **目視**: creative で基地を配置 → 右クリックのプロパティウィンドウに「所持金」「距離」と
  軌道要素が出て、「格納艦艇数」が出ない。マップの物体一覧で、自艦がいないときの基地行の
  補助表示が空になる。基地を保存 → 読み込みして、位置・姿勢・所持金・軌道線トグルが復元される。

### 手順 5. 規約点検とコメント点検

**目的.** 削除で焼け残った命名・コメント・責務の歪みを直す。**挙動は変えない。**

- 触った範囲へ `/refactor` を通す(判断基準は `DEVELOP/CODING-RULE.md`)。特に見るところ:
  - `ObjectWindows` のコンストラクタ引数(削除前は14個、規約 1.4)が減っているか。
  - `ObjectCommands` に残ったメンバの並びとコメントが実態に合っているか。
  - `Docking` が握っていた `Hud` / `WorldSfx` / `EffectsSystem` / `MarkerManager` /
    `CameraSystem` への参照が、`Game` 側で他の誰も要らなくなっていないか。
- 触った範囲へ `/comment-cleanup` を通す。特に「ドック」「格納」「収容」「発進」を指す
  コメントが残っていないか。
- `refactor_modules.md` 論点22(基地パネル状態の三重持ち)が構造ごと消えたことを確認する
  — 3つの持ち主のうち2つ(`Docking._activeBase` / `BasePanel.currentBase`)がファイルごと、
  1つ(`ObjectWindows.expandedBaseWindowKey`)がフィールドごと消えている。
  **`memos/` の書き換えは指示があるまでしない。**

**達成条件と検証.**

- 「達成目標」の 1〜6 をすべて当てる。
- `npm run typecheck` が通る。`npm run test:game` `npm run test:render` が通る。
- main へ送るときは `/send-pr`(全層のテスト + `npm run build`)。

## 見積り

**削除される行数.** 実測(`wc -l`)。

| 区分 | 内訳 | 行 |
| --- | --- | --- |
| 全削除(手順2) | `docking.ts` 339 + `docking-guide.ts` 131 | 470 |
| 全削除(手順3) | `base-view.ts` 430 + `-parts-tab` 319 + `-shared` 165 + `-vessels-tab` 134 + `-shop-tab` 93 + `resource-transfer-dialog` 378 + `rcs-fuel-transfer` 58 | 1,577 |
| 部分削除 | `base.ts` ≈110 / `object-windows.ts` ≈60 / `player.ts` ≈25 / `object-commands.ts` ≈20 / `game.ts` ≈15 / `menu-actions.ts` ≈10 / `dynamic-system.ts` ≈8 / `save-data.ts` ≈8 / `settings-view-style.ts` 12 / その他6ファイル ≈8 | ≈276 |
| **合計** | | **≈2,320** |

**触るファイル数.** 削除9 + 編集15 = **24**(SPEC 7ファイルは別)。

**手順ごとの規模.**

| 手順 | 削除ファイル | 編集ファイル | 削除行 |
| --- | --- | --- | --- |
| 2 | 2 | 8 | ≈590 |
| 3 | 7 | 7 | ≈1,600 |
| 4 | 0 | 4 | ≈145 |
| 5 | 0 | 未定 | — |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 旧スナップショットの `dockedVessels` が**黙って捨てられる** | 格納艦を持つ既存の記録を読むと、その艦が消えたまま復元される。エラーも警告も出ない | 手順4。`SAVE_VERSION` を上げない判断(決めたこと 4)の直接の帰結 |
| 放熱板・太陽電池パドルと全損部品の**修理手段が世界から消える** | 一度損耗したら永久に戻らない。`ship.ts` の `SELF_REPAIR_EXCLUDED` は残るので、除外の理由だけが宙に浮く | 手順1(SPEC の記述)と手順3(`ship.ts` のコメント)。両方直さないと実装とコメントが矛盾する(規約 3.3) |
| `Base` のコンストラクタ引数 `hud`/`worldSfx` を、`fx` と一緒に**まとめて落としてしまう** | `PlayerThrottle` が `hud` を、`ThrustEffects`/`RcsEffects` が `worldSfx` を要る。落とすと基地の推力プルームと RCS パフが消える | 手順4。落とすのは `fx` だけ。typecheck では気付けるが、生成側2箇所の引数順を同時に間違えると通ってしまう |
| `MenuAction` から値を落とすとき、`storeInBase` のように**どこにも置かれていない項目**を「使われている」と誤認して残す | 死んだ識別子が残る | 手順2。`git grep "'storeInBase'"` で置き場所が `menu-actions.ts` だけであることを確かめてから落とす |
| `findPlayer` を「外部参照 0」だけを見て**削除してしまう** | `dynamic-system.ts:247` に内部呼び出しが残っている | 手順2。`private` にするだけで、消さない |
| `dock` の全文検索が、生成物・アセットの base64 と、残すと決めた `buildDockingBay` に**当たって 0 件にならない** | 達成目標 1 が判定できなくなり、消し残しがあるのか除外漏れなのか分からなくなる | 手順2〜4。検索は必ず達成目標 1 の**3つの除外を付けた形**で打ち、それ以外の除外を足さない |
| `MAP.md:490` / `dynamic-system.ts:422` の「基地の赤道交点は常設」という**挙動まで一緒に落とす** | 基地の昇交点△・降交点▽が出なくなる。ドッキングとは独立した表示なので残すべき | 手順1・手順4。**理由付けの文だけを直し、挙動には触らない** |
| `Base.listDetail` を空文字にしたことで、マップ物体一覧の基地行が**自艦なしのとき無表示になる** | 一覧が寂しくなる。敵・補給と同じ振る舞いなので不整合ではないが、変化ではある | 手順4 |
| `money` に増減経路が無くなり、記録一覧の「所持金」が**常に 100,000 × 基地数** | 一覧の情報量がゼロになる。判断(決めたこと 3)どおりだが、見た人は壊れたと思う | 手順4 |
| `#hud.dock-mode` / `.settings-dock` を「使われているかもしれない」と**残す** | 旧ドックビューの残骸が生き延びる。付ける側のコードは既に存在しない | 手順3。`git grep 'dock-mode\|settings-dock'` の結果がスタイル定義側だけであることを確かめる |
| 手順2で孤児になった HUD モジュールを、**手順3で消し忘れる** | 参照ゼロのまま 1,577 行が残る。typecheck は通ってしまう | 手順3。削除対象7ファイルの不在を確かめる |
