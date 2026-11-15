# 章05: HUD 汎用ウィジェットのレビュー

単独実行可。他章に依存しない。(save-browser は章04、dock-view は章09の担当 — ここでは触らない)

## 対象ファイル
- `src/game/hud/`: property-window.ts / object-picker.ts / object-groups.ts / anchor-zone.ts / rotation-zone.ts / buttons.ts / context-menu.ts / overlay-layer.ts / dom.ts / layout.ts / shortcut-hint.ts / menu-actions.ts / view-badge.ts / panel.ts / orbit-info.ts / frame-labels.ts / tick-scale.ts / calendar-ticks.ts / utils.ts / hud.ts / settings-panel.ts / display-time-panel.ts(game/ 直下)
- `src/game/object-list-panel.ts` / `src/game/frame-controls.ts`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/hud src/game/object-list-panel.ts src/game/frame-controls.ts` で該当コミットを把握。
2. 観点:
   - **差分DOM更新規約**: 毎フレーム sync するパネル(property-window の syncRows/syncItems、object-list-panel、StageStatusPanel)が `innerHTML` 全書き換えでリスナーを落としていないか。diff キーの一意性(row `key`、item のシリアライズ文字列)。
   - **リーク**: `document` への capture リスナー(context-menu / object-picker の outside-close、property-window の drag)が dispose で外れるか。ウィンドウ close 経路の二重 dispose(`closeWindow` vs `forgetWindow`)。
   - **z-index 規約**: `overlay-layer.ts` 以外に `z-index` 代入がないか(`grep -rn 'zIndex\|z-index' src/game/`)。`pointer-events: auto` の欠落でクリックが canvas に抜けて発砲する箇所。
   - **CSS 特異性**: `#hud, #hud *` リセットに負ける裸クラスセレクタ(margin/padding/width を設定する規則は id スコープ必須)。
   - **エスケープ**: rename 入力・エンティティ名など動的文字列が `innerHTML` に入る箇所。
   - **一時ウィンドウ不変条件**: `tempWindowKey` — 非クリップは常に高々1、clip/unclip 双方向で維持。クリップ済みウィンドウがキーボードショートカットを受けないこと。
   - **tick-scale vs calendar-ticks**: 責務が混ざっていないか(経過時間 T+ vs カレンダー境界)。
   - `orbit-info.ts` の中心天体解決が `strongestAttractor` 経由か(Earth 直書きの残骸)。
3. コメント点検(`/comment`): ウィジェット公開メソッドの呼出規約コメント欠落。

## 検証
- `npm run typecheck`(physics 非対象なので test:physics 不要。ただし hud-layout.test.ts / shortcut-hint.test.ts / calendar-ticks が test:physics に含まれるなら実行)

## 出力
`findings/05-findings.md` にタグ付きで列挙。リスナーリーク・エスケープ漏れ・規約違反は修正可。
