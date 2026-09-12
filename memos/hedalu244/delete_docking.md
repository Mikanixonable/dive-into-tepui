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

## 実測(全手順 実施後)

`948f8b76..720f0cd2` の差分。

| 区分 | ファイル | 追加 | 削除 |
| --- | --- | --- | --- |
| `src/` | 28(削除9・編集19) | 30 | 2,423 |
| `DEVELOP/SPEC/` | 7 | 20 | 53 |
| **合計** | **35** | **50** | **2,476** |

見積り(≈2,320行 / 24ファイル)に対し、削除行はほぼ一致。ファイルが増えたのは、
実施中に見つかった死んだ拡張点(`PropertyWindow.setExpandedPanel`)と、
焼け残ったコメント(`draggable-window.ts` / `active-controllable-controller.ts`)を足したため。

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
