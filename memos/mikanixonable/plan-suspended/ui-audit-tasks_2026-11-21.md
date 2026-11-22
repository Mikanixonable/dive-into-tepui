# UI 監査タスク棚卸し — 2026-11-21

UI/DOM 層の統一漏れ・規約違反・バグ・重複実装を3系統の並列調査で洗った棚卸し。
実装計画ではなく調査報告。判定基準は `DEVELOP/CODING-RULE.md` 1.12 と
`DEVELOP/SPEC/UI-DESIGN.md` §3/§7/§8。スナップショット時点: `37b0a0d54`(workspace3)。

1-6 の確定バグと I/K ピッチの仕様誤記はこの棚卸しと同じ日に修正済み。
7-12 の対話性・共有語彙の修正、16-17 の重複整理、CSS 余白トークン化も後続作業で対応した。
今後の候補は13-15と「要確認」に残る項目。

## 修正済み(2026-11-21)

| # | 内容 |
| --- | --- |
| 1 | Tab(画面を広く使う)が UI 層オープン中も発火する — UI-DESIGN §5「UI 層が開いている間は切替停止」違反 |
| 2 | 確認オーバーレイの初期フォーカスが「決定」側 — §8 は「キャンセルに置く」 |
| 3 | `OverlayManager.dispatchShortcut` がモーダルの下のオーバーレイへ項目ショートカットを配送する |
| 4 | `ValueInput` で無効入力→blur の次の正規確定が `suppressBlurCommit` 残留で1回捨てられる |
| 5 | `bindActivation` が `e.repeat` を見ず Enter/Space 長押しでハンドラ連射 |
| 6 | プロパティウィンドウの操作項目に「キャンセル」が混入 — §8「置かない」違反 |
| 仕様 | CONTROLS.md の I/K ピッチ方向が実装系と逆 — 実装(I=下げ/K=上げ)を正として仕様側を訂正 |

## 後続作業で対応済み

| # | 対応 |
| --- | --- |
| 7a-7c | セーブ記録カード・枠行・PREDICT 時刻ラベルをキーボードから活性化可能にした |
| 8a-8b | ステージ行をキーボードから活性化可能にし、デバッグ操作を `<button>` にした |
| 9 | ステージ操作パネルの色選択を `Pulldown` に統一 |
| 10 | ワイド画面状態を DOM class から読まず、HUD の状態から `Button.setOn` へ同期 |
| 11 | プロパティ窓の折りたたみに `bindActivation`・`aria-expanded`・`.hidden` を適用 |
| 12 | `slider-field` と建造スロットの明確な API 迂回を修正。複合ボタン内容への `.element` 追加は維持 |
| 16 | 残存する Enter/Space 手書き変換を共有活性化ヘルパーへ統一。旧 physical-object-list はパネル置換時に削除済み |
| 17 | `node-gizmo` / 建造選択メニューの style 注入と画面内クランプを共有ヘルパーへ統一 |
| CSS | stage-select・PREDICT・HUD 各所の等価 spacing literal を `--space-*` 等へ移行 |

## キーボード到達不能(実害のある統一漏れ)

| # | 場所 | 内容 |
| --- | --- | --- |
| 7a | `src/launcher/save-browser/snapshot-pane.ts:139-148` | `.sb-snap-card` が div+dblclick 専用。カード内ボタンは Button だがロード導線がキーボードで辿れず、手動セーブの復元がキーボード操作不能 |
| 7b | `src/launcher/save-browser/slot-pane.ts:99-103` | `.sb-slot-row` が div+click のみ。枠の切替がキーボード操作不能 |
| 7c | `src/game/hud/panels/display-timeline-panel.ts:160-167` | `.predict-elapsed` が strong+click のみで ToggleValueEdit の導線へキーボードから入れない |
| 8a | `src/launcher/stage-select.ts:342-353` | `.ss-stage` 行が div+click(数字キーのショートカットが代替経路) |
| 8b | `src/launcher/stage-select.ts:297-300` | `.ss-debug` が div+click で代替経路なし |

## 語彙・API の統一漏れ

| # | 場所 | 内容 |
| --- | --- | --- |
| 9 | `src/game/creative/stage-controls-panel.ts:217-238` | `buildColorSelect` が Pulldown を生 `<select>` で再実装。`.w-select` クラスの語彙借用でもある |
| 10 | `src/game/hud/hud-dom.ts:439-445,464` | `flipRootClass` が DOM class から状態を読み(§7.1 違反)、`Button.setOn` を迂回して `classList`/`aria-pressed` を直書き |
| 11 | `src/hud/windows/property-window-rows.ts:100-124,143-174` | 折りたたみトグルを独自実装し `aria-expanded` 未同期(兄弟の related-items とは揃っていない)。非表示も `.hidden` 語彙を使わない |
| 12 | widget API 迂回5箇所 | `slider-field.ts:51-74`(空コールバック+独自 input 購読+value 直書き)、`vessel-panel.ts:238`、`ship-construction-panel.ts:282`、`ship-construction-catalog.ts:108,197,200`(replaceChildren で setLabel 迂回)、`pause-menu.ts:223`(element へ補足要素を直接追加) |

## リファクタ(共通化の効果順)

| # | 場所 | 内容 |
| --- | --- | --- |
| 13 | `src/game/creative/object-placer-panel.ts:122-145` | 手組みのドラッグ可能窓枠(panel-chrome-head・wireHeaderDrag・クランプ・viewport subscribe)。`DraggableWindow` + `PanelChrome` と責務が大きく重複する最大の共通化候補 |
| 14 | `context-menu.ts:86,132,242-244` ⇔ `object-picker.ts:89,181,216-217` | フォーカス保存/復元・Tab 閉じ・roving tabindex(`setRovingItem`/`setRovingOption`)がほぼ同一ロジックで2系統に複写。OverlayManager 側の契約へ寄せる余地 |
| 15 | `frame-panel.ts:11-21` 他9箇所 | 「[3文字コード]+`h3.editorial-panel-title`」の見出しマークアップを個別生成。コード+タイトルだけ組む小ヘルパーへの集約余地 |
| 16 | `object-picker.ts:302-306`、`property-window-rows.ts`、`property-window-related-items.ts:85-89`、`physical-object-list-row-tree.ts:184-197` | Enter/Space の手書き keydown→click 変換。`bindActivation` で代替可(related-items は同ファイル内で片側だけ bindActivation 使用の不統一) |
| 17 | `node-gizmo.ts:75,100-101`、`ship-construction-selection-menu.ts:27-31`(injectOnce 不使用)、`ship-construction-selection-menu.ts:123-124,136`(clampPx は `clampOverlayPosition` と同責務) | 小さな重複 |

## CSS トークン残り(低〜中)

- spacing / hit-target の等価値は後続作業でトークンへ移行済み。
- z-index 生値4ファイル(sticky 見出し・装飾層など overlay-layer 管轄外の内部スタッキング)は未整理。

## 要確認(判断材料不足)

- `object-picker.ts:119-133` 生 `<input>` 絞り込み欄 — physical-object-list は同種を「ValueInput の確定契約に合わない唯一の例外」とコメントで正当化済み。object-picker 側の扱い統一の要否
- `@media (pointer: fine)` / `(prefers-reduced-motion: reduce)` — breakpoints.ts に等価定数なし。定数化の要否
- `stage-select.ts:310` `.title-logotype` click(「共鳴」5連打の隠し機能)— キーボード非対応は意図的か
- `#touch-zoom`(touch-controls.ts:310-330)div+pointerdown — タッチ専用 UI のため影響は限定的
- `.erow` 語彙 — ui-selectable と目的が重複するが固有の focus/cluster 状態を持つため置換可否は要判断
- `ship-construction-catalog.ts` `wireCardDrag` — 再描画中にカードが切り離されるとドラッグ状態が宙に浮く可能性(再現窓が狭く未確認)
- `window-drag.ts` `releasePointerCapture` — pointercancel 時の未ガード呼出(有害でない可能性が高い)

## 調査で健全と確認した領域

- OverlayManager の積層・Esc 優先度・外側クリック・入力ゲート・排他グループは SPEC §4 と整合
- HudEls の id 照合に欠落なし。主要ウィンドウの dispose/close は正常に解除される
- テキスト入力系は全て keydown を stopPropagation し、UI 打鍵がゲーム入力へ漏れない
- fmtTime/fmtDist 系のフォーマッタに重複乱立なし。`.hud-mini-code` は参照ゼロで削除済み
