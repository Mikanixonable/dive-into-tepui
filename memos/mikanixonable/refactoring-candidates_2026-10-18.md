# リファクタリング候補の探索結果 — 2026-10-18

コードベース全般のリファクタリング候補を探索した棚卸し。実装計画ではなく調査報告。
判定基準は `DEVELOP/CODING-RULE.md` と `DEVELOP/ARCHITECTURE.md`。
スナップショット時点: `31b2e9dae`(workspace3)。

## 機械的な状態

- `npm run check:boundaries`: **違反 0** / 許可リスト空 — 層と境界は健全。
- `npm run lint` 相当: **error 0**、warning 22 件(すべて `max-lines`/`max-lines-per-function`
  の診断入口)。
- `eslint-suppressions.json`: `| undefined` union(`no-restricted-syntax`)の抑制が
  **src/ 59ファイル・約90箇所**。`.d.ts` shim の `export default` 5件は webpack アセット用で正当。

## Tier 1: 確度の高い小修正

| 箇所 | 内容 |
| --- | --- |
| `src/game/ship/ship-assembly.ts` ~L219-220 | `if (transform === null) throw new Error('missing module transform: ...')` が2連続で重複。片方は dead code |
| `src/game/dynamic/dynamic-motion.ts` L431-432 | 同一コメント行(`// dt を大気突入の刻み幅…`)が2連続で重複 |
| `src/game/pickable/entity-inspection.ts` | **import 元ゼロのデッドコード**。`memos/hedalu244/reduce_implement.md` でも「`InspectedObject` と `MenuAction` が同じ役目」と不採用記録済み → ファイルごと削除 |
| `src/render/dynamic/dynamic-entity/pickup-view.ts` | `AmmoPickupView`/`RcsFuelPickupView` はアセットだけが違うサブクラス。CODING-RULE 1.2「切り替わるのがアセットだけなら型で分けない」に該当 → `PickupView` 1クラスへ畳み、モデルをコンストラクタ引数へ |
| `src/physics/time/index.ts` | 単一ファイルのディレクトリ + index.ts 名の実装モジュール + 冒頭コメントが英語(3.1 日本語統一違反)→ `src/physics/time.ts` へ移せば `from '.../physics/time'` の import 12箇所は無変更で動く |

## Tier 2: 重複実装の共通化(高確度)

1. **画面ラベルの NDC→スクリーン投影** — `src/render/celestial-grid.ts`(~L171,L209-215,L266-274)
   と `src/render/scale-grid.ts`(L107-115,L160-172)で「`project` → `z` 範囲外を捨てる →
   `(v.x*0.5+0.5)*w` 等で変換 → margin クランプ → `style.left/top`」がほぼ完全一致。線生成
   ヘルパー(`markOverlay`+`frustumCulled=false`+`LineBasicMaterial`)も同型。**付随違反**:
   `zIndex:'8'`/`font:'10px monospace'`/`textShadow` の直書きは CODING-RULE 1.12 違反。
   置き場は `math/projection.ts` の `ndcToScreen` 利用か、render/ 内の DOM ラベル部品。

2. **COM ↔ assembly ルートの剛体変換** — `sub(state.r, qRotate(att.q, centerOffset))` 系が
   `ship-docking.ts:32-35`、`modular-ship-connection-operations.ts`(:70,:126,:195)、
   `fire-control.ts:168-172`、`modular-ship-motion.ts:121-124`、受け手側に `radiator.ts:195`、
   `belt-physics.ts:330` と散在。速度側も `v + qRotate(att.q, cross(att.w, local))` が同じ組。
   `centerOffset` 規約を変えれば全部変わるべきもの → 所有者は `ModularShipMotion` または
   `game/ship/` の小ヘルパー。

3. **`ModuleTransform` の適用式** `add(transform.position, qRotate(transform.rotation, p))` —
   `ship-capabilities.ts:86`、`radiator.ts:157,194,223`、`power.ts:131` に手で展開。
   「transform を点/方向へ適用する」操作が型に無い → `ship-assembly-transform.ts` へ追加。

4. **近遠点高度 ⇄ (a,e) 逆変換** — `creative/object-placement.ts:282-285` と
   `stages/spawner/enemy-generator.ts:141-144` に同式(`a=(rp+ra)/2`、`e=(ra−rp)/(ra+rp)`)。
   正本の置き場は `physics/elements.ts`(`apsisAltitudes` の隣に逆関数)。

5. **`ship.ts` `rebuildPartReferences` ≈ `part-damage-model.ts` `collectPartReferences`** —
   `part.type` の switch がコメント込みで同一(船体/コックピット=先頭1つ、ラジエーター/
   ソーラー=先頭2枚、武装/装甲=全部)。部品分類を `parts.ts` 側へ寄せると1つにできる。

6. **`radiator.ts` / `power.ts` の `syncAssembly`+`key`** — module kind(`'radiator'`/
   `'solar_panel'`)の違いだけで ~25行が同一。旧 `up`/`down` スロット名から module id への
   移譲ロジックも共通 → `deployable-panel-state.ts` の隣に共有 helper。

7. **`orbit-guide-tab.ts` の `commit*` 5兄弟** — `commitLissajous`/`commitSunSync`/
   `commitDawnDusk`/`commitMolniya`/`commitTundra` が
   `{...current, X: {...current.X, ...patch}}` の完全同型 → `commitSlice(key, patch)` 的に1本化。

## Tier 3: 構造的分割候補(診断 (a)/(b))

| 順位 | 対象 | 診断 | 内容 |
| --- | --- | --- | --- |
| 1 | `src/game/creative/object-placer-panel.ts` (716行) | **(b)** | `placementMode`('elements'/'lagrange')で多態化。`getForm`・`buildElementsGroup`・`fieldRowFor`・`applyElementsForm` に分岐が散在。**唯一の「多態で書ける分岐の手展開」事例**。Elements/Lagrange 両セクションへ state・DOM構築・フォーム読み取りを分配 |
| 2 | `ship-assembly.ts` `mergedAtDock` (~L187-288) | (a) | ~100行の独立手続き → `ship-assembly-docking.ts` へ。`totals`/`validation` の切り出し前例と同型。**注意**: `other.connections` を private 直接参照しているので `graph` getter 経由か同パッケージ helper 化が要る |
| 3 | `ship-assembly-validation.ts` `validateShipAssembly` (~105行) | (a) | kind別検査を名前付き private 関数へ分割 + **side 期待 transform 算出(L69-86)を `ship-assembly-transform.ts` へ**(構築側 `connectSide`/`mergedAtDock` と同じ式を共有する根拠になる)。エラー順序は `assertValid` の join 出力に効くので実行順を変えない |
| 4 | `orbit-guide-tab.ts` | (a) | リサジュー行(`buildLissajousRow`+`commitLissajous`+`syncAll` 内同期節 ~65行)を `reference-orbit-rows.ts` の `LissajousRow` へ。既存の `SunSyncRow` 等と同構造 |
| 5 | `physical-object-list-panel.ts` | (a) | `STYLE`(~80行)を `physical-object-list-panel-style.ts` へ。注入タイミング(constructor 先頭)は変えない |
| 6 | `modular-ship.ts` `burnManagementViewModel` (~L469) | 層 | モデル層の entity が「燃焼中」「全損」等の**表示文字列を組んでいる**。型の定義元は既に `game/hud/panels/burn-management-panel.ts` なので、導出関数として HUD 側へ |
| 7 | `render/pipeline/render-pipeline.ts` | (a) | デバッグ合成一式(`buildDebugComposites`/`buildCompositeMaterial`/`metalnessDebugNode`/`shadowSlot*Node`/`logDepthNode`/`writeDepthDebugCamera`/`syncDebugTarget`、~L197-323)を `DebugTargetRenderer` 的に切り出せる |
| 8 | `input.ts` (552行) | (a) | タッチジェスチャ認識(長押し・ダブルタップ・ピンチ、L154-315 中心に ~200行)を `TouchGestureTracker` へ。マウスドラッグと `pointers` 等の state を共有するので中程度の侵入 |

## 命名・型の件(文面違反・波及大)

- `EphemerisContext`(`physics/ephemeris/ephemeris-context.ts:7`)→ `EphemerisProvenance`
  等。意味のある構造だが名前は集め方。**セーブ欄名 `ephemerisContext`(game.ts)も同名なので
  形式の版上げが要る**
- `FocusCameraConfig` → `FocusCameraSpec`/`Defaults` 系。`LissajousParams`/`HaloParams`/
  `CollinearParams` → `Spec`/`Linearization` 系。BGM の `*Params` → `Score`/`Spec` 系。
  `hud/widgets` の `*Options` → `Spec` 系。`AuroraFieldOptions` → `AuroraFieldSpec`
- `*Manager` 漠然名: `SimSpeedManager`→`TimeWarp`、`OverlayManager`→`OverlayStack`、
  `ViewManager`→`ViewTransition`、`UnlockManager`→`StageUnlocks`、
  `DisplayWindowManager`→`DisplayTimelineControl` 等。改名規模は大きい
- `save-browser.ts:244-380` の `handle*` 私有メソッド群 — 中身が操作そのものなので動詞へ
  (`playSlot`/`renameSlot`/…)。`handleCommand`/`handlePointer` 系の公開 API は全コードベースの
  慣用なので別判断
- `hud/viewport.ts` ↔ `render/viewport.ts` — 同名ファイルで別概念。hud 側を
  `viewport-tracking.ts` へ
- `bodyParentId(): string | null | undefined`(`celestial-bodies.ts:47`)— 「未登録=undefined /
  親なし=null」の3値。1.6 的には戻り値の union 型で表すのが正しい形
- `DynamicCollisionPropertiesSnapshot` — 基底+`shapeRevision` だけの "Snapshot" 接尾辞。
  `VersionedCollisionProperties` への改名か revision の本体畳み込み

## `| undefined` 抑制(59ファイル・~90箇所)の潰し方

機械的に潰せる残置。分類:

- **`?:` 化できるもの** — interface/型のプロパティ(`orbit-guide-model.ts` の
  `GuideLineEntry.maxVertices` 等)
- **`| null` 化すべきもの** — 返り値(`plan.ts:120` `firstNode()`、
  `parts.ts:161` `deserializeParts` 等)、引数(`celestial-bodies.ts` の
  `focusId: string | undefined` 系 — 内部で `focusId ?? null` しているので null が自然)、
  フィールド(`part-damage-model.ts` の `[X | undefined, X | undefined]` スロットタプル →
  `(X | null)` タプル)
- **要判断** — `bodyParentId` の3値(上記)、Serialized 系・ワイヤ形式で undefined が
  JSON 省略と結び付くもの、`Map.get` の戻り値に合わせているもの

## 分割しないと診断したもの(再検討不要)

`plan-editor.ts`(「計画編集セッション」単一責務、切ると Params 型を生む)、
`game-presentation.ts`(配線係で規則どおり、実装の混入ほぼ無し)、`hud-root.ts`(パネル単位で
分離済み)、`run-event-presenter.ts`(閉じた union の網羅 switch = 1.2 が許容する形)、
`dynamic-motion.ts`(behavior 多態済み、残りは委譲と状態)、`focus-camera-selection.ts`、
`small-bodies.ts`・`tracks.ts`(データ表)、`celestial-motion.ts`(Star/Orbiting/Planet/
Satellite 階層が一貫)、`capped-cylinder-contact.ts`(GJK/EPA = 単一アルゴリズム)、
`title-scene.ts`、`shadow-maps.ts`、`tracks.ts`

## 除外・保留

- `markerItem`(`modular-ship.ts`/`enemy.ts`): `CombatTarget` 契約の公開口。外に出しても委譲が
  残るだけ(1.2「小関数を外に出すな」)。自機/敵の個別調整要素(1.5)でもある
- ステージ挙動・自機/敵の戦闘挙動の類似実装: 1.5 の明示的除外
- `earth-surface*` の `*Options` 連鎖: 全体が規約と毛色違いで、分解は大規模
- `save` 系の `legacy`/`旧` 語彙: 改名残骸(1.10)ではなく旧フォーマット互換。版番号
  (`V1`/`V3`)への揃えは低優先の一貫性改善

## 所感

層違反はゼロで、残っているのは「散在した同一式の共通化」「データ差サブクラス」
「`| undefined` 抑制の解消」が中心。最もコスト対効果が高いのは **Tier 1 + Tier 2** で、
いずれも挙動不変の機械的変更として進められる。Tier 3 はどれも独立して `/write-and-run-plan`
規模の作業。
