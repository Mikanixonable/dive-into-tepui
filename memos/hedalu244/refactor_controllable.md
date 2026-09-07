# 操作対象(Controllable)まわりのリファクタリング

行番号・件数はすべて `38329adc` 時点のもの。食い違ったらコードを信じる。

## 目的

`Controllable` という共通基底が既にあるのに、**「操作対象が艦なのか基地なのか」を上位が名指しで
持ち回っている。** そのせいで、

- `ActiveControllableController` が `_current: Player | null` と `_controlledBase: Base | null` の
  2フィールドを持つ。**両方が非 null になることは設計上ありえない**(`set()` は基地を外し、
  `setBase()` は艦を外す)のに、型はそれを言っていない。「操作対象を1つ選ぶ」という責務が
  漏れて、呼び出し側が毎回 `controlledBase ?? player` を書いている。
- `Game` が `player` / `controlledBase` / `activeControllableEntity` の**3つの答え**を公開し、
  しかも中身が食い違う — `activeControllableEntity` だけが「生存中の基地」へのフォールバックを
  持つので、`CombatView.canEnter()`(フォールバック無し)と VESSEL/軌道パネル(フォールバック
  有り)が別の対象を指す。
- `DynamicSystem` が `updatePlayers` / `updateBases` / `syncPlayers` / `syncBases` /
  `syncDetachedBoosters` と種別ごとに手続きを分け、`applyVisibility` は種別を直書きした
  5ブロックになっている。**エンティティの保持と同期という責務に対して、種別の知識が過剰。**
- `CameraSystem.update` の先頭引数が `player: DynamicEntity | null` で、実際に使うのは
  `player instanceof Player` という照準ズームの可否判定だけ。名前・型・位置のすべてがずれている。
- 分離ブースターが敵の表示トグルに従っている(`dynamic-system.ts:418` に TODO が残っている)。
  燃焼の前進(`updateBurn`)は `updatePlayers` の中に埋まっている。

**修正後に期待される状態。** 操作対象は `Controllable | null` の1値で、それを持つのは1モジュール
だけ。`Game` と `DynamicSystem` は「艦か基地か」を一切見ない。種別を見てよいのは、種別ごとの
見た目・ゲーム規則を責務として持つモジュール(`EntityLineManager` の線種表、`Stage` の台本、
`DynamicSystem` の復元と serialize)に限る。

---

## 決めたこと

**すべてユーザーが覆せる。** 覆したときにどの手順が変わるかを併記する。

### 1. 操作対象は1フィールドで持つ

`Player | null` と `Base | null` の対を捨て、`Controllable | null` 1つにする。
これが本計画の背骨で、他のすべてはこれに乗る。

**覆されたら**: 本計画は成立しない。手順4・6・8・9 だけが独立して残る。

### 2. 「生存中の基地へ落ちる」フォールバックは、選択そのものへ格上げする

いまの `game.ts:74` は、誰も操作していないときに `dynamicSystem.bases.find(b => b.alive)` を
「操作対象」として答える。**この状態は一貫していない** — パネルとカメラはその基地を見るのに、
キー入力は届かず、ビューバッジの Control 欄は空、戦闘ビューへも入れない。

1値へ束ねるにあたり、**フォールバックを「実際に選ぶ」へ格上げする。** 具体的には
`claimIfNone(target: Controllable)` が艦だけでなく基地も受け、選択が空の場面
(構築時・操作対象の喪失後)で `Controllable` を1つ確保する。

- **挙動の変化**: 艦が0隻で基地だけがある周回では、その基地が実際に操作対象になる
  (WASDQE が基地へ届き、戦闘ビューへ入れる)。攻略ステージで最後の艦を失った直後も、
  基地があればそちらへ移る(ただし決着後は `isPlaying` が false で積分ごと止まるため、
  実際に操作できるのは CREATIVE と、決着を持たないステージだけ)。
- **覆されたら**: フォールバックを廃止する。手順5で `claimIfNone` を艦のみに戻し、
  「誰も操作していない」状態では VESSEL/軌道/計画パネルが畳まれ、`@controlled` 役割の
  フォーカスが解決不能になる(マップは原点へ落ち、戦闘は最後の位置で保持される)。

### 3. 分離ブースターは「自艦」の表示トグルに従う

いまは敵トグル。分離ブースターは自艦から切り離されたものなので、自艦の種別トグルに従わせる。
専用のトグル行は増やさない(`MapDisplayToggles` の4種別を5種別にすると、表示パネルの行が増え、
保存されたトグルの形も変わる。ブースターは名前も軌道線も持たないので、行としては
カテゴリ1つしか置くものがない)。

**`DEVELOP/SPEC/MAP.md` は本計画では書き換えない。** 4節「表示するオブジェクトの選択」は
「〜は持たない」「〜の影響は受けない」の列挙になりがちで、そこへ1項足しても現状の説明が増える
だけになる。節の書き方そのものを別途直す。挙動の修正だけをここで行う。

**覆されたら**: 手順4の1行が変わるだけ。専用トグルを選ぶなら
`DynamicEntityKind` に `'booster'` を足し、`display-toggles.ts` の
`MapDisplayToggles` / `DEFAULT_MAP_DISPLAY_TOGGLES` / `MAP_DISPLAY_CATEGORIES` と
`visibility-policy.ts` の `ENTITY_KEYS` へ行を1つ増やす。

### 4. 照準ズームの可否は `Controllable.fire !== null` で決める

`player instanceof Player` を置き換える条件。ガンサイトは機関砲の照準器なので、
「砲を積んでいるか」がそのまま可否になる。専用のフラグを新設しない
(`fire` と同時にしか切り替わらないフラグを別に持つのは、規約 1.6 の言う「たまたま同時に
切り替わるフラグ」の逆で、単なる重複になる)。

**覆されたら**: 手順6で `Controllable` に `readonly hasGunsight: boolean` を足す。

### 5. 役割トークン `@activeShip` は `@controlled` へ改名する

`FrameRole = 'activeShip'`(`physics/frame.ts:29`)は操作対象を指す役割だが、基地は船ではない。
表示名も `'操作対象の船'`(`frame-labels.ts:8`)で、基地を操作している間は嘘になる。

このトークンは**セーブに載る**(`FocusTargetSaveData.id` / `ReferenceFrame.center`)ので、
改名するなら読み込み境界(`launcher/save/snapshot-service.ts` の正規化)で
`@activeShip` → `@controlled` へ書き換える。`SAVE_VERSION` は上げない — 正規化で読めるため。

**覆されたら**: 手順8を丸ごと落とす。残る歪みは、役割の名前と表示名が操作対象の実態と
食い違ったままになること。

### 6. 共有される操作系から `Player` 接頭を落とす

`PlayerThrottle` は `Base`(`base.ts:29,85,169`)と `Ship`(`ship.ts:18`)も使う。
`PlayerFire` / `PlayerBoosters` は `Controllable` の口に載る(手順2)。
どれも自艦専用ではないので、`Throttle` / `Fire` / `Boosters` へ改名する。

**ディレクトリは動かさない。** `src/game/player/` に共有部品が置かれたままになるのは歪みだが、
移動先(`src/game/control/`?)を決めるには「自艦専用と共有の線をどこに引くか」を先に決める必要が
あり、本計画の射程を超える。

**覆されたら**: 手順9を落とす。あるいは移動まで含めるなら、`player-throttle.ts` /
`thrust-effects.ts` / `rcs-effects.ts` の3つが移動対象(Base が実体を import しているのはこの3つ)。

---

## 達成目標

全手順の実施後、以下がすべて成り立つこと。

1. `grep -rn "controlledBase" src` が **0 件**。
2. `grep -rn "activePlayers\|ActivePlayerController\|ActiveControllableController" src` が **0 件**。
3. `grep -n "from '.*player/player'\|from '.*dynamic-entity/base'" src/game/game.ts` が **0 件**
   (`Game` が `Player` も `Base` も import しない)。
4. `grep -rn "Player" src/game/camera/` が **0 件**。
5. `grep -n "activePlayer\|syncPlayers\|syncBases\|syncDetachedBoosters\|updatePlayers\|updateBases" src/game/dynamic/dynamic-system.ts`
   が **0 件**。
6. `dynamic-system.ts` に残る `Player` / `Base` / `DetachedBooster` の名指しは、
   **復元(`restoreFromSave`)・型別 index の getter・`perfCounts` の3箇所だけ**。
7. `dynamic-system.ts:418` の `TODO: 分離ブースターは自機由来なのに敵トグルへ従っている` が消える。
8. `Game` が公開する操作対象の口が `activeControllable` **1つだけ**になる
   (`player` / `controlledBase` / `activeControllableEntity` がいずれも 0 件)。
9. `grep -rn "PlayerThrottle\|PlayerFire\|PlayerBoosters" src` が **0 件**。
10. `npm run typecheck` と `npm run test` が通る。
11. マップビューで「敵」のカテゴリトグルを OFF にしても、分離ブースターが消えない。
    「自艦」を OFF にすると消える。

---

## 手順


### 手順 9. 共有される操作系から `Player` 接頭を落とす

#### 目的

`Controllable` の口に載っている型が `Player*` を名乗っていると、共通基底の意味が名前で否定される。
**この時点で挙動は変えない**(純粋な改名)。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `src/game/player/player-throttle.ts` → `src/game/player/throttle.ts` | `PlayerThrottle` → `Throttle` |
| `src/game/player/player-fire.ts` → `src/game/player/fire.ts` | `PlayerFire` → `Fire` |
| `src/game/player/player-boosters.ts` → `src/game/player/boosters.ts` | `PlayerBoosters` → `Boosters` |
| 参照側(型名 + import パスで grep 実測 31 箇所) | `controllable.ts`, `player.ts`, `base.ts`, `ship.ts`, `hud/ammo-status.ts`, `hud/panels/vessel-panel.ts`, `hud/windows/help-content.ts`, `plan/plan-guide.ts`, `stages/stage-debug*.ts`, `player/booster-stack.ts` |

#### 達成条件と検証

- 達成目標 9 の grep が 0 件。`grep -rn "player-throttle\|player-fire\|player-boosters" src` も 0 件。
- `npm run typecheck`、`npm run test`(全層 — 改名の取りこぼしはどの層でも落ちうる)。

---

## 見積り

**実行時コスト。** 手順4で `updateThrust` の全個体走査が1本増える。個体数の上限は
弾 1200 + 薬莢 260 + 破片 600 + その他 ≒ **2100 個体**、空の仮想呼び出し1回を 2ns として
**2100 × 2ns ≒ 4µs/frame**(60fps の 1 フレーム 16.7ms の 0.03%)。既に
`clearEquatorNodes` / `syncEquatorNodes` / `requestHistoryDuration` / `cleanup` が同じ規模の
全個体走査を毎フレーム4本回しているので、5本目が増える形になる。
`syncEffects` の全体ループも同じ規模で **+4µs/frame**。

一方で減る側: `syncPlayers`+`syncBases`+`syncDetachedBoosters`+`applyVisibility` の5ブロックが
`syncControllables` + `applyVisibility` の2ループになり、`players` / `bases` /
`detachedBoosters` getter が組む**フィルタ配列の生成が毎フレーム 5 本から 2 本へ減る**
(getter は呼ぶたびに `entities.filter` で新しい配列を作る — `dynamic-system.ts:56-62`)。
差し引きで悪化しない見込みだが、**測っていない**。`npm run dev` の perf-meter で
`sync` 区間を改修前後で読み比べること。

**作業量**(grep で数えた変更箇所)。

| 手順 | ファイル数 | 変更箇所 |
| --- | --- | --- |
| 1 | 1 | 1 |
| 2 | 6 | 12 |
| 3 | 9 | 24 |
| 4 | 4 | 12 |
| 5 | 約 25 | 約 70 |
| 6 | 3 | 6 |
| 7 | 約 20 | 約 45 |
| 8 | 6 | 10 |
| 9 | 3 + 参照 10 | 20 |

手順5が突出しているが、**分割できない** — フィールドを1つにした瞬間に、
`player` / `controlledBase` を読む全箇所が同時に壊れる。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `getCombatTargets` の並びが `[敵, 自艦, 基地]` から `[敵, 追加順の操作対象]` へ変わる | `[T]` のターゲット巡回順が変わる。壊れはしないが、順序に依存したテストがあれば落ちる | 手順3。`npm run test:game` と、戦闘ビューで `[T]` を連打して巡回することの目視 |
| Base がいま `syncControllable`(旧 `syncBase`)と `syncOtherEntities` の**両方**で同期されている | 束ねると1回になる。いまは後から走る汎用 `sync` が `renderObject.visible = true` を上書きし、その後の `applyVisibility` がカテゴリだけ伏せ直している。束ねた後は `syncControllable` の判定がそのまま残るので、**基地の表示条件がカテゴリだけから「カテゴリ + 表示時刻の状態が求まること」へ変わる** | 手順3。マップビューで未来スライダーを予測の届かない先まで動かし、基地が消えることを確認(消えるのが正しい) |
| `applyVisibility` を `mapKind !== null` の全個体ループにすると、弾・薬莢・破片(`mapKind` 無し)が確実に除外されているかが暗黙になる | 除外し損ねると弾が丸ごと消える | 手順3。戦闘ビューで射撃して弾が見えることの目視 |
| 分離ブースターのプルームが `applyVisibility` の後に同期されるよう順序を組み替える | 順序を誤ると、カテゴリ OFF でもプルームだけが残る | 手順4。マップで「自艦」トグル OFF → 燃焼中のブースターのプルームも消えること |
| `claimIfNone` が基地を受けるようになる(決めたこと 2) | 艦を全喪失した直後に基地の操作へ移る。CREATIVE で艦を消すと基地が勝手に操作対象になる | 手順5。CREATIVE で艦だけを削除し、Control 欄に基地名が出ることを確認(出るのが期待) |
| `Base.reclaimedByOwner = true` にすると、`prune` が基地を消さなくなる | `ControlSelection.reclaimDead()` が呼ばれる経路(`game.ts:492`)を落とすと、**死んだ基地が永久に残る** | 手順5。CREATIVE で基地を削除し、次のフレームでマーカー・一覧から消えることを確認 |
| `save-data.ts` の `activePlayerId` → `activeControlledId` 改名 | 旧スナップショットは操作対象 id を読めず、**先頭の Controllable から再開する**(壊れはしないが、複数艦を置いた周回では操作対象が変わる) | 手順5。改名前に複数艦のスナップショットを保存し、改名後に読んで確認。許容できないなら `snapshot-service.ts` の正規化へ `activeControlledId: data.activeControlledId ?? data.activePlayerId` を足す |
| `checkLoss` の `viewerPos` が「基地操作中は ECI 原点」から「操作対象の位置」へ変わる | 弾の遠方消滅距離(`bullet.ts:109` `ENGAGEMENT_RANGE`)の基準が変わる。**基地操作中に弾が即座に消えていた**のが直る | 手順7。基地の近くで敵に撃たせ、弾が基地の手前で消えないことを目視 |
| `targeter` の `viewer` が基地を受けるようになる | ターゲット距離・方位マーカーの基準が原点から基地へ変わる(直る側) | 手順7。基地操作中にターゲットパネルの距離が妥当な値になること |
| `@activeShip` の正規化漏れ(手順8) | **例外もログも出ない。** 戦闘カメラのフォーカスが解決できず `'hold'` で最後の位置に固定され、操作対象が軌道速度で流れて即フレームアウトする | 手順8。改名前に保存したスナップショットを改名後に読む |
| `ActivePlayerController` エイリアス経由の import が 6 ファイルに残る(`stage.ts:24`, `plan-display.ts:25`, `plan-editor.ts:27`, `object-pickables.ts:12`, `object-windows.ts:24`, `part-windows.ts:5`) | エイリアスを消した瞬間に型検査で落ちる(静かには壊れない) | 手順5。`npm run typecheck` |
| `Controllable.hp` / `maxHp` が `null` を取りうる(`base.ts:95-96`)ので、`runSummary` の HP 比を畳み方次第で常に 0 にしてしまう | 記録一覧の HP バーが、自艦を操作している周回でも空になる。**型検査は通る** | 手順5。艦を操作している状態でスナップショットを保存し、記録一覧の HP 表示が埋まることを確認 |
| `Stage.ship` が「操作対象が艦ならそれ、でなければ生存中の先頭」を返す(手順5) | 基地を操作している間も敵が艦を追い、補給が投入されるようになる(いまは `player` が null で止まっていた) | 手順5。攻略ステージで基地を操作し、敵が止まらないことを目視 |
