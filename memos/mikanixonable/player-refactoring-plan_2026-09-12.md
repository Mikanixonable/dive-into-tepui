# 自機周辺リファクタリング計画

作成日: 2026-09-12  
計画の基準コミット: `1655f2b9f`  
状態: 未実装のバックログ

## 目的

自機周辺のゲーム状態、物理、入力、演出、保存、HUD、マーカーの境界を整理する。
`Player` を単なる巨大な窓口にするのではなく、状態の所有者と各機能の責務を明確に分ける。

対象は前回の調査項目7〜18である。この計画書の作成だけを行い、本セッションでは以下を実装しない。

- `Player`、`FireControl`、`PlayerMotion` の分割
- `Controllable`、`Ship`、`ProteinEnemy` の型境界変更
- `Belt`、`RadiatorSystem`、`PowerSystem` の再編
- Player / Enemy の共通化
- HUD から `PlayerMotion` 内部参照を除去

## 維持する制約

- プレイヤーから見える入力、射撃、物理、演出、保存形式を変えない。
- `Player`、`Base`、`Enemy` を一つの汎用エンティティへ統合しない。
- 自機と敵の射撃・照準・被弾のゲーム調整値は、将来別々に調整できるよう個別実装を維持する。
- `GameContext`、汎用 `Services`、DIコンテナ、全機能を詰め込んだ read model は作らない。
- 新しい境界は、責務名のある機能固有の port、command、snapshot にする。
- 保存形式を変更する必要が出た場合は、リファクタリングではなく仕様変更として分離する。

## 現行の主な問題

### 7. `Player` の責任過多

対象: `src/game/player/player.ts`

入力解釈、推進・姿勢制御、射撃、ブースター、被弾・接触、喪失、VFX/SFX、ステージ記録、
セーブ、マーカー、一覧、メニュー、プロパティ表示、描画入力生成が同居している。

### 8. `FireControl` の責任過多

対象: `src/game/player/fire-control.ts`

弾薬状態、発射状態、銃身熱、弾体生成、薬莢・銃身デブリ、反動、スコア、音声、閃光、
太陽グレア補正を一つの型が所有している。

### 9. `PlayerMotionReactions` の中継過多

対象: `src/game/player/player-motion.ts`

物理層から Player へ、弾薬、熱、警報、接触、構造喪失、焼失など多数の callback を返している。
`PlayerMotion` と `Player` の循環依存を作り、`self as PlayerMotion` のキャストにも依存する。

### 10. `Belt` の薄いラッパー

対象: `src/game/player/belt.ts`, `src/game/player/belt-physics.ts`

`Belt` が給弾状態と `BeltPhysics` の委譲を束ねている。物理と給弾が同じ寿命・不変条件を持つなら
統合し、分離を維持するなら給弾状態を持つ独立した `BeltController` として明確な責務を与える。

### 11. `Controllable` のインターフェース過大化

対象: `src/game/dynamic/dynamic-entity/controllable.ts`, `base.ts`

Throttle、FireControl、AttachedBoosters、AltitudeAlarm、計画、燃料、ステージ、天体、レジストリを
一つの契約に含め、基地が `null` を返して未搭載機能を表現している。

### 12. `Ship` の汎用基底への自機仕様混入

対象: `src/game/dynamic/dynamic-entity/ship.ts`

自機用ロードアウト、スロットル定数、パーツ集計、ダメージ、燃料、SVGマーカーを、敵機や特殊敵も
使う基底クラスが持っている。特に `Ship` から `player/throttle` への依存方向を解消する。

### 13. 公開 mutable `parts` と更新規約

対象: `src/game/dynamic/dynamic-entity/ship.ts`, `parts.ts`, `part-windows.ts`

外部が `parts` を変更し、変更後に `refreshFromParts()` を呼ぶ規約へ依存している。呼び忘れで HP、
装備参照、燃料、発電量が不整合になる。

### 14. `ProteinEnemy` の継承契約違反

対象: `src/game/dynamic/dynamic-entity/protein-enemy.ts`

パーツ式の `Ship` を継承しながら、パーツを空実装にし、HP の正本をタンパク質戦闘状態へ移している。
共通化すべきなのは動体・選択対象・喪失ライフサイクルであり、パーツ船体そのものではない。

### 15. 展開パネル処理の重複

対象: `src/game/player/power.ts`, `radiator.ts`

`Panel`、展開目標、展開度の補間処理が重複している。ただし電力と放熱の性能計算まで一つへまとめず、
状態遷移だけを共通化する。

### 16. Player / Enemy の表示・喪失処理の重複

対象: `player.ts`, `enemy.ts`

マーカー、選択対象、軌道一覧、プロパティ、接触・喪失の共通形がそれぞれに存在する。
ゲーム調整値と戦闘判断は統合せず、調整に依存しない lifecycle や表示契約だけを抽出する。

### 17. 照準補正の重複

対象: `fire-control.ts`, `enemy.ts`

太陽グレアによる散布界補正が重複している。ただし散布界はゲーム調整値なので、共通化する場合は
純粋な幾何計算と倍率テーブルを分け、Player と Enemy の倍率を同一仕様と決めた場合だけ共有する。

### 18. HUD による Motion 内部構造の直接参照

対象: `src/game/hud/panels/vessel-panel.ts`, `src/game/hud/orbit/orbit-panel.ts`, `part-windows.ts`

HUD が `PlayerMotion` の `power`、`radiator`、`aero` や Ship の `parts` を直接読んでいる。
物理コンポーネントの構造変更が HUD へ波及するため、表示専用の最小 snapshot へ置き換える。

## 実装順序

### 0. 境界を固定するテストを先に追加

- Player の入力、弾薬、被弾、保存・復元、マーカーを現行挙動のテストで固定する。
- `PlayerMotion` の環境更新、接触通知、予測弧の invalidation を固定する。
- `Ship` のパーツ集計と、ProteinEnemy の HP 経路を固定する。
- HUD snapshot が同一フレームの値を読むことを確認する。

### 1. 表示・選択・プロパティの読み取り境界を作る

新規候補:

- `src/game/pickable/entity-inspection.ts`
- `src/game/pickable/player-inspection.ts`
- `src/game/pickable/enemy-inspection.ts`
- `src/game/player/player-status-snapshot.ts`

`Player` と `Enemy` から `PropertyRow`、`MenuItem`、`ObjectPickable` の実装を段階的に外す。
HUD は `PlayerStatusSnapshot` や inspection 契約だけを読む。生の `PlayerMotion`、`Ship.parts`、
`PowerSystem` は渡さない。

### 2. 副作用を port へ置き換える

候補:

- `PlayerEffects`: 通知、音声、閃光、ガス、破片生成
- `DamageOutcomeSink`: ステージの喪失記録、消滅要求、演出要求
- `ProjectileEmitter`: 弾体の生成とレジストリ登録

具象の `WorldSfx`、`FlashEffects`、`EntityRegistry`、`StageOutcome` を Player の全体へ渡さず、
各処理が実際に使う最小契約へする。汎用 `EntityServices` は作らない。

### 3. `FireControl` を状態と出力へ分ける

- `WeaponState`: 弾薬、銃身、クールダウン、熱、砲口交互状態の純粋な状態遷移
- `WeaponFireCommand`: 発射可能性、消費結果、反動量、熱量などの結果
- `ProjectileEmitter` / `WeaponEffects`: 弾、薬莢、デブリ、音、閃光、スコアの適用

`WeaponState` は `Player` 型、THREE、SFX、VFX、ステージを import しない。射撃のゲーム調整値は
自機側に残し、敵の射撃を同一クラスへ押し込まない。

### 4. `PlayerMotionReactions` を機能別 port へ分ける

- 物理層は環境入力と物性を読む。
- 接触は `ContactOutcomeSink` へ渡す。
- 焼失・構造限界は `LossSink` へ渡す。
- 警報は `AltitudeAlarmPort` へ渡す。
- 武器熱・給弾の問い合わせは、必要な数値の read port にする。

`PlayerBehavior` の自己キャストを減らし、`DynamicMotionBehavior` の契約を拡大する場合も、
物理一般に Player 固有の名前を持ち込まない。物性の動的計算は既存の `DynamicMotion` の
behavior hook と整合させる。

### 5. 入力と `Controllable` を分割する

候補:

- `PilotCommandReceiver`
- `ThrustController`
- `AttitudeController`
- `WeaponController`
- `BoosterController`
- `FuelConsumer`

`DynamicSystem` は生の `Input`、`StageOutcome`、`CelestialBodies` を一つの個体へ渡さず、入力変換後の
機能別 command を渡す。基地は実装していない機能を `null` で答えない。

### 6. `Ship` とパーツの正本を整理する

- 自機の標準パーツ生成を `PlayerLoadout` 側へ移す。
- `PartInventory` にパーツ参照の再構築と性能集計を集める。
- `parts` を直接変更できないよう、置換・損傷・修理の操作を所有者へ閉じ込める。
- SVG生成は `ShipMarkerRenderer` または marker adapter へ移す。
- `Ship` は船体の共通識別、Motion、View、必要最小限の戦闘対象契約に絞る。

この段階で `Ship` から `player/throttle` への import を無くす。

### 7. ProteinEnemy の継承を再設計する

共通基底を次の能力へ分ける。

- `CombatEntity`: 生存、HP問い合わせ、喪失通知
- `PartDamageTarget`: 部品式ダメージと性能集計
- `ProteinCombatTarget`: 機能部位式の HP と攻撃状態

`ProteinEnemy` に不要なパーツ API を継承させない。新しい基底を作る前に、Player、MetalEnemy、
ProteinEnemy がどのメソッドを実際に共有しているかをテストと参照から確定する。

### 8. 小さな共通化を最後に行う

- 展開・収納の状態補間だけを `DeployablePanelState` へ抽出する。
- マーカーと喪失 lifecycle は、調整値を含まない部分だけを共有する。
- 太陽グレアは、純粋な角度・影判定と倍率設定を分離する。
- Player と Enemy の戦闘結果・散布界・ダメージ量を、重複しているという理由だけで統合しない。

## 完了条件

- `Player` が DOM、`PropertyRow`、`MenuItem`、`PropertyWindow`、`ObjectPickable` を直接実装しない。
- `Player` の constructor とフレーム更新が、状態所有と機能別委譲として読める。
- `FireControl` の純粋な弾薬・熱状態が THREE、Player、SFX、VFX、Stage に依存しない。
- `PlayerMotion` が Player 全体を callback 集約先として要求しない。
- `Controllable` が Player 専用の具象クラスと `null` 装備を要求しない。
- `Ship` が `player/throttle` を import せず、自機ロードアウトと SVG を所有しない。
- `parts` の変更後に外部が `refreshFromParts()` を呼ぶ規約がなくなる。
- `ProteinEnemy` がパーツ船体の API を継承しない。
- HUD が `PlayerMotion` や `Ship.parts` の内部構造を直接参照しない。
- 共通化した箇所について、Player / Enemy のゲーム調整値を同じ変更で意図せず変えない。
- `npm run typecheck`、変更層の回帰テスト、必要な browser smoke が通る。

## 実装時の検証方針

各段階で `npm run typecheck` と該当層のテストを実行する。入力・HUD・描画・保存境界を変更した段階では、
combat/map、対象選択、プロパティ表示、セーブ・復元、射撃、パーツ損傷、ブースター操作を browser smoke で
確認する。計画の実装を開始するときは、この文書を現行コードと再照合し、すでに解消された項目を実装対象から
除外する。
