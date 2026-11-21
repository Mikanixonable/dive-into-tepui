# コードベース構造調査(2026-11-21)

src/ 全領域(約870ファイル)をサブエージェント9分割で読破し、各ファイルの責務と
「まとめられる箇所・改名すべきもの・移動すべき関数」を洗い出した結果。
調査時点 HEAD 付近のスナップショット。実施済みの修正は各節末に追記する。

## 前提: 直前に実施済みの整理

- `src/hud`→`src/hud-kit`、`src/input`→`src/input-devices`、`src/marker`→`src/marker-kit`
- `dynamic-entity`/`celestial-entity` 二重名 → `entity/`(4箇所)
- `game/combat`・`lines`・`relic`・`alarm` → `game/`、`game/stages/spawner` → `game/stages/`
- `game/runtime` → `src/run/`(ただし後述のとおり巻き戻し検討あり)

## 1. 層の置き場違反(最優先)

### model↔render の逆流

- `render/assembly/assembly-shape.ts` — THREE非依存の seed→形状生成。`game/` 側4箇所が
  モデル層として消費しており render→game の逆流。**`game/assembly/` へ移すのが筋**
- `game/assembly/` — 中身は「敵の組み立て」で `ship/ship-assembly` と同語衝突。
  `enemy-assembly` 等への改名 + assembly-shape と同居させる案
- `game/ship/ship-construction-view.ts` — game 層に居ながら render の View を生成・所有
- `game/ship/modular-ship.ts` — コンストラクタで `ModularShipDynamicView` を直接 new

### physics/math へ移せる純粋モジュール

- `game/dynamic/attractors.ts` → `physics/attractor.ts` へ統合(同名近義・game依存ゼロ)
- `game/dynamic/sphere-chain-collision.ts` → `physics/` or `game/assembly/`(game型非依存)
- `game/plan/arc-range.ts` → `physics/`(DynamicTrajectory のクリップのみ)
- `game/celestial/reference-frames.ts` → `physics/`(依存は math/physics のみ)
- `game/celestial/gravitational-constant.ts` → `physics/`(3行の物理定数)
- `game/navigation/terminal-rendezvous.ts` の LVLH/CW 計算部 → `physics/relative-motion` 近辺
- `physics/occlusion.ts` → `math/` or `game/marker/`(消費者は UI/marker 系のみ)
- `physics/time-ring.ts` → `math/`(物理非依存の汎用リング)

### game/ship 側へ寄せるべきもの

- `physics/player-shape.ts` — 自機部品の寸法定数。物理でなく game/render が利用
- `physics/ship-panel-layout.ts` — player-shape 依存・利用は game/render
- `game/dynamic/entity/ship-default-parts.ts` — ship カタログ参照の敵部品工場
- `game/celestial/body-reveal.ts` — 天体でなくステージ進行の規則 → `stages/`
- `game/celestial/planet-distance.ts` — マップフェード規則 → `map/`

### DOM パネルがモデル層にある(「盤面を映すパネルは game/hud」違反)

- `game/plan/plan-panel.ts` → `game/hud/`
- `game/navigation/navigation-command-window.ts` → `game/hud/windows/`
- `game/stages/stage-utils/status-panel.ts` → `game/hud/panels/`
- `game/creative/` の DOM UI 5ファイル(object-placer-panel/両セクション/slider-field/
  stage-controls-panel) — creative 専用 UI として閉じるか hud/ 寄りか要判断。
  `stage-controls-panel` の `EnemySpawnShape` 型を commands が import する逆流もある

### hud-kit へ移せる汎用部品

- `game/hud/sync-throttle.ts`(6箇所利用)
- `game/hud/frame/tile-strip.ts`
- `game/hud/orbit/chart-canvas.ts`・`orbit-chart.ts`(自称「汎用エンジン」)
- `panels/guide-value-field.ts` の buildValueField/buildColorField 部
- `panel-chrome.ts` の外枠部

### その他

- `launcher/title-scene.ts` — WebGPURenderer を launcher が直接所有(443行) → render/ 側
- `launcher/save-browser/save-browser.ts` — `solarSystemBodyName` import。
  「launcher が画面のために game/ を見ない」違反の疑い → SnapshotMeta に表示名を保存
- `run/game-input-phase.ts`・`run/display-phase.ts` — 呼び出し主が
  `game/game-presentation.ts` のみで、中身は表示の導出の内部部品。
  **game/ 側へ戻すほうが実態に合う**(game/runtime→src/run の移動は誤りだった可能性)
- `game/hud/windows/menu-actions.ts` — 17ファイルが参照する game 横断語彙。
  `game/menu-actions.ts` へ
- `hud-kit/style/layout-tokens.ts` と `game/hud/style/layout-tokens.ts` — 同名2件(用途別)

## 2. 改名候補

| ファイル | 改名案 | 理由 |
|---|---|---|
| `hud-kit/alarm-level.ts` | `alarm-level-ui.ts` | game/alarm-level と同名・別概念 |
| `hud-kit/viewport.ts` | `visual-viewport.ts` | render/viewport と同名・別概念 |
| `celestial/entity/celestial-entity-def.ts` | `celestial-class.ts` | "def"だが分類だけ |
| `pickable/line-pickables.ts` | `line-pickable-set.ts` | line-pickable と単複紛らわしい |
| `pickable/object-pickables.ts` | `object-pickable-set.ts` | 同上 |
| `player/belt.ts` | `belt-controller.ts` | クラス BeltController と不一致 |
| `marker/ship-marker-renderer.ts` | `ship-marker-svg.ts` | 中身は SVG 生成 |
| `plan/plan-node-rules.ts` | `plan-node-execution.ts` | 実行消化ロジック |
| `view/hud-selection.ts` | `view-preferences.ts` | view/ の表示選択値 |
| `stages/enemy-spawner.ts` | `stage2-cluster.ts` | stage2専用クラスタ配置 |
| `ship/construction-entry.ts` | `ship-construction-entry.ts` | 族の命名規則外 |
| `ship/salvage-blueprints.ts` | `ship-salvage-blueprints.ts` | 同上+2責務混在 |
| `render/dynamic/entity/ejected-gun-part-view.ts` | `magazine-frame-view.ts` | export は MagazineFrameView |
| `render/dynamic/baked-model.ts` | `model-template.ts` | clone/memo ユーティリティ |
| `hud/style/predict-panel-style.ts` | `display-timeline-panel-style.ts` | 「predict」は旧名(DOM id も) |
| `launcher/save-browser/shared.ts` | `save-browser-ui.ts` | 内容を表さない |
| `physics/orbit-solvers.ts` | `equator-crossings.ts` | EqAN/EqDN のみ |
| `hud/ammo-status.ts` | `ammo-view-model.ts` | ViewModel+formatter |
| `hud/object-groups.ts` | `object-picker-groups.ts` | ObjectPicker 用の分類 |
| `hud/frame/frame-panel.ts` | `panel-shell.ts` | map-frame-panel と紛らわしい |
| `panels/guide-kind-def.ts` | `orbit-guide-kind-defs.ts` | 族名に合わせる |
| `style/combat-panel-rows-style.ts` | `vessel-burn-panels-style.ts` | 中身は vessel/burn+map規則 |
| `celestial/solar-system/point-field.ts` | `small-body-fields.ts` | 名が漠然 |
| `navigation/orbit-slot-source.ts` | `orbit-slot-builders.ts` | 名が漠然 |
| `earth-weather/cyclone-tracks.ts` | `cyclone-placements` 系 | 吸収込み統合配置に名が弱い |

## 3. 統合候補

### 重複ロジック(共通化)

- **`ship-construction-preview.ts` の tryConstructionPlacement × `-edits.ts` の place** —
  接ぎ木適用ロジックが丸ごと重複。乖離バグの温床、最優先
- **`player/power.ts` × `player/radiator.ts`** — 展開パネル管理(Map/key/toggle/serialize/
  legacy移行)がほぼ同型。「モジュールID連動パネル集合」の共通抽象へ
- **回転座標系構築 ×3** — orbit-guide-model / zero-velocity-model / orbit-slot-family
- `stage-records.ts` × `unlock-manager.ts` — try/catch JSON localStorage + normalizeStageId
- `context-menu` × `object-picker` × `property-window-items` — 項目行+ショートカット配送
- `segmented-control.ts` × `tab-bar.ts` — ボタンMap/setItems/setSelected が同型
- `ScaleField`(orbit-analysis-tab) × `buildValueField`(guide-value-field)
- 窓台帳パターン ×3 — module-windows/object-windows/orbit-line-windows
- `inject-style.ts`(hud-kit) × marker-structure-style の自前注入 — 中立置き場へ
- パネル見出し/外枠 ×4 — buildPanel/PanelChrome/view-options独自/orbital-object独自

### 薄いファイルの畳み込み

- `entity/contact.ts` + `contact-damage.ts`(相互依存・各20行)
- `entity/damage-capabilities.ts` → `part-damage-model.ts`(実装1箇所のみ)
- `entity/enemy-attack-group.ts` → `enemy-fire-controller.ts`(呼び先1箇所の17行)
- `input/game-commands.ts` + `game-actions.ts` → `game-input-types.ts`
- `marker-kit/marker-visibility.ts` + `marker-sink.ts`
- `player/ammo-spec.ts`(3行)→`weapon-state.ts`、`player-plan-settings.ts`(10行)
- `ship-docking`/`ship-decoupling`/`ship-repair` → connection-operations 系へ
- `entity-roster.ts`(11行)→`entity-registry.ts`、`trajectory-demand.ts`→`predictor.ts`
- `command-completion.ts` → `command-queue.ts`
- `camera/screen-ray.ts`(8行) → `camera-system.ts`
- `view/view-mode.ts`(2行) → `view-frame.ts` 案(共有型アンカーとして残す判断もあり)
- render薄い群: entity-visual-settings→dynamic-view、casing-style→casing-view、
  hermite-curve→curve、projectile-orientation→bullet-view、standard-node-material→thermal-emissive
- earth-surface-format/errors/decode-response → codec 側へ
- hud-kit小物DOM群(key-cap/state-pip/instrument-row/readout/shortcut-hint)を1ファイルへ
- `ship/module-windows.ts` の接舷候補評価 → `ship/ship-docking` 側寄りの知識
- `lead-markers.ts` の三尖星SVG → `marker-shapes.ts` へ
- `equator-node-marker` × `relative-node-marker` — ほぼ同型(テーブル駆動化で統合可能)

### 構造整理

- `render/earth-surface-*.ts` **19ファイルが直下に平置き** → `earth-surface/` へ集約
- render直下の浮きファイル: `celestial-*`(texture/albedo/grid)、`stars.ts`、
  `aurora-field.ts` → `celestial/`、`camera-scale.ts` → `camera/`、
  `line-style.ts` → `lines/`、`shadow-demand.ts` → `pipeline/shadow/`、
  `schematic-thrust-cone.ts` → `dynamic/player/`、
  `opaque-cloud-surface-renderer.ts` → `earth-weather/cloud/` or `pipeline/`

## 4. 分割候補(大きすぎ・複数責務)

| ファイル | 行数 | 切り目 |
|---|---|---|
| `ship/ship-construction.ts` | 1029 | 設計図・履歴・コマンドを -blueprints/-commands へ |
| `ship/modular-ship.ts` | 731 | マーカー組立・renderSource・ブースター |
| `game-presentation.ts` | 705 | sync の3ブロック |
| `dynamic/dynamic-motion.ts` | 685 | Behavior/Properties/ContactKind → -behavior |
| `input-devices/input.ts` | 640 | キーボード/ポインタ/ドラッグ簿記の3分割 |
| `audio/sfx/world-sfx.ts` | 551 | ワンショット12レシピを別ファイルへ |
| `viewer/focus-camera-selection.ts` | 573 | 直列化・入力・追従を分離 |
| `physics/transfer-planner.ts` | 521 | 4系統の遷移方式で分割 |
| `physics/capped-cylinder-contact.ts` | 507 | GJK/EPA汎用部と円柱固有部 |
| `physics/celestial-motion.ts` | 505 | 星/惑星/衛星の3実装 |
| `math/triangle-mesh.ts` | - | BVH構築/走査/narrow-phase |
| `stages/stage.ts` | 476 | 遺物観測→stage-relics、鹵獲→stage-salvage |
| `stage-utils/wave-attack.ts` | 385 | フェーズ機械と generateWave |
| `hud/orbit-guide-tab.ts` | 555 | 系トグル部と種別行部 |
| `hud/hud-dom.ts` | 559 | 見出し行の組み方の統一 |
| `map-frame-panel.ts` | 456 | 中心タイル/ラグランジュ行/回転候補 |
| `hud-kit/windows/pause-menu.ts` | 365 | 一時停止タブの中身を別ファイルへ |
| `launcher/stage-select.ts` | 414 | TITLE_FLAVORS データ(140行)→title-flavors.ts |
| `targeter.ts` | 298 | ターゲット選定 vs マーカー同期 → target-markers |
| `creative/object-placement.ts` | 389 | 状態組立・プレビューを分離 |
| `pickup.ts` | 332 | 表示要素の組み立て → pickable アダプタ |

## 5. デッドコード・残骸

- `physics/impulsive-transfer.ts` — src内 importer ゼロ。biElliptic も重複
- `ShipCapabilities.toggleDeployable` — テスト以外から呼ばれない
- `cloneShipModuleInstance` — 全分岐が `{...instance}` の無意味な switch
- `main.ts` L124-127 — 「このコミットは巻き戻す」明記の CI 用 smokeFrames が残存
- `render/dynamic/metal-f0.ts` — src内利用者なし(tools/model-builder 専用)
- 残骸コメント: `rings.ts` L96、`satellite-orbit-builders.ts` L68(文が切れたまま)、
  改名後も `hud/` を指す旧パスコメント3件
- `combat-target.ts` の `markerItem` — interface 5引数 vs Enemy実装4引数
- `graphics-panel.ts` × `settings-view-style.ts` — `.gp-*` 二重定義
- `DRAG_COEFFICIENT = 2.2` の二重定義(dynamic-motion / dynamic-motion-thermal)
- `entity-contact-physics.ts` に埋まる薬莢ポリシー定数(LOD距離・ペア上限)
- `celestial/entity/celestial-view.ts` 等の `../../../render/` 迂遠パス
- `earth-surface-tile-projection.ts` — export クラス名は EarthSurfaceView(不一致)

## 優先度(提案)

1. 層違反の移動(§1) 2. 重複共通化(§3上) 3. 改名一括(§2) 4. デッドコード(§5)
5. 大分割(§4)は別計画として切り出し推奨

## 実施結果(2026-11-21)

調査の指摘を以下のコミットで実施した。検証は typecheck / check:boundaries /
test:game(549) / test:physics(510) / test:render が全て通過。

| コミット | 対応節 |
|---|---|
| `944939deb` 層を越える置き場違反 | §1: assembly-shape→game、`enemy-assembly` 新設、attractors→physics、body-reveal→stages、planet-distance→map、plan-panel/navigation-command-window/status-panel→game/hud、menu-actions→game/、sync-throttle/tile-strip/orbit-chart→hud-kit、time-ring→math、title-scene→render、phase 2ファイル→game/(runtime→run の巻き戻し)、save-browser の game 依存除去(SnapshotMeta に表示名)、EnemySpawnShape 逆流解消(形状表→manual-spawn)、LVLH/CW→physics/relative-motion |
| `ee3095f2c` tests 追随 | attractors 移動に伴うテスト参照 |
| 改名コミット | §2 表の改名を全量実施 |
| `a216e0a5e` 薄いファイル畳み込み | §3: contact/contact-damage、damage-capabilities、enemy-attack-group、game-input-types、marker-visibility、ammo-spec(後述で復元)、ship-docking/-decoupling/-repair→ship-connection-rules、entity-roster/trajectory-demand/command-completion/screen-ray、render薄い群、earth-surface codec群、hud-kit小物DOM群→dom-elements、earth-surface 19ファイル→earth-surface/、render直下浮きファイル→対応サブディレクトリ |
| `aa25534c4` `1412281a6` 重複共通化 | §3上: preview×edits→ship-construction-apply、power×radiator→deployable-panel-set、stage-records×unlock-manager→stage-keyed-storage、窓台帳×3→window-ledger、injectOnce 共有化、回転座標系 μ 計算→lagrange helper、reachableModuleIds→graft |
| `ab1558c65` デッドコード | §5: impulsive-transfer 削除、toggleDeployable 削除、cloneShipModuleInstance 単純化、smokeFrames コメント実態化、残骸コメント削除 |
| `f84c0d924` DynamicMotion 型分離 | §4 の1件: ContactKind/Behavior/Properties→dynamic-motion-behavior(-collision/-thermal の既存パターンに追随) |

### 意図的に変更しなかったもの(再調査で却下)

- `physics/ammo-spec.ts` 畳み込み — 一度畳み込んだが、import を持たない定数語彙として
  render 側装置が game 層を引かないよう定義層の役割を持つことが判明し復元
- `SegmentedControl`×`TabBar` — ARIA 役割と引数が違い、見た目ほど同型ではない
- `buildValueField` の hud-kit 化 — CSS クラス名が orbit-guide 専用で、汎用部品にすると
  game の見た目名が hud-kit へ漏れる
- editorial 系パネル外枠(buildPanel/PanelChrome) — 意図的に別マークアップを持つ
- `physics/occlusion.ts` — CelestialBody を引く純幾何で physics 置き場として妥当
- `physics/player-shape.ts` / `ship-panel-layout.ts` — 「物理判定・配置・描画で共有」の
  定義語彙として physics 置き場が機能している
- `metal-f0.ts` — tools/model-builder の焼き込み入力。tools パス直結のため移動は別検討
- `markerItem` 4引数実装 — TS の実装側省略は合法(interface 不変)
- `.gp-*` — 一時停止メニューと HUD で別スコープの意図的な再定義

### §4 残件(別計画へ)

大分割はレビューが重いため1件のみ実施し、残りは切り目を確定した状態で別計画へ。
優先度案: `ship-construction.ts`(1029行・-blueprints/-commands) >
`modular-ship.ts`(マーカー組立/renderSource/ブースター) >
`game-presentation.ts`(sync 3ブロック) > `input.ts`(装置3分割) >
`world-sfx.ts`(ワンショットレシピ — 音声作業中のため最後)。

### 追加実施(2026-11-21 続)

- `7cd5db06a` — 残件一括: 赤道・相対ノードマーカーを `node-marker.ts` の NodeMarker
  基底へ統合(§3 equator×relative)、三尖星 SVG を `marker-shapes.ts` の `leadMarkerSvg` へ、
  `DRAG_COEFFICIENT` 二重定義を dynamic-motion-thermal の export へ一元化、
  `metal-f0.ts` を tools/model-builder へ移動(§5)
- §4: `ship-construction.ts` を分割 — 命令列・取り消し履歴を
  `ship-construction-commands.ts`(ShipConstructionCommands)、設計図操作を
  `ship-construction-blueprints.ts`(ShipConstructionBlueprints)へ。pointer と同じく
  本体が狭い host 面を実装する生成時コラボレータ。1029→907行
- §4: `modular-ship.ts` を分割 — マーカー組立を `modular-ship-markers.ts`、
  renderSource 合成を `modular-ship-render-source.ts`、ブースター燃焼と燃焼管理
  表示モデルを `modular-ship-boosters.ts` へ。731→621行
- §4: `game-presentation.ts` は分割見送り — sync ブロックは約50フィールドの
  配線を横断する呼び出し順の連結で、port 化すると結合が増える。このファイルは
  表示の導出の配線の根として据える。代わりに積雲段のシェーダ事前コンパイルを
  render 層の `precompileCumulusDetails` へ移動(`677504201`)
- §4: `input.ts` を部分分割 — キーボード追跡を `keyboard-tracker.ts` の
  KeyboardTracker へ(640→598行)。ポインタ/ドラッグ帳簿は状態機械が相互に
  書き合うため分離せず据え置き
- §4: `world-sfx.ts`(551行) は未実施 — 音声調整の作業中のため最後尾のまま据え置き
- PR #206 として workspace3 の蓄積変更を main へ送出済み(分割コミットも push)

### 未実施の判断待ち(§1 残件)

- `modular-ship.ts` / `ship-construction-view.ts` が View を直接 new — モデル層が装置を
  所有する構造そのものの見直し(presentation-ports 経由の注入)が要り、機械的移動ではない
- `game/creative/` の DOM UI 3ファイル — creative 専用 UI として閉じるか hud 寄りか
- `game/dynamic/entity/ship-default-parts.ts` — entity 配下のままか ship 側か
- `hud-kit/style/layout-tokens.ts` × `game/hud/style/layout-tokens.ts` 同名2件
