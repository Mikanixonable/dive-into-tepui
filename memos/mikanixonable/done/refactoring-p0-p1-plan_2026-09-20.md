# リファクタリング実施計画: P0 / P1

> **状態 — 完了 / 2026-09-23 再監査:** PR #92（`refactor(game): P0-P1の所有境界を整理する`）で、ShipAssembly の導出分離、ModularShip / DynamicSystem の責務整理、入力・表示 phase の port 縮小、Celestial query の分離、CombatShip 等の命名整理が統合された。PR #94 で船体描画契約も game 状態から分離されたため、この文書は実施計画の履歴として `done/` に移す。未解決の構造課題は `DEVELOP/ARCHITECTURE.md` と現行コードから再調査する。


作成日: 2026-09-20  
起点ブランチ: `workspace3`  
起点コミット: `640099514`  
対象: ゲームコードの構造・命名・責務境界。仕様変更は含めない。

## 目的

現行コードを、次の変更に耐えられる構造へ段階的に整える。対象は単なる行数削減ではなく、
「誰が状態を所有し、誰が導出し、どの境界で命令と表示を渡すか」を明確にすることとする。

今回の調査では、以下をリファクタリング候補と判定した。

| 優先度 | 分野 | 判定根拠 | 目標 |
| --- | --- | --- | --- |
| P0 | `ShipAssembly` | 構造変更・状態所有・集計・検証・変換が1ファイルに並立している | 所有者を残し、純粋な型・変換・集計・検証を分離する |
| P0 | `ModularShip` | 物理反応、損傷、接触、燃焼喪失、ドッキング、描画適配、保存が密結合している | 船体所有者と接触・損傷結果の責務を分ける |
| P0 | `DynamicSystem` | エンティティの所有・寿命管理・シミュレーション・描画同期・保存が集中している | エンティティ寿命管理を専用所有者へ分離する |
| P1 | 入力・表示フェーズ | `Game` 全体への依存が広く、必要な値と命令の境界が見えにくい | 機能別の読み取り／命令ポートへ狭める |
| P1 | `CelestialSystem` | 天体索引・系判定・物理問い合わせ・描画リソース同期が同居している | 純粋な系問い合わせを描画所有者から分離する |
| P1 | ドメイン命名 | `Vessel`、`Ship`、`View`、`behave` が役割を想像しにくく、用語が衝突している | 正本の用語と役割を名前に反映する |
| P1 | 浅いラッパー | ただ1層下へ転送するだけの公開口が、所有者と利用者の境界を曖昧にしている | 意味のある境界は残し、偶然生じた転送口は削減・改名する |

## 変更しない振舞い

この計画は挙動保存のリファクタリングである。次を変更しない。

- 物理量、ECI 座標、時間積分、衝突・接触・損傷・燃焼・ドッキング・分離の結果。
- 同じ入力・同じ状態・同じ時刻から得られるシミュレーション結果の決定性。
- 入力の優先順位、ポーズ・オーバーレイ・ビュー切替・建造入力の遮断条件。
- `run.ts` が所有する入力解釈 → 進行 → 導出・同期 → 描画のフレーム順序。
- 表示対象、カメラ、軌道表示、HUD の見た目と表示タイミング。
- セーブの JSON 構造、版、保存・復元される項目と復元時の所有者。
- public API の意味。変更が必要な名前は全参照を同じコミット内で置換し、旧名の互換 alias は残さない。

SPEC は現状コードの説明書ではないため、今回の仕様変更を伴わない作業では更新しない。
`DEVELOP/CODING-RULE.md` と `DEVELOP/ARCHITECTURE.md` の「所有者が状態を書き、導出値は再計算し、
汎用 Context/Service 袋を作らない」という基準を採用する。

## 命名・責務の判定基準

### 浅いラッパー

- 所有者の意味を隠さず、単に同じ引数を渡すだけのメソッドは削除または呼び出し側を所有者へ移す。
- `GamePresentation`、`ShipInspection`、`CelestialSystem` のように、依存方向を固定する composition／表示境界や、
  read-only 契約を実現する façade は浅く見えても残す。
- 新しい `Context`、`Options`、`Services` の袋は作らない。新しいポートは1機能の具体的な読み取り・命令だけを持つ。

### 密結合・大きなクラス

- まず状態の所有者を特定し、所有権を移さずに純粋な導出、変換、検証、寿命管理のまとまりを抽出する。
- 抽出先は1つ以上の実質的なアルゴリズムまたは状態機械を持たせ、元クラスからの転送だけのラッパーにはしない。
- 保存・復元、生成・破棄、public read-only surface は元の所有者に残す。
- プレイヤー艦・敵艦・基地の将来仕様が一緒に変わる根拠がないものは共通化しない。

### 命名

- `CONTEXT.md` の正本用語である `ship` をドメイン名に使い、`vessel` を新しい正本用語として使わない。
- `View` は描画 View とゲームの操作フレームが衝突しないよう、後者を `MapFrame` / `CombatFrame` とする。
- per-frame の敵行動は `behave` ではなく `updateBehavior` とする。
- `Vessel` と `Ship` の意味の並立を解消し、敵・プレイヤー双方に共通する「戦闘可能な動的艦」には
  `CombatShipEntity` を用いる。
- `VesselPanel` など画面上の既存ラベルはプレイヤーに見える文言・CSS 契約であり、今回のドメイン命名置換では変更しない。

## 実施手順

### 0. 計画・基準点を確定する

目的: この計画を `memos/mikanixonable` に残し、既存の利用者変更を巻き込まずに作業を開始する。

対象:

- 本計画ファイルのみを `workspace3` で明示的にコミットする。
- 既存の `src/game/pickable/*`、`src/physics/*`、`.gemini/`、`.earth-surface/*` の変更は触らない。
- `codex/refactor-p0-p1-20260920` を専用 worktree `/Users/pandeaconica/lab/dive-into-tepui-refactor-p0-p1-20260920` に作る。

受入条件:

- 計画コミットに対象外の変更が入っていない。
- worktree 作成前後で `workspace3` の既存変更が保存されている。

### 1. P0: `ShipAssembly` の純粋計算を分離する

目的: 接続グラフを所有する `ShipAssembly` と、状態を変更しない型・変換・集計・検証を分け、
構造変更の所有者を曖昧にしない。

予定ファイル:

- `src/game/ship/ship-assembly.ts`
- `src/game/ship/ship-assembly-types.ts`
- `src/game/ship/ship-assembly-transform.ts`
- `src/game/ship/ship-assembly-totals.ts`
- `src/game/ship/ship-assembly-validation.ts`
- 既存の `tests/game/ship-assembly*.test.ts`

実施:

- assembly の型と内部ノード型を整理する。
- transform の有限値検査、正規化、side slot 変換を純粋モジュールへ移す。
- totals と validation のアルゴリズムを純粋関数へ移す。
- `ShipAssembly` は nodes/connections の生成・変更・複製・保存形状の所有者として残し、上記関数を呼ぶ。

受入・検証:

- assembly の public API、接続順、transform、集計値、検証エラー、保存形状が変わらない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 2. P0: `ModularShip` の接触・損傷反応を分離する

目的: 艦の所有者である `ModularShip` から、接触結果・損傷配分・構造喪失・燃焼喪失の状態機械を分ける。

予定ファイル:

- `src/game/ship/modular-ship.ts`
- `src/game/ship/modular-ship-reactions.ts`
- `src/game/dynamic/dynamic-entity/contact.ts`
- `src/game/dynamic/dynamic-entity/contact-damage.ts`
- `src/game/dynamic/dynamic-entity/bullet-reaction.ts`
- 関連する `tests/game/ship-*.test.ts`、`tests/game/player-systems.test.ts`

実施:

- 接触種別ごとの結果適用、損傷・熱・構造喪失・イベント発行を `ModularShipReactions` に集約する。
- `ModularShip` は assembly、motion、effects、registry と自身の派生状態を所有し、反応器へ狭い明示ポートを渡す。
- 既存の物理 callback は反応器の意味ある処理へ接続し、同じ処理を `ModularShip` に転送するだけの private wrapper は除く。

受入・検証:

- 接触、弾丸、放熱、燃焼、構造喪失、死亡・イベントの順序と値が変わらない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 3. P0: `DynamicSystem` の寿命管理を分離する

目的: エンティティの追加・保留・materialize・上限・prune・破棄・registry と、シミュレータの進行、
描画同期を分離する。既存の `src/game/dynamic/entity-lifecycle.ts` が担える実装を優先して再利用する。

予定ファイル:

- `src/game/dynamic/dynamic-system.ts`
- `src/game/dynamic/entity-lifecycle.ts`
- `src/game/dynamic/entity-registry.ts`
- `src/game/dynamic/entity-roster.ts`
- `src/game/dynamic/dynamic-simulation-participant.ts`
- `src/game/dynamic/dynamic-presenter.ts`

実施:

- `EntityLifecycle` をエンティティ collection の単一 writer とし、DynamicSystem は simulation root として phase 順、
  Simulator、Presenter、public read-only 契約を束ねる。
- spawn history、ID allocator、pending entity、上限処理、cleanup/dispose、entity serialization の所有者を明示する。
- `sync` の render pool 宣言は presentation 側に残し、progress と viewer の依存を逆流させない。

受入・検証:

- entity の順序、ID、spawn/prune、simTime、pause、serialize/deserialize、render sync のタイミングが変わらない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 4. P1: 入力・表示フェーズを機能別ポートへ狭める

目的: `GamePresentation` を composition root として残しつつ、各 phase が `Game` 全体を読む密結合を解消する。

予定ファイル:

- `src/game/input/game-input-ports.ts`
- `src/game/input/game-input-router.ts`
- `src/game/game-presentation.ts`
- `src/game/display-window-manager.ts`
- `src/game/view/*`

実施:

- 入力側は速度適用可否、active controllable、stage 状態など、操作 feature が必要とする値・命令だけの port を定義する。
- 表示側は simTime、active controllable、recent events、celestial query、nav target だけの read port を定義する。
- `GamePresentation` は port を組み立てる composition root として残し、汎用 `GameContext` は作らない。
- フレーム順、入力優先順位、view の切替条件は変更しない。

受入・検証:

- phase 実装が `Game` の全体型へ依存しない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 5. P1: `CelestialSystem` の問い合わせと描画所有を分離する

目的: 天体の系所属・親子階層・同一系判定のアルゴリズムを、Three.js の描画リソースを所有するクラスから分離する。

予定ファイル:

- `src/game/celestial/celestial-system.ts`
- `src/game/celestial/celestial-system-query.ts`
- `src/game/celestial/celestial-bodies.ts`
- `tests/game/map-visibility.test.ts` および天体・viewer の関連テスト

実施:

- 純粋な ordered entities、ancestors、same-system、focused-system 判定、parent/chain 問い合わせを query module に移す。
- index の生成と render resource の build/sync/dispose は `CelestialSystem` に残す。
- query module から render 層を import しない。

受入・検証:

- 地球系・恒星系・孤立・循環定義・ラグランジュ点・sticky margin の結果が変わらない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 6. P1: ドメイン命名と偶然の転送口を整理する

目的: 呼び出し側が処理内容を想像でき、`CONTEXT.md` の用語とコードが一致する状態にする。

予定ファイル:

- `src/game/dynamic/dynamic-entity/vessel.ts` → `combat-ship-entity.ts`
- `src/game/dynamic/dynamic-entity/enemy.ts`
- `src/game/dynamic/dynamic-entity/enemy-fire-controller.ts`
- `src/game/dynamic/dynamic-system.ts`
- `src/game/view/map-view.ts` → `map-frame.ts`
- `src/game/view/combat-view.ts` → `combat-frame.ts`
- 参照元と関連テスト

実施:

- `Vessel` を `CombatShipEntity` に置換し、正本用語でない新規 `vessel` identifier を残さない。
- `MapView` / `CombatView` を `MapFrame` / `CombatFrame` に置換する。HUD の user-facing `VesselPanel` 文言・CSS は変更しない。
- 敵行動 API の `behave` を `updateBehavior` へ改名し、単に名前だけが変わった旧 alias は残さない。
- 同一の物理定数が別ファイルへ重複している場合は、プレイヤー・敵の将来仕様を同時に変更すべき定数だけを
  明示的な共有定数へ移す。調整値の共通化はしない。
- adapter／facade が本当に表示境界や read-only 契約を提供しているかを確認し、意味のない一段転送だけを削る。

受入・検証:

- `rg` で対象コードの旧 identifier、旧 `behave`、旧 frame class の参照が残っていない。
- UI の表示文言、入力、敵行動、マップ・戦闘ビュー切替に変化がない。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。

### 7. 最終監査・統合・削除

目的: 構造変更を自己レビューし、`workspace3` に安全に統合して作業用 worktree を消す。

受入・検証:

- 変更 diff に仕様変更、無関係なファイル、対象外の既存変更がない。
- `npm run lint`、`npm run typecheck`、`npm run check:boundaries`、`npm run test:game` を実施する。
- `src/render` を変更した場合だけ `npm run test:render` も実施する。今回の計画では render 実装は変更しない。
- worktree の各コミットを `workspace3` へ統合し、統合後の `workspace3` が統合前の HEAD から進んでいることを確認する。
- 統合コミット成功後に作業用 worktree と一時ブランチを削除する。既存 worktree は削除しない。

## 見積り

- 計画コミット: 1件。
- 実装コミット: 手順1〜6を各1件以上、構造変更と命名置換が混ざる場合は分割する。
- 各実装単位の最低検証: `typecheck` 1回 + `test:game` 1回 + `check:boundaries` 1回。
- 最終検証: `lint`、`typecheck`、`check:boundaries`、`test:game`。render 層を触った場合のみ render 回帰を追加する。
- 最大の不確実性は `ModularShip` の接触 callback と `DynamicSystem` の既存 lifecycle の実装差分であり、そこでは先に型と所有権を確認してから抽出する。

## リスクと戻し方

| リスク | 検知 | 対応 |
| --- | --- | --- |
| callback 初期化順が変わる | typecheck、game test、constructor 経路のレビュー | callback は owner の公開状態ではなく、生成後に確定した狭い port へ接続する |
| 保存形状が変わる | ship/save test、serialize diff | serialize/deserialize は既存 owner に残し、形状を比較する |
| 入力順が変わる | input routing test、phase diff | `run.ts` の順序と priority を触らない |
| P1 の命名が UI/CSS と衝突する | `rg`、build/typecheck | ドメイン identifier だけを置換し、user-facing panel label は変更しない |
| 抽出が新たな浅い wrapper を生む | 差分レビュー、fan-in/fan-out 再計測 | 純粋アルゴリズムまたは状態所有が移っていない分割は戻す |
| 既存の未コミット変更と衝突する | 統合前の status/diff、cherry-pick | 既存変更を stage/commit/削除せず、競合箇所は対象外の変更を保持して解決する |

## 完了基準

P0/P1 の全手順を実装し、対象の候補が「調査済み」から「責務・命名・検証基準を満たした変更済み」へ移ること。
未解決の既存 smell は、今回の変更が原因でないものだけを最終報告へ残す。
