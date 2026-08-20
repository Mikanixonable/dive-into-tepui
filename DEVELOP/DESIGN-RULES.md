# DESIGN-RULES — UI/デザイン規約

HUD の見た目・配置・操作(色/寸法トークン、ウィジェット、オーバーレイの開閉規則、置き場、タッチ
対応)についての規約の正本。`OWNERSHIP.md`/`CALLSTACK.md`/`SPEC.md` が「所有」「呼び出し順」
「挙動仕様」の一次情報であるのと同じ位置づけで、この文書は「見た目と操作がどう振る舞うべきか」
の一次情報を持つ。責務の所有者そのもの(どのクラスが何を持つか)は `OWNERSHIP.md`、UI に限らない
横断的な責務境界(`Game` にロジックを書かない、`update`/`sync` の分離など)は
`.claude/skills/refactor-fixed/SKILL.md` — この文書はそれらと重複させず、「見た目と操作の規約」
だけを持つ。

## 読み方 / 扱う範囲

- 扱うのは HUD(DOM オーバーレイ)の見た目・配置・操作規約。ゲーム世界そのものの見た目(3D
  シーン・マーカーの記号選択そのもの・軌道線)は CLAUDE.md の Architecture 節と
  `marker/marker-glyphs.ts` が持つ。この文書が触れるのはマーカーの**色**の規約(§2)だけ。
- **書いてあるのは現状の規約だけ**。経緯・旧実装・施策番号は書かない(`/comment` の方針と同じ)。
  何が・いつ変わったかは git history と `memos/mikanixonable/UI改善/` が持つ。

## 更新義務

`src/game/theme.ts` / `src/game/hud/widgets/` / `src/game/hud/overlay-manager.ts` /
`src/game/hud/breakpoints.ts` / `src/game/hud/layout-tokens.ts` / `src/game/hud/skeleton-style.ts` /
`src/game/hud/panel-shell.ts` / `src/game/hud/viewport.ts` / `src/game/input/input.ts` /
`src/game/input/touch.ts` / `src/game/input/pointer-precision.ts` を変更したら、同じ変更セットで
この文書も更新する。新しいウィジェットを1つ追加した/削除した、状態語彙を増やした、置き場の種類を
増やした、ブレークポイントの閾値を変えた、というときは特に必ず反映する。

---

## 1. 七原則(全判断の上位規範)

個別の見た目の趣味より、この7つの一貫性を優先する。判断に迷ったらここへ戻る。

1. **一責務一 UI。** 1つのウィンドウ/パネルは1つの問いに答える。「このパネルは何を答えるものか」
   を一文で言えないなら分割する。
2. **状態の持ち主はクラス、DOM は表示。** `style.display` や DOM の有無を読んで開閉状態を判定する
   コードを書かない。状態は必ずクラスの付け外し(`.on`/`.pressed`/`.disabled`/`.hidden`/
   `.collapsed`/`.clipped`)で表す。
3. **開く/閉じる/重なりの規則は一人が持つ。** ESC・外側クリック・排他・入力ゲートは
   `OverlayManager` 1つが裁く(§4)。個々のウィンドウ/パネルが `document`/`window` へ独自の
   keydown/pointerdown を張らない。
4. **見た目はトークンからのみ導く。** 色・透明度段階・余白・角丸・フォントサイズ・トランジションは
   `theme.ts` の有限集合から選ぶ。リテラル値の直書きを禁止する(§2)。
5. **レイアウトは流し込み+変数、固定 px は最終手段。** 位置は「レール/常設計器/中央モーダル/
   画面固定バッジ」の4種の置き場のどれかに属させる(§5)。同じ長さを複数箇所へ書き写さない。
6. **タッチは第一級入力。** すべての操作はタッチだけで完結できる。タップ最小寸法は
   `--hit-target-min`(44px)。ホバーは装飾であり情報を持たない(`title` 属性だけの説明を禁止)。
   **この原則は DOM ボタンだけでなく画面投影のピック判定にも適用する**(§6)。
7. **名前は責務を言い切る。** 実装から乖離した名前・多義的な名前・歴史的経緯の名前は見つけ次第
   改名する。改名は痕跡を残さない(CLAUDE.md の同名規約に従う)。

---

## 2. トークン — `theme.ts`(UI の見た目)と `const.ts`(ゲーム世界の色)

**「HUD/パネル/ウィンドウ/ボタン/タッチ UI がどう見えるか」と「ゲーム世界そのものの色
(マーカー・演出・軌道線・船体)」は別の関心事**で、別のファイルが正本を持つ。

- **`game/theme.ts`** — UI のデザイントークンの唯一の定義元。他モジュールを import しない。
  持っているもの:
  - 色: `ACCENT`/`ACCENT_SOFT`/`ACCENT_SECONDARY`/`DANGER`/
    `DANGER_FILL`、面と縁のグレー段(`BG`/`SURFACE_WEAK`/`SURFACE`/`SURFACE_OPAQUE`/`EDGE`)、
    文字色4段(`TEXT_STRONG`/`TEXT`/`TEXT_MUTED`/`TEXT_DIM`)、アクセントの薄膜4段
    (`ACCENT_FILL_WEAK`→`ACCENT_FILL_STRONG`)と縁2段(`ACCENT_EDGE_SOFT`/`ACCENT_EDGE`)、
    中立の薄膜4段(`FILL_1`→`FILL_4`)、`SHADE_1`(弱い落とし影)/`SCRIM`(全画面の背後幕)/
    `BAR_BG`(ゲージの不透明地)、グロー混合率2段(`GLOW_STRONG`/`GLOW_WEAK`)。
  - 文字サイズ8段(`FONT_XXS`→`FONT_3XL`)と `FONT_FAMILY`。マーカーのグリフサイズ
    (`GLYPH_BASE`/`GLYPH_2_3`/`GLYPH_1_3`/`GLYPH_POI`/`GLYPH_BORESIGHT`)は独立した別スケール。
  - 角丸4段(`RADIUS_S`/`RADIUS_M`/`RADIUS_L`/`RADIUS_PILL`)、余白6段
    (`SPACE_1`→`SPACE_6`)、トランジション2段(`TRANSITION_FAST`/`TRANSITION_SLOW`)。
  - `HIT_TARGET_MIN`(44px)、`SAFE_AREA_TOP/RIGHT/BOTTOM/LEFT`(`env(safe-area-inset-*)` の
    呼び出し自体を注入する)。
  - Δv 編集の3軸 `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL`(次項の唯一の例外)。
  - `injectThemeVariables()` — 全トークンを `--token-name` の kebab-case で `:root` へ注入する
    (`#hud` ではなく `:root` — `input/touch.ts` の仮想パッドは `#hud` の外(`body` 直下)にあり、
    同じトークンを読む必要があるため)。`hud/hud-root.ts` の `buildHudDom` が一度だけ呼ぶ。
- **`const.ts` の「色管理」節** — ゲーム世界の識別色・演出色(方位マーカー・爆発/噴煙/弾・
  軌道線・船体、ステージ演出色: `COLOR_MARKER_*`/`COLOR_ENEMY_*`/`COLOR_BULLET_*`/
  `COLOR_DESTROY_*`/`COLOR_SHIP_DARK_HULL` など)だけを持つ。UI の色はここに置かない。
- **両者は互いを import しない。**「UI 側がゲーム世界の色をたまたま流用する」ような近道を
  作らせないため、そもそも参照させない。

### 同じ色を DOM と 3D の両方で使うものだけ theme に置く

**この規則の唯一の例外が Δv 編集の軌道3軸** — `plan-editor.ts` の DOM パネル(Δv 数値入力・軸表示)
と `plan-gizmo-3d.ts` の3D矢印が同じ3色(`AXIS_PROGRADE`=青/`AXIS_NORMAL`=緑/`AXIS_RADIAL`=赤)を
共有するため、`theme.ts` に置く。3D シーンにしか現れない色(`render/` 配下、`plan-path.ts` の
`SEGMENT_COLORS` など)は theme に上げず、その場のローカルな定数のままにする — theme に上げてよいのは
「複数箇所が同じ値であることを型で保証したい」ときだけで、3D 側にしか読み手がいない値をそこに置いても
保証すべき一致が存在しない。

### マーカーはモノトーン基調 + 注意色、軌道3軸だけが明示された例外

ゲーム世界のマーカー(`const.ts` の色、および `skeleton-style.ts` の `.mk-*` セレクタ)は
**モノトーン基調(自機軌道は薄灰・計画軌道は白・プログレード/ボアサイトは薄灰)に、注意を引く対象
だけオレンジ(ターゲット・LEAD・ノード/BURN・弾薬)** という規約が既定。**軌道3軸マーカー
(`.mk-pro`/`.mk-retro`/`.mk-nrm`/`.mk-rad` — `var(--axis-prograde)`/`var(--axis-normal)`/
`var(--axis-radial)`)だけがこの規約の明示された例外で3色になる** — Δv ギズモ(3D矢印・DOM パネル)と
同じ軸を指すマーカーが、ギズモと違う色で「どの軸か」を示していては読み違いのもとになるため。
新しいマーカーを追加するときにこの例外を広げない(モノトーン+注意色が既定のまま)。

### リテラル直書きの禁止

**HUD/タッチ UI/ポップアップの CSS 文字列(`<style>` として注入されるテンプレートリテラル)に、
色・文字サイズ・角丸・余白・トランジションのリテラル(`#rrggbb`・`rgba()`・生の px 値)を書かない。**
`var(--…)` を使う(`--accent`/`--font-s`/`--space-3` のように kebab-case)。

**CSS でない箇所(JS が組み立てるインライン `style="..."` 属性、THREE に渡す色)は `var(--…)` を
経由せず `theme.ts` の TS 定数を直接読んでよい**(CSS カスタムプロパティは DOM の外には意味を持た
ないため)。`hud/target-panel.ts`/`hud/enemies-panel.ts`/`hud/result-screen.ts`/`hud/pause-menu.ts`
がこの形で `theme.ts` の定数を直接 import し、`innerHTML` の中の `style="color:${TEXT_DIM}"` に
埋め込んでいるのはこの例外に沿う。**`<style>` タグへ注入する CSS テンプレートリテラルの中で
`${TEXT_DIM}` のように定数を直接埋め込むのはこの例外に**当たらない**(それは CSS 文字列であり、
`var(--text-dim)` を使うべき箇所)。**

---

## 3. ウィジェット — `hud/widgets/`

**押せる/切り替えられる/入力できる DOM を自作しない。** `hud/widgets/` の10種**以外**の対話要素
(生の `<button>`/`<input>`/`<select>` や、それらを模した `<div>`+クリックリスナ)を新規に作らない。
足りない振る舞いが要るときは、既存のどれかを拡張するか、新しいウィジェットとして `hud/widgets/`
へ追加し、`hud/widgets/index.ts` から再 export する。

| ウィジェット | 何をするか |
| --- | --- |
| `Button` | 単発クリック。`on`(点灯)/`disabled` の表示は呼び出し側が `setOn`/`setEnabled` で与える — 自分では反転しない。点灯型トグルはこれに `setOn` を外から呼ぶ形で表現し、別ウィジェットを持たない。 |
| `ToggleSwitch` | 見出し + ON/OFF のトラック+ノブ型スイッチ。2値専用。 |
| `SegmentedControl<T>` | 見出し + 排他選択ボタン列。**3択以上専用** — 2値の ON/OFF に使わない(`ToggleSwitch` を使う)。`setItems` は同内容なら作り直さない(押しかけのボタンを消さないため)。`setSelected(null)` は全消灯 — 「今どれでもない」を表せる。 |
| `HoldButton` | 押している間 `isHeld` が真になる。呼び出し側がゲームループから毎フレーム読む(`setInterval` を使わない、per-frame poll に揃える)。 |
| `CloseButton` | ✕ の閉じるボタン。native `<button>` を1箇所だけで組む。 |
| `ValueInput` | 数値/文字/検索入力の唯一の実装。下記の確定/破棄規約を持つ。 |
| `Meter` | HP/温度/電力などのバー。常に左から右へ満ちる。`setDanger(true)` で `--danger` 色に切り替える。 |
| `TabBar<T>` | `SegmentedControl` と同じ排他選択だが `role="tab"` を持ち、パネルの表示面そのものを切り替える用途専用。 |
| `Slider` | `<input type="range">` の唯一の実装。動くたびに `onInput` が呼ばれる即時通知(`ValueInput` の確定契約とは別物)。 |
| `buildCollapseToggle` | 縦方向の開閉トグル。target の表示/非表示を `.collapsed` クラスで切り替えるボタンを組む。`COLLAPSE_EXPANDED_GLYPH`(▾)/`COLLAPSE_COLLAPSED_GLYPH`(▸)がグリフの唯一の定義。 |

土台は `hud/widgets/widget-base.ts` の3関数——`stopDragPropagation`(カメラドラッグへのクリック
伝播を止める)、`expandHitTarget`(`pointer:coarse` のときだけ要素自身の寸法(`min-width`/
`min-height`)を `--hit-target-min` まで広げる、`.w-hit` クラス)、`bindActivation`(`click`/Enter・Space の `keydown` を一箇所へ
まとめる——ポインタでのクリック後はフォーカスを外し、キーボード操作は残す。`Input` の
`window` keydown 購読へ同じキーが二重に伝わらないよう伝播も止める)——で、対話要素を持つ
ウィジェットはこれを自前で書かず経由する。
共通スタイルは `hud/widgets/widget-style.ts`(`WIDGET_STYLE`)の1箇所——`#hud` に閉じないセレクタ
(タイトル画面 `stage-select.ts`・`#touch-ui` でも組めるように)。

### 状態語彙は閉じた集合

**ウィジェットの状態は `.on`(選択/点灯)・`.pressed`(押下中)・`.disabled`+`aria-disabled`
(無効)の3つだけ。** 新しい状態クラス名(`.selected`/`.sel`/`.active`/`.held` の類)を増やさない。
`hover` は文字/縁がアクセント化するだけで独自クラスを持たない。`isHeld`(`HoldButton` の getter 名)
はクラス名ではなくプロパティ名なので、この語彙には数えない。

**`.clipped` は状態語彙ではなく `hud/property-window.ts` の `PropertyWindow` 固有の意味**
(📌 で「一時ウィンドウの排他枠から外れ、外側クリック/ESC で閉じなくなる」)。他のウィジェットへ
this 概念を広げない——ピン留めが要る対象は `PropertyWindow` だけである。

### 確定/破棄の規約

**`ValueInput` は Enter=確定・Escape=破棄・blur=確定が唯一の規約。** 打鍵ごとの clamp や通知は
行わない(編集途中の値を黙って書き換えないため)。**確定は前回確定した値から変わっているときだけ
`onCommit` を呼ぶ** — フォーカスして何も打たずに blur するだけの操作が、呼び出し側の状態
(計画ノードなど)を編集扱いで壊さないようにする。`escapeBehavior: 'revert' | 'clear'` の既定は
`'revert'`(確定済みの値へ戻す)。**`'clear'`(空にする)を渡してよいのは検索フィールドに限る** —
「なんとなく Escape でクリア」が他所へ広がらないよう、例外は呼び出し側にこの型で明示させる。
数値欄で非数値・空欄の確定は破棄(`cancel()`)として扱う。

`hud/object-picker.ts` の絞り込み欄(`.op-filter`)は打鍵ごとに一覧を再描画する必要があり
(`ValueInput` の「確定でしか通知しない」契約とは別の要求)、`ValueInput` を使わず生の `<input>` を
持つ——**唯一の例外**。新しい即時フィルタ入力を作るときも、`ValueInput` を無理に使わず同じ形を
踏襲する(ただし `keydown` の `stopPropagation()` は必ず自分で書く、次項)。

### 入力欄は必ず keydown の伝播を止める

`input/input.ts` の `Input` は `window` でキー入力を購読しているので、HUD の入力欄で止めなかった
打鍵はそのままゲーム操作になる(検索欄に `w` と打つと機体が噴射する)。テキスト・数値入力・
スライダーはすべて `keydown`(`Slider` は矢印キー、`ValueInput` は Enter/Escape 以外も含め全体)の
`stopPropagation()` を持つ——新しい入力系ウィジェットを足すときもこれを踏襲する。

---

## 4. オーバーレイ — `hud/overlay-manager.ts` の `OverlayManager`

**モーダル・ポップアップ・ウィンドウは必ず `OverlayManager` に登録する。** 重なり順(最前面が誰か)・
ESC の配送先・項目ショートカットの配送先・外側クリックでの自動クローズ・入力ゲートは、この1クラス
だけが裁く。個々のオーバーレイは `document`/`window` へ独自の keydown/pointerdown を**張らない**
(唯一の例外は入力層本体——`input/input.ts`・`input/touch.ts`・`viewport.ts`——と、`Game` 構築前の
タイトル画面 `stage-select.ts`)。外側クリックの検出も `OverlayManager` 内の1本の capture リスナへ
集約する——各オーバーレイが自前で `document` へ張らない。

- `OverlayKind` は `'modal' | 'popup' | 'window'` の3種。`OverlaySpec` が持つ4つの宣言:
  `closeOnEscape`/`closeOnOutsideClick`/`gatesInput`(真の間、この1枚が開いているだけで背景
  (3D世界・タッチパッド)への入力を完全に遮る——一時停止メニューのように背後を覗き見させたい
  モーダルは `false` にする)/`exclusiveGroup?`(同じ名前を持つオーバーレイは同時に1つしか開かない)。
- `open(id, handle, spec)`/`reconfigure(id, spec)`/`close(id)` が書き込み側。`handle` は持ち主が
  実装する `OverlayHandle`(`contains`/`close`/任意の `handleShortcut`)——開閉の実処理・対象要素は
  持ち主が持ち、`OverlayManager` は参照を束ねるだけ。
- `closeTopmostOnEscape()` — 最前面から順に `closeOnEscape` なオーバーレイを1つだけ閉じる。
  何も無ければ `false` を返し、呼び出し側(`Game.handleInput`)が一時停止メニューを開く。
- `dispatchShortcut(code)` — 最前面から順に、`code` に一致する項目ショートカットを持つオーバーレイ
  を探して1つだけ実行する。テキスト入力へフォーカスがある間は誰にも配らない。

### ESC の意味は2つだけ

1. **入力欄にフォーカスがある間** — その欄の編集を破棄する(`ValueInput` 自身の `keydown` が
   `stopPropagation()` するので、`Input` の `window` 購読へは届かず、`OverlayManager` 側の判断には
   到達しない)。
2. **それ以外** — 最前面のオーバーレイを閉じる(`OverlayManager.closeTopmostOnEscape()`)。何も
   開いていなければ一時停止メニューを開く。

ESC の持ち主は `Game.handleInput`(`game.ts`)の1箇所だけ——`input.takeKey(K.pauseMenu)` を取り、
`closeTopmostOnEscape()` が `false` を返したときだけ `pauseMenu.toggle(true)` を呼ぶ。個々の
オーバーレイの開閉判断はここに書かない。

### ContextMenu = 使い捨て、PropertyWindow = 継続観察

`hud/context-menu.ts` の `ContextMenu` は「その場で1つ選んだら消える」ポップアップ(`kind:'popup'`,
`closeOnEscape:true`, `closeOnOutsideClick:true`, `gatesInput:false`)。`hud/property-window.ts` の
`PropertyWindow` は「対象を継続観察・操作する」ウィンドウ(`kind:'window'`)——ドラッグで動かせ、
📌 でクリップして常設できる。**同じ対象への右クリックは、戦闘ビューかマップかを問わず必ず
`PropertyWindow` を開く**(`map-context-actions.ts`)——ContextMenu が残るのは、プロパティを持たない
空域(`'empty-space'`)への右クリックだけ。新しい右クリック対象を追加するときも、プロパティを持つ
対象(艦・天体・基地・ノードなど)は必ず `PropertyWindow`、プロパティを持たない対象だけ `ContextMenu`
に倒す。

`PropertyWindow` の一時ウィンドウ(📌 されていないもの)は高々1枚——`exclusiveGroup` を使って
新しく開いた/クリップを外したウィンドウが前の一時ウィンドウを追い出す(`currentSpec()` の
`tempWindowGroup`)。同じ仕組みで、系ウィンドウ(ヘルプ・一時停止・セーブブラウザ)は
`exclusiveGroup: 'system-modal'` で束ね、同時に1つしか開かない。

---

## 5. レイアウト — 置き場4種

**画面上の全パネル/オーバーレイは、次の4種のどれか1つに属する。**

1. **レール(`.hud-rail`、`hud-root.ts` の `hudRail(root, 'left'|'right')`)** — マップ系パネルの
   縦積み。中身は通常の flex フロー(`.hud-rail > .panel { position: relative; inset: auto; }`)に
   積み、絶対座標を持たない。畳める(`.hud-rail.collapsed`)。`buildWorldRoot` がマップビュー・
   戦闘ビューそれぞれに別の DOM ルート(`.hud-map-root`/`.hud-combat-root`)を組み、両方が自分
   専用の左右一対のレールを持つ——片方を畳んでも、常にどちらか一方しか `.active` にならない
   もう一方のルートのパネルには影響しない。
2. **常設計器(戦闘ビュー自身の `.hud-rail-left`/`.hud-rail-right` — ①と同じレール機構の、
   戦闘ビュー専用インスタンス)** — `hud-root.ts` の `buildInfoPanels` が組む SHIP STATUS/
   ORBIT/TARGET/CONTACTS の常設計器。左レールに ORBIT、右レールに SHIP STATUS・
   TARGET(ロック時のみ表示)・CONTACTS が積まれ、①と同じ flex フロー・折りたたみ規則
   (レール単位・`PanelShell` のパネル単位の二段)に従う。①と違う点は、各パネル自身の高さに
   上限がかかること——`combat-view-style.ts` が `max-height: var(--combat-panel-max-h)` と
   `overflow-y: auto` を与え、超えた分はパネル内スクロールになる(`--combat-panel-max-h` の
   値そのものは `layout-tokens.ts` がブレークポイントごとに再代入する、この置き場固有の寸法
   トークン)。常設計器は戦況を隠しすぎないよう、狭い/低い画面でも一定高さに収まる。
3. **中央モーダル(`OverlayManager` の `kind: 'modal'`)** — 画面全体を覆う/画面中央に寄せる
   全画面 UI。`BaseView`(`position: fixed; inset: 0`)・`SaveBrowser`(`inset:0` の scrim +
   中央寄せパネル)・`ResultScreen`・`HelpPanel`・`PauseMenu`(いずれも `top/left:50%` +
   `transform:translate(...)` か `inset:0` の flex 中央寄せという定型を使う)。
4. **画面固定バッジ** — ①②のいずれにも属さない、置き場を持たない単発の表示
   (`ViewBadge`/`SimulationStatusBar`/`MapScaleBadge`/`ChaseReset`/`Hint`/`Toast`)。

**リテラルな `top`/`left`/`right`/`bottom` の絶対座標直書きが許されるのは、置き場に参加しない
④画面固定バッジと、③中央モーダルの中央寄せそのもの(`top/left:50%+transform` または `inset:0`の
どちらかの定型)だけ**——①②に乗るパネル自身は `position: relative` のままで、置き場のコンテナ
(`.hud-rail`)が絶対座標を持つ。ある要素をどの種に属させるか迷ったら、
「動かせる/畳める/レイアウトに参加すべきか」で判断する——参加すべきなら①か②、一点固定でよいものだけ
④。

### ブレークポイントは `hud/breakpoints.ts` の1箇所だけ

幅は `compact`(≤699px)/`medium`(700〜1100px)/`wide`(>1100px)の3クラス、`coarse`
(`pointer:coarse`)/`short`(高さ≤499px)の2軸を直交として持つ。`COMPACT_MAX_WIDTH`/
`MEDIUM_MAX_WIDTH`/`SHORT_MAX_HEIGHT` の3つの数値と、そこから導かれる `MQ_COARSE`/`MQ_SHORT`/
`MQ_MEDIUM_DOWN`/`MQ_COMPACT`/`MQ_COARSE_SHORT` の5つのメディアクエリ文字列だけがここにあり、
**`@media (max-width: …px)` を他ファイルへ書き写さない**——各 CSS ファイルはこの5つの `MQ_*` を
テンプレートリテラルへ埋め込むだけにする。JS 側で離散的に(構築・オープンなどの瞬間にだけ)幅
クラスを読みたい呼び出しは `isCompactViewport()` を使う——`pointer-precision.ts` の
`isCoarsePointer()` と異なり起動時にキャッシュしない(画面幅は回転・リサイズで頻繁に変わるため)。

**レール幅・戦闘パネル高上限のようなブレークポイントごとに値が変わる寸法は、`hud/layout-tokens.ts` の
CSS カスタムプロパティ(`--rail-w-left`/`--rail-w-right`/`--combat-panel-max-h`)へ持たせ、`:root` への
再代入をブレークポイントの数だけ書く。** 参照側は `var(--rail-w-left)` のように読むだけにし、
`min(300px, 30vw)` のような式そのものを複数箇所へ複製しない。

### 骨格 CSS とパネル内容 CSS の分割

共有の基底スタイル(1つの `<style>` として `hud-root.ts` が注入する)は4ファイルに分かれる:
`layout-tokens.ts`(上記の寸法変数)、`skeleton-style.ts`(層・レール(戦闘ビュー自身のインスタンス
含む)・`PanelShell` 共通部・画面固定バッジの骨格、および `.mk-*` マーカー色)、`panel-content-style.ts`(SHIP STATUS/
ORBIT/TARGET/CONTACTS の行、軌道オブジェクト一覧、軌道計画、表示設定、表示時刻、座標系、艦艇配置、
ナビボール、ステージステータス、設定・ヘルプ・終了画面の中身)、`hud/widgets/widget-style.ts`
(ウィジェット共通、§3)。**自己完結した個別コンポーネント**(`BaseView`/`SaveBrowser`/
`ContextMenu`/`ObjectPicker`/`PropertyWindow`/`AnchorZone`/`FrameControls` など)は、代わりに
自分のモジュールに `const STYLE` を持ち、初回構築時に自分で `<style>` を注入してよい——ただし
トークンの参照規約(§2)とブレークポイントの参照規約(このセクション)は同じく適用される。

### `.hidden` と `.collapsed` は別軸

**`.hidden`(`!important`)はゲーム状態由来の表示/非表示**(自機が無い、戦闘ビューでない、
ターゲットが無い、など)——`PanelShell.setHidden(hidden)` が唯一の書き手。**`.collapsed` は
利用者の折りたたみの選択**——`hud/panel-shell.ts` の `PanelShell` に載る全パネルが
`buildCollapseToggle` で持ち、`localStorage`(`tepui.panelCollapsed`、パネル id ごと)へ永続する。
`loadPanelCollapsed`/`savePanelCollapsed` がその唯一の読み書き口——レール(`.hud-rail.collapsed`)
のような `PanelShell` を使わない折りたたみ可能な置き場も、この同じ2関数・同じストアを共有する
(レール専用の第二の永続キーを作らない)。**隠れている間に畳み外ししても、再表示時にその状態のまま
出てくる**——2軸は独立に読み書きされ、互いを上書きしない。

### `visualViewport` は `hud/viewport.ts` の1箇所だけが購読する

画面回転・アドレスバー伸縮・仮想キーボードでの再配置が要る側(`PropertyWindow`/`ContextMenu` の
再クランプなど)は、自前で `window`/`visualViewport` の `resize` を張らず `onViewportChange` を
購読する。`startViewportTracking()`(`buildHudDom` が一度だけ呼ぶ)が `--vvh`(実効ビューポート
高さ)と `--safe-t`/`--safe-r`/`--safe-b`/`--safe-l`(`env(safe-area-inset-*)` と
`visualViewport` の欠け量の大きい方)を更新する。レンダラの解像度合わせ(`render/scene.ts`)は
3D 描画の関心事であってレイアウトではないので、この集約の対象外。

---

## 6. タッチ — 第一級入力

すべての操作はタッチだけで完結できる。`input/input.ts` の `Input` がジェスチャを合成する
唯一の場所——長押し=右クリック合成、二本指ドラッグ=パン、ピンチ(指の間隔の変化)=ズーム、
ダブルタップ(またはブラウザ標準 `dblclick`)=ダブルクリック合成。それぞれ対応する定数
(`TOUCH_LONG_PRESS_MS`/`TOUCH_LONG_PRESS_FEEDBACK_MS`/`TOUCH_DOUBLE_TAP_MS`/
`TOUCH_DOUBLE_TAP_PX`)は `const.ts` にある。マウス由来のクリックとタッチ由来の合成クリックは
`Input` の同じキューを共有し、呼び出し側はどちらが発生源かを気にしない。長押しの視覚フィードバック
(`Input.onLongPressFeedback`)は `Input` 自身がマーカー層を知らずに済むよう、`Game` が
`MarkerManager.set`/`.hide` へ配線する——新しいジェスチャの視覚フィードバックを足すときも
この分離(ジェスチャの合成は `Input`、その見た目は配線先)を踏襲する。

タップターゲットは最小 `--hit-target-min`(44px)。`pointer:coarse` のときだけ、要素自身の寸法
(`min-width`/`min-height`)でこの最小寸法を確保するのが `widget-base.ts` の `expandHitTarget`
(`.w-hit`)——マウス操作では間隔を保つため fine ポインタでは効かせず、重ね合わせの疑似要素でも
広げない(隣接要素のヒット領域を侵すため)。coarse で行・列が伸びるのは正しい挙動として許容する。
**この原則は DOM ボタンだけでなく
画面投影されたピック判定にも適用する** — `input/pointer-precision.ts` の `pickRadiusSq(fine, coarse)`
が、主たるポインタが `pointer:coarse`(`isCoarsePointer()`、起動時に一度だけ評価)かどうかで
ピック半径を切り替える。マップ上のオブジェクト・ノード・AN/DN アイコンなど、画面へ投影してから
距離でヒット判定するあらゆる箇所は、固定の半径ではなくこの関数を経由する。

**ホバーは装飾であり情報を持たない。`title` 属性だけの説明を禁止する** — タッチでは `title` は
読めない。ボタンの意味・キー割り当ては可視のラベル文字列(例: `` `進行方向 [${K.progradeReset.label}]` ``)
で示す。

---

## 7. やってはいけないことの一覧

以下はすべて、下の grep で機械的に検出できる形で書いてある。ゼロ件であることを変更のたびに保つ。

1. **色/寸法リテラルの直書き**(`<style>` へ注入される CSS 文字列の中の `#rrggbb`/`rgba()`/
   `font-size:`・`border-radius:`・`transition:` の生値。インライン `style="..."` 属性・THREE
   への色渡しは対象外——§2 の例外)。
2. **`style.display` を読んで状態を判定する**(`el.style.display === 'none'` のような比較)。
   状態は必ずクラスで持つ(§1原則2)。
3. **`window`/`document` への `keydown`/`pointerdown` の直付け**(`input/input.ts`・
   `input/touch.ts`・`hud/viewport.ts`・`hud/overlay-manager.ts` 自身と、`Game` 構築前の
   `stage-select.ts` を除く)。
4. **生 `<button>`/`<input>` の自作**(`hud/widgets/` の内部実装と、ファイルピッカー用の隠し
   `<input type="file">`(`save/save-transfer.ts`)、即時フィルタ入力(`object-picker.ts` の
   `.op-filter`、§3 の唯一の例外)を除く)。
5. **`vh` の裸使用**(`dvh` を伴わない `NNvh`。`visualViewport` 未対応環境へのフォールバックとして
   `NNvh` の直後に同じセレクタ・同じ値の `NNdvh` を書く定型は正当)。
6. **ブレークポイント値の直書き**(`@media (max-width: …px)`/`(pointer: coarse)` などを
   `hud/breakpoints.ts` の外に書く)。
7. **旧状態語彙**(`.selected`/`.sel`/`.active`/`.held` をクラス名として使う)。

```sh
# 1. 色/寸法リテラル(theme.ts / widgets/widget-style.ts / const.ts 自身は対象外)
grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" src/game/hud/*.ts src/game/hud/widgets/*.ts \
  | grep -v "theme.ts:\|widget-style.ts:"
grep -rn "font-size:\s*[0-9]" src/game/hud/*.ts src/game/hud/widgets/*.ts | grep -v "widget-style.ts:"
grep -rn "border-radius:\s*[1-9]" src/game/hud/*.ts src/game/hud/widgets/*.ts \
  | grep -v "widget-style.ts:\|border-radius: 50%"
grep -rnE "transition:[^;]*[0-9]+(\.[0-9]+)?s" src/game/hud/*.ts src/game/hud/widgets/*.ts \
  | grep -v "var(--transition"

# 2. style.display を読んで分岐している箇所(書き込みではなく比較)
grep -rn "style\.display\s*===\|style\.display\s*!==" src/game/

# 3. window/document への keydown/pointerdown の直付け
grep -rn "window.addEventListener('keydown'\|document.addEventListener('keydown'\|window.addEventListener(\"keydown\"\|document.addEventListener(\"keydown\"" src/game/ \
  | grep -v "input/input.ts:\|input/touch.ts:\|stage-select.ts:"
grep -rn "window.addEventListener('pointerdown'\|document.addEventListener('pointerdown'" src/game/ \
  | grep -v "input/input.ts:\|input/touch.ts:\|hud/overlay-manager.ts:"

# 4. 生 <button>/<input> の自作
grep -rn "createElement('button')\|createElement(\"button\")\|createElement('input')\|createElement(\"input\")" src/game/ \
  | grep -v "hud/widgets/\|save/save-transfer.ts\|hud/object-picker.ts"

# 5. dvh を伴わない裸の vh(同じ行に dvh の対句が無いもの)
grep -nE "[0-9]vh\b" src/game/hud/*.ts src/game/hud/widgets/*.ts | grep -v dvh

# 6. ブレークポイント値の直書き
grep -rn "@media (max-width\|@media (min-width\|pointer: coarse" src/game/hud/*.ts src/game/hud/widgets/*.ts \
  | grep -v "breakpoints.ts:"

# 7. 旧状態語彙
grep -rn "classList\.\(add\|toggle\|contains\)('selected'\|classList\.\(add\|toggle\|contains\)('sel'\|classList\.\(add\|toggle\|contains\)('active'\|classList\.\(add\|toggle\|contains\)('held'" src/game/
```

---

## 8. 判断に迷ったら

上記で決まらない判断(トグルの統合可否、置き場の帰属、色の例外を広げるかどうか)は
`memos/mikanixonable/UI改善/UI・デザイン改善計画_第二版.md` §7「決定事項(回答済み)」が
一次情報。そこにも無い新しい論点は、ユーザーに問う(推測で進めない)——回答を得たら同節と
この文書を同じ変更セットで更新する。
