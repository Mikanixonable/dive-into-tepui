# 操作対象(Controllable)まわりのリファクタリング

**全手順を実施済み**(`38329adc`..`5cdd3283`、11 commit)。残っているのは、達成目標のうち
コードから判定できない2件と、リスク表の目視項目だけ。行番号・件数は着手時点(`38329adc`)の
もので、いまのコードとは合わない。

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

`PlayerThrottle` は `Base` と `Ship` も使い、`PlayerFire` / `PlayerBoosters` は `Controllable`
の口に載る。どれも自艦専用ではないので接頭を落とす — `Throttle` / `FireControl` /
`AttachedBoosters`。`Fire` 単独では炎と射撃のどちらとも読めるので射撃管制の定訳を採り、
`Boosters` は同居する `BoosterStack` / `DetachedBooster` と紛れるので、分離済みと対にした。

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

## 残っている確認

コードから判定できないので、実機で見る。

| 見るもの | 期待 |
| --- | --- |
| マップの「敵」カテゴリトグルを OFF | 分離ブースターは残る(達成目標 11) |
| マップの「自艦」カテゴリトグルを OFF | 分離ブースターも消える。燃焼中でもプルームごと消える |
| 戦闘ビューで `[T]` を連打 | ターゲットの巡回順が変わっている(敵 → 追加順の操作対象) |
| マップで未来スライダーを予測の届かない先へ | 基地が消える(束ねる前はカテゴリだけで判定していた) |
| CREATIVE で艦だけを削除 | Control 欄に基地名が出て、WASDQE が基地へ届く |
| CREATIVE で基地を削除 | 次のフレームでマーカー・一覧から消え、その基地を指していた航法ターゲットも外れる |
| 基地を操作しながら戦闘ビューでターゲット設定 | ターゲットパネルの距離が基地からの距離になる(ECI 原点からではない) |
| 基地の近くで敵に撃たせる | 弾が基地の手前で消えない |
| 攻略ステージで基地を操作 | 敵の行動と補給の投入が止まらない |
| 改名前に保存したスナップショットを読む | 戦闘カメラが操作対象へ追従し、操作対象の艦も保存時のものに戻る |

## 残る歪み

- **`src/game/player/` に共有部品が residual で残る。** `throttle.ts` / `fire-control.ts` /
  `attached-boosters.ts` / `thrust-effects.ts` / `rcs-effects.ts` は基地も使う。移動先を決めるには
  「自機専用と共有の線をどこに引くか」を先に決める必要がある。
- **`PlanExecutionMode` が `player/player.ts` にある。** `Controllable` と `Plan` の双方が読む値
  なので、`plan/plan.ts` が持ち場。
- **`game.ts` に配線でないメンバーが残る**(`advanceSimulation` / `handlePointerInput` /
  `proteinMotionFrameSample`)。本計画の射程外で、`memos/hedalu244/refactor_game.md` 論点3 が同じ話。
- **`Controllable.syncControllable` は型名を重ねている**(規約 2.2)。`DynamicEntity.sync` と
  引数が違って override できないため、名前を分けるしかなかった。
