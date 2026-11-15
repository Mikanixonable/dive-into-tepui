# 敵機・Protein敵 リファクタリング／バグ調査報告

> **状態更新 — 2026-09-23 再監査:** この調査後に複数の修正・リファクタリングが入ったため、冒頭の未完了チェックリストを現状のまま実装指示として使わない。確認できた解消済み項目と残件を以下に整理する。

## 2026-09-23 再監査

### 解消済み

- **攻撃グループと表示色の分離:** `attackGroupId` が独立した属性として導入済み。Protein 編隊は `formationId` を攻撃グループとして使い、`tests/game/protein-formation.test.ts` で異なるグループを独立に扱う経路が検証されている。
- **Protein 掃引衝突の回転:** `ProteinSphereCollisionGeometry.testSweptSphereCollision()` は前回姿勢と現在姿勢を受け取り、ProteinEnemy 側も `previousSelfAttitude.q` / `selfAttitude.q` を渡す。
- **Protein 戦闘状態の正本:** HP・機能部位・修飾・攻撃部位巡回は `ProteinCombatState` が所有する構造になっている。
- **敵の責務分割の主要部分:** 射撃は `EnemyFireController`、反応は `EnemyReactions`、物理は `EnemyMotion` へ分離されている。2026-09-16 には enemy / protein 責務分離のリファクタリングも統合済み。

### 引き続き確認が必要

- **表示アンカー・銃口・命中点の座標契約:** 銃口と被弾は静止部位座標を基準にしている一方、表示は変形を持つため、統合テストで一致を保証する課題は残す。
- **Protein の基底クラス境界:** `ProteinEnemy extends Enemy extends CombatShipEntity` であり、旧 `Ship` への不要な継承は解消したが、Protein と金属敵の共通基底をどこまで持たせるかは別の設計判断として残る。
- **保存値の検証:** `ProteinCombatState.deserialize()` は定義に存在する部位・修飾へ写し直すが、数値範囲・cursor 等の不正値を全面的に拒否する検証は、この再監査では完了扱いにしない。
- **spawn gate の失敗・取消、編隊生成の原子性、表示時刻と姿勢の整合:** 旧 P2 群は解消を確認できていないため残件とする。

以下の旧チェックリストは **2026-09-12 時点の問題発見記録** として読む。


調査日: 2026-09-12

調査時点のHEAD: `4922f7403`

対象: `src/game/dynamic/dynamic-entity/`、`src/game/protein/`、敵機関連のHUD・Targeter・Spawner、Protein描画・衝突経路

備考: `DEVELOP/SPEC/` は現状調査のためには読まず、コードを正本として調査した。仕様の確認が必要な項目は「要仕様確認」として記載する。今回の調査では実装変更を行っていない。

## 高優先度の未完了タスク（掲示）

### P1 — Protein編隊の攻撃グループ識別を修正する

- [ ] `accent`を攻撃グループ識別子として使わず、`attackGroupId`などを導入する。
- [ ] 編隊所属敵は`formationId`単位、単独敵は明示的な単独グループ単位で攻撃数を数える。
- [ ] 複数Protein編隊を同時に生成し、編隊ごとに最大攻撃数が独立するテストを追加する。

根拠: [`Enemy.attackingCountInGroup`](../../src/game/dynamic/dynamic-entity/enemy.ts:381) は`accent`を比較するが、Proteinのエネルギー共有は[`formationId`](../../src/game/dynamic/dynamic-entity/protein-enemy.ts:39)を使う。Protein生成器は全個体へ`accent: 0xffffff`を設定している([`enemy-generator.ts`](../../src/game/stages/spawner/enemy-generator.ts:42))。

### P1 — Protein掃引衝突に回転を含める

- [ ] カスタム衝突形状の契約へ前回姿勢・現在姿勢を渡す。
- [ ] 回転中に球がProteinの球列を横切るケースを追加する。
- [ ] 姿勢補間を行うか、保守的な掃引形状として扱うかを決める。

根拠: [`ProteinEnemy`](../../src/game/dynamic/dynamic-entity/protein-enemy.ts:113) は常に現在の`this.att.q`を渡す。[`testSweptSphereCollision`](../../src/game/protein/protein-sphere-collision.ts:153) は位置を前後状態で扱う一方、姿勢は1つだけ受け取る。実際の姿勢更新は[`DynamicMotion`](../../src/game/dynamic/dynamic-motion.ts:335)で行われる。

### P1 — 表示アンカー、銃口、命中点の座標系を統一する

- [ ] Proteinの部位位置について、静的アンカーと変形後アンカーのどちらをゲーム上の正本にするか決める。
- [ ] `muzzlePosition`と`applyBulletDamage`を同じ座標モデルへ揃える。
- [ ] 表示マーカー、発射位置、命中部位が一致する統合テストを追加する。

根拠: [`ProteinEnemy.muzzlePosition`](../../src/game/dynamic/dynamic-entity/protein-enemy.ts:171) は空の変形配列を渡して静的座標を使う。一方、[`ProteinEnemyView.siteMarkers`](../../src/render/dynamic/dynamic-entity/protein-enemy-view.ts:98) は変形後アンカーを使う。既存テストでも静的座標と変形後アンカーが一致しないケースが確認されている([`protein-combat-state.test.ts`](../../tests/game/protein-combat-state.test.ts:260))。

### P0/P1 — `Ship`継承からProteinを切り離す方針を決める

- [ ] `Ship`を部品式機体の基底と、敵・Proteinが共有する機体／寿命の基底へ分ける。
- [ ] ProteinのHP・部位・攻撃状態の所有者を`ProteinCombatState`へ一本化する。
- [ ] 空実装の`initDefaultParts`、no-opの`hp`/`maxHp` setterをなくす。

根拠: [`Ship`](../../src/game/dynamic/dynamic-entity/ship.ts:52) は部品HP、燃料、推進、放熱、太陽電池、武器を前提とする。Proteinは[`ProteinEnemy`](../../src/game/dynamic/dynamic-entity/protein-enemy.ts:134)で部品初期化を空実装にし、HP setterも無効化している。これは継承契約を満たさない。

### P1 — `Enemy`からAI・戦闘反応・演出・セーブ・UIを分離する

- [ ] 射撃判断とバースト状態を射撃コントローラへ分離する。
- [ ] 被弾・死亡・焼失・衝突時のゲーム結果を反応コンポーネントへ分離する。
- [ ] HUD、マーカー、一覧、コンテキストメニューは既存の`EnemyInspection`を狭い入力契約で利用する。
- [ ] `Enemy`にはEntityの識別、ゲーム状態の接続、個体固有の戦闘能力だけを残す。

根拠: [`Enemy`](../../src/game/dynamic/dynamic-entity/enemy.ts:83) は557行、42依存を持ち、AI、弾生成、ダメージ、VFX、音声、StageOutcome、EntityRegistry、セーブ、マーカー、HUD選択UIを抱える。特に[`behave`](../../src/game/dynamic/dynamic-entity/enemy.ts:317)と[`firePlasma`](../../src/game/dynamic/dynamic-entity/enemy.ts:390)の責務が広い。

## バグ・不具合候補の一覧

### P1: `accent`による攻撃数上限の誤共有

`Enemy.attackingCountInGroup`は同じ`accent`の個体を一つの攻撃グループとして数える。しかし、`accent`は本来マーカー色であり、Protein編隊の所属を表さない。Protein編隊の全個体が白色なので、複数編隊が互いに攻撃枠を奪う。

エネルギー役の存在判定は`formationId`単位であるため、攻撃数制限とエネルギー制限の単位が異なっている。

### P1: 回転中のカスタム衝突判定が不正確

Proteinの球列は現在姿勢で固定され、掃引区間中の回転を表現していない。角速度が大きい敵では、球が実際には通過した場所を見落とす、または存在しない時点の形状で当たる可能性がある。

既存の[`protein-sphere-collision.test.ts`](../../tests/game/protein-sphere-collision.test.ts:73)は静止姿勢中心で、回転を含むEntity経路を検証していない。

### P1〜P2: 表示部位とゲーム上の攻撃座標がずれる

Viewは変形済み部位を表示するが、ゲーム側の銃口位置は静的部位位置を使う。命中点も現在姿勢・静的座標を前提に戻すため、照準している部位と実際に発射・命中する部位が視覚的に一致しない。

これは「表示側だけが変形を知っている」ことと「ゲーム側が描画側の低レベルアンカー関数を直接使う」ことの複合問題である。

### P2: 表示時刻の位置と現在時刻の姿勢が混在する

[`DynamicView.place`](../../src/render/dynamic/dynamic-view.ts:107)は位置を`displayTime`から取得するが、姿勢は現在値を使う。Protein部位マーカーも[`Targeter`](../../src/game/targeter.ts:220)で表示時刻の位置に現在姿勢を適用している。

過去・未来の表示窓では、機体本体、部位マーカー、変形アンカーの姿勢が一致しない。

### P2: 敵のプロパティ表示が時刻を混在させる

[`EnemyInspection.listDetail`](../../src/game/pickable/enemy-inspection.ts:55)は距離を表示時刻の位置から計算するが、速度は現在値を使う。さらに[`propertyRows`](../../src/game/pickable/enemy-inspection.ts:74)は`displayTime`を受け取るが、`relativeInfo`へ`simTime`を渡している。

表示窓を変更すると、一覧・マーカー・プロパティの距離が一致しない。

### P2: Protein編隊の出現が原子的でない

[`ManualSpawn.proteinFormation`](../../src/game/creative/manual-spawn.ts:73)は3体を独立したasset gateへ登録する。アセット取得完了のタイミングによって、attacker、shield、energyの出現順が変わる。

編隊の一部だけが先に存在すると、attackerが一時的に攻撃不能になる。また、Entity配列順によるAIの乱数消費順や接触解決順が変わる可能性がある。

### P2: Proteinアセット取得失敗時の永久待機

[`DynamicSystem`](../../src/game/dynamic/dynamic-system.ts:111)のpending spawnには、取得失敗・期限切れ・キャンセルの状態がない。失敗したProteinは永久に待機し、生成クロージャがSceneや音響・エフェクト依存を保持し続ける。

編隊の一部が欠落しても、失敗をゲームへ通知する経路がない。

### P2: 保存されたProtein戦闘状態を無検証で復元する

[`ProteinCombatState`のコンストラクタ](../../src/game/protein/protein-combat-state.ts:37)は、保存されたHP、フェーズ、部位状態、改造状態を直接採用する。静的アセット検証と保存データ検証は別の責務だが、保存側の復元検証がない。

壊れた保存データにより、HPと`disabled`の不整合、不正フェーズ、最大HP超過、負値、未知の改造状態が入り得る。

### P2: `empty`改造状態を暗黙に要求する

[`updateStructuralState`](../../src/game/protein/protein-combat-state.ts:228)はintegrityが下がると全改造スロットを`empty`にする。しかし[`validateProteinAsset`](../../src/game/protein/protein-schema.ts:224)は`empty`がstatesに含まれることを要求していない。

有効と判定されたアセットでも、構造損傷時の状態変更に失敗する可能性がある。

### P2: ダメージ倍率・改造効果の数値検証がない

[`ProteinSiteDefinition.damageMultiplier`](../../src/game/protein/protein-schema.ts:30)や改造効果の数値は、アセット検証で有限値・範囲を保証されていない。異常値により、負ダメージ、無限ダメージ、NaN化が起き得る。

### P2: Proteinの死亡演出が金属敵用のまま

[`Enemy.destroyEffect`](../../src/game/dynamic/dynamic-entity/enemy.ts:230)は全Enemyに汎用爆発・金属片フラグメントを適用する。Protein固有の破壊表現が必要なら、現在は責務がEnemy共通演出に埋め込まれている。

これは仕様確認が必要な候補であり、コード上はProteinも[`enemyDestroyFragments`](../../src/game/dynamic/dynamic-entity/debris-piece.ts:122)を使う。

### P2: 射程外・射撃無効化時のバースト継続

射撃不可判定が`canFire`由来の場合はバーストをクリアするが、`fireEnabled === false`または射程外の場合は残弾を保持する([`Enemy.behave`](../../src/game/dynamic/dynamic-entity/enemy.ts:325))。

射程外へ出て戻ると、残りのバーストを直ちに再開する。意図した挙動でなければ、射程外・射撃停止をバーストキャンセル条件へ追加する。

## 責任が重すぎるクラス

### `Enemy`

`Enemy`は次の責務を同時に持っている。

- 敵の識別、色、編隊、ウェーブ
- AIと射撃タイミング
- 見越し射撃、弾生成、マズル演出
- 被弾、衝突、焼失、死亡判定
- StageOutcomeへの結果記録
- EntityRegistryへの破片・弾の追加
- WorldSfx、FlashEffectsの呼び出し
- セーブデータ化
- マーカー、一覧、メニュー、プロパティ表示

これは「Enemyというゲーム上の主体が持つべき責務」を超え、アプリケーションサービス、Presenter、VFXオーケストレーターを内包している。

### `Ship`

`Ship`は部品HPのほかに、部品参照、燃料、放熱、発電、武器、推進、マーカーを持つ。440行程度のクラスに部品式機体全般の概念が集中している。

ProteinEnemyがこの基底を継承した結果、不要な契約を空実装で埋める状態になっている。

### `ProteinEnemy`

`ProteinEnemy`のコンストラクタは、アセット解決、戦闘状態、衝突形状、View、衝突コールバック、Enemy基底の配線を一度に行う。

個体の生成手順と、個体のゲーム状態・戦闘振る舞いが同じ場所に集まっている。`ProteinEnemyDefinition`の解決済みBundleを受け取るファクトリまたは生成境界を設ける余地がある。

## 責任が軽すぎるクラス／ラッパー候補

### `EnemyMotion` / `EnemyBehavior`

[`enemy-motion.ts`](../../src/game/dynamic/dynamic-entity/enemy-motion.ts:28)は反応を保持してDynamicMotionへ転送し、EnemyMotionは固定物性を渡す役割が中心である。

ただし、物理層とゲーム層の接触反応をつなぐアダプターとして名前付き責務がある。直ちに削除するのではなく、敵専用の差分が増えないなら反応ポートと物理プロファイルへ整理する程度が妥当である。

### `MetalEnemy`

[`MetalEnemy`](../../src/game/dynamic/dynamic-entity/metal-enemy.ts:38)は親クラスへの委譲が多いが、具体的な敵種とモデル、慣性、衝突半径、保存形式を接続する境界である。薄いことだけを理由に削除すべきではない。

### 薄いが妥当なクラス

以下は、単なる転送ではなく、意味のある資源・定義・ライフサイクルを持つため、現時点ではアンチパターンと判定しない。

- [`ProteinEnemyRegistry`](../../src/game/protein/protein-enemy-registry.ts:9): Protein意味情報と衝突球列の定義を束ねる。
- [`ProteinEnemyView`](../../src/render/dynamic/dynamic-entity/protein-enemy-view.ts:40): Proteinの描画資源、LOD、変形、マーカーアンカーを所有する。
- [`ProteinRuntime`](../../src/render/protein/protein-runtime.ts:33): GPU・描画ランタイム資源の寿命を所有する。
- [`ProteinRenderDefinition`](../../src/render/protein/protein-render-definition.ts:83): 表現種別ごとの構築・再色付け手順を持つ。

## DRYでない実装・重複した情報源

### Proteinアセットの解決経路

`ProteinEnemy`は同一`assetId`からゲーム用定義と描画用定義を個別に引く。`ProteinAssetLoader`もsemantic bundleとrender definitionのキャッシュを別々に持つ。

semanticとrenderを分けること自体は正しいが、ID解決・準備完了・エラー処理の責務が複数箇所に分散している。解決済みの不変Bundleを生成境界へ渡す設計が候補となる。

### `nextAttackSite()`の問い合わせと状態更新

[`ProteinCombatState.nextAttackSite`](../../src/game/protein/protein-combat-state.ts:77)は、サイトを返すと同時に攻撃カーソルを進める。

「読む」操作と「進める」操作を一つにすると、呼び出し回数や順序に依存する。`currentAttackSite`と`advanceAttackSite`へ分けるか、消費を明示した名前にするべきである。

### ゲーム側とView側の座標計算

`ProteinEnemy`と`ProteinRuntime`がそれぞれ`proteinSiteWorldPosition`を使い、片方は変形情報を持ち、片方は空配列を渡している。座標の計算規則は共有されているが、入力データの正本が分かれている。

## 密結合だが分離できる箇所

### Targeter・HUD・CreativeStageの`instanceof ProteinEnemy`

以下がProteinEnemyの具象型へ直接依存している。

- [`Targeter`](../../src/game/targeter.ts:159)
- [`TargetPanel`](../../src/game/hud/panels/target-panel.ts:52)
- [`CreativeStage`](../../src/game/creative/creative-stage.ts:84)
- [`protein-motion-metrics.ts`](../../src/game/protein/protein-motion-metrics.ts:28)

候補となる狭い能力契約:

- `ProteinTargetReadout`
- `ProteinSiteMarkerProvider`
- `ProteinDisplayController`
- `ProteinMotionMetricsSource`

消費側は「ProteinEnemyであるか」ではなく、「部位読み取り値を提供できるか」「表示設定を変更できるか」を見るべきである。

### `CombatTarget`が戦闘と表示を一つに持つ

[`CombatTarget`](../../src/game/dynamic/dynamic-entity/combat-target.ts:8)はHPだけでなくマーカー生成まで要求する。戦闘対象、HP、マーカー表示、地図表示は異なる能力なので、`CombatMarkerSource`などへ分けられる。

さらに[`isCombatTarget`](../../src/game/dynamic/dynamic-entity/combat-target.ts:20)は`combatTarget`フラグだけを見ており、`markerItem`などの実装存在を検証しない。将来のEntity追加時に実行時エラーを誘発しやすい。

### `EnemyInspection`の依存がまだ太い

`EnemyInspection`へ表示責務を移した点は正しいが、現在は`Enemy`全体を受け取る。Inspector専用の狭いsource契約にすれば、Enemyの内部変更が一覧・プロパティ・メニューへ伝播しにくくなる。

## コンポーネント設計上のアンチパターン

### 不要な継承契約を引き受ける

ProteinEnemyはShipの部品式契約を使わないのに継承している。空実装とno-op setterは、共通基底が共通能力ではなく、たまたま近い名前の集合になっている兆候である。

### 状態の正本が複数ある

ProteinのHPは`ProteinCombatState`が持つ一方、`Enemy`・`Ship`にもHP契約がある。表示設定や部位アンカーもEntityとViewの双方に関係する。

各状態について、以下を明確にする必要がある。

- 所有者
- 更新者
- 読み取り用の変換
- 保存・復元の境界

### エンティティが外部サービスを直接操作する

EnemyがWorldSfx、FlashEffects、StageOutcome、EntityRegistryを直接操作するため、戦闘ロジックのテストが外部サービスへ引きずられる。Enemyはゲーム結果や演出要求を狭いportへ通知し、composition rootまたは反応コンポーネントが具体サービスへ接続する方が分離しやすい。

### 生成クロージャによる時間的依存

`Enemy`のMotion生成時に、まだ完全に初期化されていないownerをクロージャへ捕捉している([`enemy.ts`](../../src/game/dynamic/dynamic-entity/enemy.ts:134))。現状はMotionのコールバックがEntity生成後に呼ばれる前提で成立しているが、初期化順序を暗黙に要求する設計である。

反応オブジェクトを生成後に接続する、またはEntity状態を参照する明示的なowner portへする方が安全である。

## 既に良い方向へ進んでいる点

- `EnemyInspection`がUI・一覧・プロパティをEnemy本体から外へ出している。
- `damage-capabilities.ts`に`PartDamageTarget`と`ProteinCombatTarget`があり、能力分離の足場がある。
- `ProteinCombatState`は戦闘状態を比較的独立して所有している。
- `ProteinEnemyRegistry`はsemantic定義と衝突球列を束ねている。
- `DynamicMotionBehavior`へ接触反応を注入しており、物理検出とゲーム上の帰結を分ける方向になっている。
- `EnemyDictionary`経由の復元は、具象Enemy間の実行時循環依存を避けるための妥当な境界である。

これらを捨てて全面的に汎用化するのではなく、現在の能力契約とadapterを狭くしていく方が安全である。

## 検証結果と未検証範囲

実行済み:

- `npm run test:game`: 197/197 成功
- `npm run test:render`: 199/199 成功
- `npm run dep-metrics`: 全体647ファイル、3505辺、値の循環成分2件

`npm run typecheck`は、今回の対象外である現ワークツリーの別変更に含まれる未使用importで失敗している。

- [`fire-control.ts:16`](../../src/game/player/fire-control.ts:16)
- [`player.ts:12`](../../src/game/player/player.ts:12)

未検証の重要ケース:

- 複数Protein編隊の同時射撃
- 回転中のProtein掃引衝突
- 実際のProteinEnemyの銃口位置と表示アンカー
- 変形中の部位への命中部位選択
- ProteinEnemyの保存・復元異常系
- Protein固有の破壊演出
- アセット取得失敗後のpending spawn
- 表示時刻を過去・未来へ移動したときの姿勢と部位マーカー

## 推奨する実装順

1. 攻撃グループ識別の修正と複数編隊テスト
2. 回転を含むProtein衝突契約とテスト
3. 表示アンカー・銃口・命中点の正本決定
4. ProteinをShip継承から切り離す設計変更
5. Enemyの射撃AI・死亡反応・UI検査の分離
6. `CombatTarget`と具象判定の能力契約化
7. 保存データ・アセット倍率・spawn失敗の検証
8. 表示時刻と姿勢履歴の整合化

先にクラスを細分化するのではなく、HP、攻撃サイト、表示アンカー、死亡反応、攻撃グループの正本を決めることが前提になる。正本が決まらない状態で分割すると、巨大クラスが小さな相互依存クラス群へ変わるだけである。
