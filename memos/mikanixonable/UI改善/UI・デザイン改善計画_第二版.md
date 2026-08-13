# UI・デザイン改善計画 第二版

この文書は単体で読めるように書いてある。前提知識は「本リポジトリは TypeScript + Three.js WebGPU のブラウザゲームで、HUD は DOM オーバーレイである」ことのみ。施策番号は着手順序と一致させる(軽量化計画と同じ規約)。旧版は残さず、改版時はこのファイルを全面的に書き直して版数を上げる。行番号は 2026-08-13 時点の main で実地確認した値。

## 0. 結論の要約

- 目標は3つ: **(a) モバイル/iPad の縦横どの画面でも UI が崩れず、最重要 UI だけが出て残りは収納できる**、**(b) 全 UI の配色/挙動/配置/粒度に単一の哲学から導かれる一貫性を与え、プレイヤーのメンタルモデルを成立させる**、**(c) それを支える UI コードを疎結合・一責務・素直な命名に書き換える**。
- 第一版からの進捗: **デザイントークンの一本化(旧施策1)は完了**。色・アルファ段階・フォントサイズ・角丸・余白・トランジションの分裂は解消され、UI の CSS は `var(--…)` で書ける状態になった。以後の全施策はこれを前提にしてよい。
- 第一版から**悪化した点**: `map-picker.ts` が 926 行に伸び UI 最大モジュール第2位になった(旧計画時点の記述より肥大)。`plan-editor.ts` に Δv の数値入力 3 本が増え、数値入力の実装が 4→5 系統に分裂した。`object-list-panel.ts` に検索入力・近傍/フィルタ/ソートのボタン群が増え、`aria-pressed` 駆動という第6の状態語彙と 16px のタップ領域を新規に持ち込んだ。**トークン化で止血した一方、ウィジェットとオーバーレイの分裂は書くほど増えている。**施策の順序をこの事実に合わせて組み替える(§4-0)。
- 第一版から**解決していた点**: ResultScreen には再出撃/タイトルへの明示ボタンが既にある(`result-screen.ts:20,23`)。第一版の「閉じる手段自体がない」は誤り。ただし台帳外である点は変わらない。`hud/layout.ts` の `clampOverlayPosition` は PropertyWindow と ContextMenu で既に共有されており、施策4で作り直す対象ではない。
- 最大の未解決問題は変わらず**タッチでゲームの中核操作の過半に到達できない**こと(長押し=右クリックの合成が無く、プロパティウィンドウ・ターゲット指定・ノードメニュー・空域メニューがすべて開けない)。これは見た目の一貫性ではなく**機能の到達不能**であり、第二版ではこれを施策2へ前倒しする。

## 1. デザイン哲学(全施策の判断基準)

以下の 7 原則が全施策の上位規範。実装中に迷ったらここに戻る。個別の見た目の趣味より原則の一貫性を優先する。

1. **一責務一 UI。** 1 つのウィンドウ/パネルは 1 つの問いに答える。「このパネルは何を答えるものか」を一文で言えないパネルは分割か廃止。
2. **状態の持ち主はクラス、DOM は表示。** `style.display` や class の有無を読んで開閉状態を判定するコードは禁止。
3. **開く/閉じる/重なりの規則は一人が持つ。** ESC・外側クリック・排他・入力ゲートは単一のオーバーレイ管理者が裁く。各ウィンドウが `document`/`window` に独自の keydown/pointerdown を張ることを禁止する。
4. **見た目はトークンからのみ導く。** 色・透明度段階・余白・角丸・フォントサイズ・トランジションはトークンの有限集合から選ぶ。リテラル値の直書きを禁止する(施策1で達成済み — 以後は維持義務)。
5. **レイアウトは流し込み+変数、固定 px は最終手段。** 位置は「レール(左右の縦積み)/シェルフ(戦闘計器の並び)/中央モーダル/画面固定バッジ」の 4 種の置き場のどれかに属させる。同じ長さを 2 箇所に書かない。
6. **タッチは第一級入力。** すべての操作はタッチだけで完結できる。タップターゲットは最小 44px。ホバーは装飾であり情報を持たない(`title` 属性だけの説明を禁止)。**この原則は DOM ボタンだけでなく画面投影されたピック判定にも適用する。**
7. **名前は責務を言い切る。** 実装から乖離した名前・多義的な名前・歴史的経緯の名前は見つけ次第改名する(CLAUDE.md の「改名は痕跡を残さない」規約に従い、旧名は全文検索 0 件にする)。

## 2. 現状の問題(実地確認済み、2026-08-13)

実装者が現地確認する際の索引。**施策1で解消した項目は本節から削除した**(色リテラル・フォントサイズ22種・角丸8種・余白・トランジションの分裂)。

### 2-1. レイアウト・レスポンシブ

- viewport meta は `viewport-fit=cover` 付きで存在するのに **`env(safe-area-inset-*)` の使用が src 全体で 0 件**。iPhone ノッチ/ホームバー、iPad ジェスチャバーに `bottom:12px` 系要素(タッチパッド `input/touch.ts:38-58`、`#hud-status` 等 `hud/dom.ts:113,118,125`)が潜り込む。**`theme.ts` に `HIT_TARGET_MIN`(44px)トークンは既にあるが、CSS 変数として注入されるだけで参照する側が 0 件。**
- ドック幅の指定が `hud/dom.ts:57-58`(`min(300px,30vw)`/`min(300px,33vw)`)と参照側 `:275` の `calc(12px + min(300px, 30vw) + 8px)` に加え、ブレークポイント別の別値としても散在。CSS 変数化されていないため、参照側と定義側の対応をブレークポイントごとに手で揃えており、変更が必ず漏れる。
- メディアクエリは `dom.ts` に 5 本、`touch.ts` に 3 本(900px / 520px / pointer:coarse / landscape+max-height:500px)。ただし **`#dock-view`、`#save-browser`、`property-window.ts`、`object-picker.ts`、`context-menu.ts`、`node-gizmo.ts` にメディアクエリ 0 件**。
  - `object-picker.ts:14` は `width: 520px` 固定 — **375px 端末では画面外に出る。現に壊れている。**
  - `dom.ts:610,622` の `grid-template-columns: 1fr 120px 60px auto` は iPad 縦 768px 以下で潰れる。
  - `dom.ts:399` の `min-width: 480px` も 375px 端末では横あふれ。
- `#hud-object-list { max-height: 544px }`(`dom.ts:148`)はどのメディアクエリでも上書きされず、横向き端末(高さ 375〜500px)で画面高を超える。
- **`dvh` 使用 0 件**。`vh` のみ 11 箇所(`dom.ts` 9 / `object-picker.ts:14` / `launch-select.ts:19`)。iOS Safari のアドレスバー伸縮でずれる。
- **`orientationchange` / `visualViewport` / `matchMedia` の購読が src 全体で 0 件。**回転時に JS 側で再レイアウトする仕組みが存在しない。
- `#hud-combat-shelf` は `display: contents`(`dom.ts:177`)で、広幅では子(`#hud-status`/`#hud-orbit`/`#hud-enemies`)が絶対座標で並び、狭幅時のみ flex の棚になる二重構造。`pointer:fine` かつ幅 901〜1100px では 228px×3 パネルが素のまま重なる。
- 収納できるのは左右ドック・PREDICT バー・オブジェクト一覧 body の 3 系統のみ。`#hud-status`/`#hud-orbit`/`#hud-enemies`/`#hud-target`/`#hud-stagestatus`/表示設定/座標系ほかは個別収納不可。
- `#hud .hud-dock > .panel[style*="display: none"]`(`dom.ts:59`)というインライン style 文字列マッチの壊れやすいセレクタが現役。
- ドック自体は `pointer-events:none` のまま `overflow-y:auto`(`dom.ts:53`)なので、ドックの空き領域を掴んでタッチスクロールできない。

### 2-2. ウィジェット実装の分裂

トークンは統一されたが、**ウィジェットの実装数は第一版時点より増えている**。

- `hud/buttons.ts` の公開物は 6 種(`hudButton` / `SegmentedControl` / `HudHoldButton` / `IconToggleButton` / `HudToggleButton` / `HudToggle`)。このうち **ON/OFF を表すものが 3 種**(`HudToggle` のトラック+ノブ型、`HudToggleButton`・`IconToggleButton` の点灯型)。
- `buttons.ts` を通さない生 `<button>` が 9 ファイル・39 箇所(`dock-view.ts` / `save-browser.ts` / `settings-panel.ts` / `property-window.ts` / `view-badge.ts` / `object-list-panel.ts` / `stage-utils/stage-status-panel.ts` / `launch-select.ts` / `main.ts`)。
- **閉じるボタン 4 実装**: `.dock-close-btn`(`dock-view.ts:135`)、`.sb-close-btn`(`save-browser.ts:98`)、`.sclose`(`settings-panel.ts:37`、しかも `[閉じる]` というテキスト)、`property-window.ts:207` の ✕。
- **数値/文字入力 5 系統**(第一版時点は 4): `display-time-panel.ts:58` の `DurationValueInput`、**`plan-editor.ts:151-159` の Δv 数値入力 3 本(新規追加分)**、`ship-placer-panel.ts:191,608`、`property-window.ts:274` の rename、`object-list-panel.ts:142` の検索入力(新規追加分)。Enter/Escape/blur の規約に従うのは `display-time-panel.ts:60-67` と `property-window.ts:282-285` の 2 箇所のみ。
- **スライダー 3 実装**: `display-time-panel.ts:238`(予測到達率グラデ付き)、`ship-placer-panel.ts:239`、`settings-panel.ts:27`(BGM、`innerHTML` 手書き)。
- **HP/メーター 4 実装**、**タブ 3 実装**(dock-view / save-browser / launch-select)。
- **状態クラス語彙が 6 種のまま**(内訳は第一版から変わった): `.on`(9箇所)/`.held`(3)/`.selected`(2)/`.sel`/`.active`/`.clipped`、加えて `aria-pressed` 属性駆動の CSS(`object-list-panel.ts:153-180` と `dom.ts:158` — **新規追加分**)。第一版が挙げた `data-pinned` は既に存在しない。
- `:active` を持つのは 2 箇所のみ、disabled の表現も不揃い。主力ボタンクラス `seg-btn` に hover 定義がない。
- CSS クラス `seg-btn` は segmented control 専用の名でありながら全ボタンに付く汎用クラス(`buttons.ts:6,75,106,139`)。`hud-seg` も流用され打ち消し例外を生んでいる。
- `IconToggleButton`/`HudToggleButton` の説明が `title` 属性のみでタッチでは読めない。

### 2-3. ウィンドウ・モーダル制度

- モーダル台帳(`hud/modal-controller.ts`)に載るのは `help`/`settings`/`save-browser` の 3 つだけ。**ResultScreen(`#hud-end`)と DockView は台帳外**で、入力ゲートも排他も効かない。
- `ModalController.sync` は**開いている限り毎回** `tepui-release-touch-inputs` を発火する(`modal-controller.ts:53`)。2枚開いている状態から1枚閉じただけでも押しっぱなしの仮想キーが全解放される。台帳外モーダル(ResultScreen/DockView)では逆に一度も発火しない。
- **`window` 直付け keydown が 3 箇所**(`context-menu.ts:91`, `property-window.ts:243`, `ship-placer-panel.ts:629`)あり、`Game.handleInput` の順序ハードコードの外で ESC を消費する。加えて要素直付けの keydown が `object-list-panel.ts:142,450`(新規)/ `display-time-panel.ts:60` / `object-picker.ts:96` / `property-window.ts:279` / `plan-editor.ts:181-190`(新規、`stopPropagation` のみ)にある。単一の持ち主が存在しない。
- 外側クリックで閉じる判定も `context-menu.ts:83` / `property-window.ts:240` / `object-picker.ts:107` が独立に capture リスナを張る。
- **Escape の意味が 4 通りに割れている**: 編集破棄 / 検索クリア(`object-list-panel.ts:142`) / ポップを閉じる / ポーズメニュー開閉。
- 同じ艦を戦闘ビューで右クリックすると ContextMenu、マップで右クリックすると PropertyWindow(`targeter.ts` vs `map-picker.ts`)。役割分担が未確定。
- 軌道情報が 3 系統に散在: 戦闘 `#hud-orbit`、マップの PropertyWindow「軌道」グループ、`#hud-target` の相手軌道。同じ `orbit-info.ts` を別 UI が別書式で表示。
- 「表示」パネルが二重定義のまま: `OverviewCameraPanel`(title「表示」、中身は天体クラス表示トグル、`overview-camera-panel.ts:44`)と `NavballPanel`(title「表示」、中身は天球グリッドトグルで、**前者の DOM に `querySelector('#hud-overview-camera')` で相乗りし、無ければ id `navball` の別パネルを生成** — 生成順で ID もオーナーも変わる、`navball-panel.ts:20-30`)。
- 状態の持ち主が DOM: ヘルプ(`hud.ts:56` が `style.display` を読んでトグル)、SettingsPanel(`settings-panel.ts:102`)、ObjectPicker(`object-picker.ts:119,140`)、ContextMenu(`context-menu.ts:96`)、ドック折りたたみ(class が唯一の状態)。`modal-controller.ts` 自身が冒頭で「computed style から状態を推測するのは誤り」と明言しているのに他所で現役。
- PropertyWindow の一時ウィンドウ排他(高々 1 枚)は `MapPicker.windows`/`tempWindowKey` にあるが、同じクラスを使う `src/perf-meter.ts` は台帳外。
- **既に共有されており作り直してはいけないもの**: `hud/layout.ts` の `clampOverlayPosition`(PropertyWindow のドラッグと ContextMenu の開き位置が共有)、`hud/shortcut-hint.ts` の `shortcutKeyLabel`、`hud/menu-actions.ts` の `MenuAction` 単一 union + `MenuCommon` ファクトリ。

### 2-4. タッチ入力

- **右クリック相当の合成(長押し等)が存在しない**ため、タッチでは以下が不可能: マップのプロパティウィンドウ、空域メニュー、ノードメニュー、ターゲット指定、ナビターゲット。**ゲームの中核操作の過半がタッチ不能。**
- パンは中ボタンドラッグ限定(`input.ts:140,164`)でタッチ不能。二本指ジェスチャはピンチ(ズーム)のみ(`input.ts:130,159`)で二本指ドラッグ=パンは未実装。
- ダブルクリックはブラウザ `dblclick` 依存(`input.ts:115`)でタッチでは不安定。`object-list-panel.ts` の行ダブルクリック、`save-browser.ts:223` のスナップショット読み込みがタッチ不能。
- **投影ピック半径に coarse 用の値がない**: `MAP_PICK_PX_SQ` / `TARGET_LOCK_PICK_PX_SQ` はいずれも 600(=半径 24px、`const.ts:174-175`)固定。指では狙えない。
- 仮想ボタンが無い操作: スロットル段 1-4、放熱板 9/0、太陽電池 7/8、リロード R、targetSelect T、progradeReset F、followAttitude G、カメラロール、ノード削除 X、pauseMenu ESC、restart R、F3/F5/F9。
- タップターゲット 44px 未満: `.seg-btn` 実高 ~19px、`.icon-toggle-btn` min-width 20px、オブジェクト一覧行 ~16px、`.dock-toggle` 26px、`.toggle-track` 34×18、`.prop-window-btn` 18px、`#touch-ui .tbtn` 46〜52px(これは合格)。
- 右クリックのクリック判定閾値だけマジックナンバー 50(`input.ts:196`、他は `CLICK_MOVE_THRESHOLD=6`)。
- タッチ UI は safe-area 非考慮の固定 px 配置(`touch.ts:38-58`)。`isTouchDevice()`(`touch.ts:126`)による常時表示で、ハイブリッド端末での出し入れがない。

### 2-5. 責務・命名

- 行数: `hud/dom.ts` 1036 / **`map-picker.ts` 926** / `creative/ship-placer-panel.ts` 849 / `plan/plan-editor.ts` 844 / `hud/dock-view.ts` 615 / `hud/property-window.ts` 529 / `object-list-panel.ts` 476。200 行基準を大きく超える。
- `dom.ts` に全パネルの CSS・レイアウト・ヘルプ本文・ドックトグル・SVG オーバーレイ生成・`buildCollapseToggle` が同居。
- `MapPicker` が picker を名乗りながら候補集合構築・visibility 判定・ヒットテスト・メニュー構築・ウィンドウ台帳・アクション実行(設定を開く/艦艇配置を開く/複製/リネーム)まで担う。`map-pick.ts` と `map-picker.ts` は一文字違いで別責務。
- `SettingsPanel` の実体は一時停止メニュー。
- `DockView`(造船ドック)と `hud-dock-left/right`(画面端パネル収納)で "dock" が同語二義。
- HUD パネルなのに `hud/` 外にあるファイル: `game/object-list-panel.ts`, `game/display-time-panel.ts`, `game/frame-controls.ts`。**一方で `frame-controls.ts` が使う `anchor-zone.ts`/`rotation-zone.ts` は `hud/` にある** — 同一機能が 2 フォルダに分裂している(新規に判明)。
- **PREDICT パネルの呼び名が 5 つ**: CSS 接頭辞 `dtp-`、id `hud-displaytime`、表示名 `PREDICT`、クラス名 `DisplayTimePanel`、状態所有者 `DisplayWindowManager`。
- `HudPanels`(`hud/panel.ts` 351行)が STATUS/ORBIT/TARGET/CONTACTS の 4 パネルを 1 クラスで持つ god オブジェクト。
- `PlanEditor`(844 行)がパネル DOM・ギズモ配線・メニュー・Δv 入力処理を 1 クラスに持つ。

## 3. 理想状態(到達点の宣言)

- **画面の置き場は 4 種に還元される**: ①左右レール(縦積み・折りたたみ可・タッチスクロール可)、②戦闘シェルフ(計器の並び)、③中央モーダル層(必ずオーバーレイ管理者の台帳に載る)、④画面固定バッジ。すべてのパネルはこのどれかに属し、絶対座標の直書きは④のみに許す。
- **すべてのパネルが個別に収納できる**。パネルは共通 `PanelShell`(見出し+折りたたみトグル+本文)に載り、折りたたみ状態はクラスが持ち localStorage に永続する。
- **ウィジェットは 1 役割 1 実装**: Button / ToggleSwitch / TabBar / CloseButton / Slider / ValueInput / HoldButton / SegmentedControl / CollapseToggle / Meter。選択は `.on`、押下は `.pressed`、無効は `.disabled`+`aria-disabled` の単一語彙。確定/キャンセルは Enter/Escape/blur の単一規約。
- **オーバーレイは単一管理者**が ESC・外側クリック・排他・入力ゲートを裁き、全モーダル(ヘルプ/一時停止/セーブ/リザルト/造船)が台帳に載る。ContextMenu は「その場で 1 つ選ぶ使い捨て」、PropertyWindow は「対象を継続観察・操作するウィンドウ」と役割を確定する。
- **タッチだけで全操作が完結する**: 長押し=右クリック、二本指ドラッグ=パン、ピンチ=ズーム、ダブルタップ=フォーカス。仮想パッドは safe-area を避け、全ボタンと**全ピック判定**が 44px 相当以上。キーボードは加速手段であって必須手段ではない。

## 4. 施策一覧

### 4-0. 順序の考え方(第一版からの変更点)

第一版は「トークン → ウィジェット → レイアウト → ウィンドウ → タッチ → 命名 → 仕上げ」の一直線だった。第二版では**依存関係のある部分だけを直列に保ち、依存しないものを前倒しする**。理由:

1. **タッチのジェスチャ合成は `Input` のエッジキュー内で完結し、ウィジェットにもレイアウトにも CSS にも依存しない。**にもかかわらず第一版では 5 番目に置かれ、その間ずっと「タッチではゲームの半分が遊べない」状態が続く。見た目の一貫性より機能の到達可能性が先。→ **施策2へ前倒し。**
2. **現に画面外へ出ている破損(ObjectPicker 520px 固定、オブジェクト一覧 544px 固定、`vh`)は、トークン化が済んだ今なら数行で直る。**レイアウト骨格の全面改修(施策6)を待つ理由がない。→ **施策3として切り出す。**この施策で書く CSS は既存トークンと新規 CSS 変数の定義だけで、骨格には触れないので「トークンなしで書いた CSS は全部書き直しになる」という第一版の懸念に当たらない。
3. **ウィジェットとオーバーレイは実測で悪化している**(数値入力 4→5、状態語彙に `aria-pressed` 追加、`window` keydown が減っていない)。放置すると施策の対象が増え続けるので、破損修復の直後に置く。
4. **レイアウト骨格(旧施策3)はウィジェット統一後の方が安い。**`PanelShell` にパネルを載せ替える作業と、その中身のウィジェットを差し替える作業を二度やらないため。→ 施策6へ後退。
5. 旧施策5(タッチ)は**入力層の合成**と**UI 側の到達性**に分かれる。後者は施策4/5の完了を前提にするので、最後の仕上げ(施策8)に合流させる。

依存関係:

```
施策1(完了) ─┬→ 施策3(破損修復) ─┐
             ├→ 施策4(ウィジェット) ─┬→ 施策6(レイアウト骨格) ─┬→ 施策8(画面別仕上げ)
             └→ 施策5(オーバーレイ) ─┘                          │
施策2(入力層ジェスチャ) ──────────────────────────────────────┘
施策7(責務・命名) ← 施策4/5/6 の後(改名対象が確定してから)
```

施策2は他のどれとも独立に着手・完了できる。施策3も同様(施策4を待たない)。

---

### 施策 1: デザイントークンの単一定義と全リテラルの置換 [M] — **完了**

実装済み。以下は実施後の確定内容。後続施策はこの結果を前提にしてよい。

**確定したトークン**(`src/game/theme.ts` が唯一の定義元。`injectThemeVariables()` が `:root` に kebab-case の CSS 変数として一度だけ注入する。`#touch-ui` が `#hud` の外にあるため `:root` に置く):
色 `ACCENT`/`ACCENT_SOFT`/`ACCENT_SECONDARY`/`DANGER`/`BG`/`SURFACE_WEAK`/`SURFACE`/`SURFACE_OPAQUE`/`EDGE`/`TEXT_STRONG`/`TEXT`/`TEXT_MUTED`/`TEXT_DIM`、
アクセント薄膜3段+縁2段+`DANGER_FILL`、中立薄膜4段 `FILL_1`〜`FILL_4`、`SHADE_1`/`SCRIM`/`BAR_BG`、
グロー混合率 `GLOW_STRONG`/`GLOW_WEAK`、Δv3軸 `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL`、
文字8段 `FONT_XXS`〜`FONT_3XL`、`FONT_FAMILY`、グリフ `GLYPH_BASE`/`GLYPH_2_3`/`GLYPH_1_3`/`GLYPH_POI`/`GLYPH_BORESIGHT`、
角丸4種、余白6段、トランジション2段、`HIT_TARGET_MIN`。

**着手前の想定から変わった点(新事実)**:
1. **マーカーのグリフサイズは UI の文字スケールに入らない**。`.mk` 系の 22px/14.67px/7.33px/5px/36px は字形に合わせた調整値で、14.67 と 7.33 は 22 の 2/3 と 1/3 という派生だった。`GLYPH_*` という独立スケールとして分離し、派生関係は `calc()` で表現した。
2. **グローは色トークンでは表せない**。`text-shadow` のグローは「その要素自身の色を弱めたもの」で、色は要素ごとに違いアルファだけが共通という構造だった。**混合率トークン+`color-mix(in srgb, <色> var(--glow-strong), transparent)`** を規約とした。
3. **中立色に 0.22〜0.4 の段が無かった**。スライダートラックや SVG 引き出し線がこの帯域を使うため `FILL_4`(0.32)を足し、`FILL_*` のベース色を `EDGE` と同じオフホワイトへ統一した。`DANGER_FILL` と `SURFACE_WEAK` も追加。
4. **色リテラルは `#rrggbb`/`rgba()` だけではない**。3D 側は `0x3b82f6` の数値リテラルで色を持つ。完了判定の grep 条件に `0x` 形式も加えた。
5. **書体は Share Tech Mono を採用せず、読み込みごと削除した**(計画当初の推奨から変更)。日本語グリフを持たず、HUD の 9〜10px に表示書体は不向きで、モバイルでは外部リクエスト1本の削減の方が価値が高い。→ §7 質問6。
6. **危険色が二重化していた**: `WARNING` と `COLOR_HUD_HP_LOW` を `DANGER` 1つへ統合し、良好状態は `ACCENT` を使う。
7. **ゲーム世界の識別色も複数ファイルに散っていた**。`COLOR_MARKER_ALLY`/`COLOR_MARKER_ENEMY`/`COLOR_MARKER_HP_EMPTY` として `const.ts` に集約した。

**確定した責務境界**(`.claude/skills/refactor-fixed/SKILL.md` にも記録):
- `theme.ts` = UI の見た目のトークン。何も import せず直定義する。
- `const.ts` の色節 = ゲーム世界の識別色・演出色。UI 色は持たない。
- **同じ色を DOM と 3D の両方で使う必要があるものだけ theme に置く**(Δv3軸が唯一の例)。3D にしか現れない色は theme に入れない。
- UI の CSS 文字列には色リテラルを書かない。`var(--…)` か theme の TS 定数を使う。

**検証結果**: `npm run typecheck` 通過。`npm run test:physics` 407/407 通過。色リテラルの grep は 2 件のみ残存し、いずれも意図的な例外 —— `creative-stage.ts:225` が敵個体に渡す accent 色(他ステージも個体色をリテラルで渡す慣習に従う)、`render/glow-texture.ts:17-20` の canvas グラデーション(3D テクスチャ生成であり UI ではない)。UI の小数px font-size 0 件。廃止した名前の残存 0 件。

**未検証**: 見た目の実機確認(§5)は未実施。施策3・施策6のレイアウト改修と合わせて確認する。

**維持義務**: 以後の全施策で色・寸法リテラルを新規に持ち込まないこと。§5 の完了判定 grep を各施策のチェック項目に含める。

---

### 施策 2: 入力層のジェスチャ合成(タッチで右クリック・パン・ダブルタップに到達する) [M]

**第一版の施策5から前倒し。**`Input` のエッジキュー内で合成するため、消費側 30 箇所超は無改修で動く。ウィジェット/レイアウト/オーバーレイのどの施策とも独立。

**対象**: `src/game/input/input.ts`、`src/game/const.ts`(閾値定数)。

**変更方針**:
- **長押し=右クリック**: `pointerType==='touch'` で 500ms 静止(移動 < `CLICK_MOVE_THRESHOLD`)したら `pendingRightClicks` へ積み、以後のクリック化を抑止する。長押し開始 300ms で視覚リング(マーカー層)を出す。これだけでマップのプロパティウィンドウ/空域メニュー/ノードメニュー/ターゲット指定/ナビターゲットの 5 つが同時にタッチ可能になる。
- **二本指ドラッグ=パン**: 現行ピンチ実装を拡張し、2 本指の重心移動を `panDx/panDy` へ、間隔変化を `wheel` へ**同時に**折り込む(排他にしない — 実指は回しながら開く)。
- **ダブルタップ**: ブラウザ `dblclick` 依存をやめ、`Input` が自前でタップ 2 連(400ms/24px 以内)を `pendingDoubleClicks` に合成する(マウスは現行 `dblclick` 経路を維持)。
- **投影ピック半径の coarse 拡大**: `MAP_PICK_PX_SQ`・`TARGET_LOCK_PICK_PX_SQ`・NodeGizmo のハンドル/アーム径に coarse 用の値を `const.ts` へ並置し、起動時の `matchMedia` 一回で選ぶ。哲学6の「44px」を DOM ボタンだけでなくピック判定にも適用する最初の一歩。
- 右クリック閾値のマジックナンバー 50(`input.ts:196`)に名前を付けて `const.ts` へ移す(**命名のみ。値は 50 のまま変えない** — 右ドラッグ後でもクリック扱いを許す意図的に緩い値であり、6 に揃えるとデスクトップの右クリック感触が変わる)。

**完了判定**: CDP `Input.dispatchTouchEvent` で「長押し→プロパティウィンドウが開く」「二本指ドラッグ→マップがパンする」「ピンチ→ズームする」「ダブルタップ→フォーカスが移る」の 4 本がスモークとして通る。**「キーボード専用機能を数えるのではなく、タッチで到達できない機能を数える」**をこの施策の指標とし、この時点での残数を §5 に記録する(残りは施策8で 0 にする)。

**効果**: iPad が最低限プレイ可能な環境になる。以後の UI 施策をタッチ実機で検証できるようになる(検証手段の獲得という意味でも先行させる価値がある)。

---

### 施策 3: 現に壊れている非レスポンシブ箇所の即時修復 [S]

**第一版の施策3から切り出した先行分。**骨格には触らず、画面外へ出ている/画面高を超えている箇所だけを止める。

**対象**: `src/game/hud/object-picker.ts:14`、`src/game/hud/dom.ts:148,399`、`src/game/theme.ts`(safe-area 変数の追加)、`src/game/input/touch.ts:38-58`、`public/index.html`。

**変更方針**:
- `ObjectPicker` の `width: 520px` → `width: min(520px, calc(100vw - 24px))`。`max-height: 60vh` → `min(60dvh, 60vh)` 系。
- `#hud-object-list { max-height: 544px }` → `max-height: min(544px, 60dvh)`。
- `dom.ts:399` の `min-width: 480px` を `min(480px, calc(100vw - 24px))` へ。
- **`--safe-t`/`--safe-r`/`--safe-b`/`--safe-l` を `theme.ts` の注入対象に加える**(`env(safe-area-inset-*, 0px)` を合成)。この施策では**タッチ UI の下端群(`touch.ts` の `bottom:12px` 系)と `#hud-status`/`#hud-stagestatus` の下端だけ**を変数参照に置き換える。全要素への適用は施策6。
- `vh` を `dvh`(フォールバック併記)へ機械置換。

**完了判定**: 375×667 / 667×375 のスクリーンショットで、ObjectPicker・オブジェクト一覧・ヘルプが画面内に収まり、タッチパッドがホームバー領域を避けている。

**なぜ骨格改修と分けるか**: 骨格改修(施策6)はウィジェット統一(施策4)の後が安い一方、これらは「今すぐ直せて今すぐ効く」ため待たせる理由がない。施策6で書き直される CSS もあるが、置換対象はいずれも1行であり手戻りは無視できる。

---

### 施策 4: ウィジェット基盤の統一 [L]

**対象**: `src/game/hud/buttons.ts`(改組)、新設 `src/game/hud/widgets/`(1 ウィジェット 1 ファイル)、既存の手書きウィジェット全箇所(`settings-panel.ts:27-37` の `.stoggle`/BGM スライダー/`.sclose`、`touch.ts` の `.tbtn`、`dock-view.ts`/`save-browser.ts`/`view-badge.ts`/`launch-select.ts`/`main.ts` の生 `<button>`、`object-list-panel.ts:142-180` の検索入力+ツールボタン群、`plan-editor.ts:151-159` の Δv 数値入力、`ship-placer-panel.ts` の数値/文字入力とスライダー、`property-window.ts` の rename 入力と各種ボタン、`stage-status-panel.ts:82` の `.radiator-btn`)。

**変更方針**:
- ウィジェットを次の 10 種に確定し、それ以外の「押せる/切り替えられる/入力できる DOM」の自作を禁止する:
  1. `Button`(単発。現 `hudButton`)
  2. `ToggleSwitch`(ON/OFF。現 `HudToggle` のトラック+ノブ型に一本化。`HudToggleButton`・`IconToggleButton`・`.stoggle`・`.tbtn` の点灯型は「状態を持つボタン」= `Button` の `on` 状態表示へ統合)
  3. `SegmentedControl`(3 択以上の排他。2 択の ON/OFF に使うことを禁止 → ToggleSwitch へ)
  4. `TabBar`(dock-view / save-browser / launch-select の 3 実装を統合)
  5. `CloseButton`(✕。**4 実装統合**、44px タップ領域。`settings-panel` の `[閉じる]` テキストもこれに置換)
  6. `Slider`(display-time-panel の到達率グラデ機能を持つ 1 実装に統合。settings-panel/ship-placer は同実装のオプション)
  7. `ValueInput`(数値/文字/検索入力。`DurationValueInput` を汎用化し **5 実装を統合**。**Enter=確定、Escape=破棄、blur=確定** を唯一の規約とする。`plan-editor` の `stopPropagation` 3 連呼びと `object-list-panel` の検索入力もこれに載せる)
  8. `HoldButton`(現 `HudHoldButton`)
  9. `CollapseToggle`(現 `buildCollapseToggle` を維持。property-window/object-list の独自折りたたみもこれへ)
  10. `Meter`(HP/温度/電力バー。4 実装統合。「バーは常に左から右へ満ちる・危険は `DANGER` 色」の規約)
- 状態語彙を統一: 選択/点灯=`.on`、押下中=`.pressed`(JS 付与。タッチと `:active` の差を吸収)、無効=`.disabled` + `aria-disabled`。**`.selected`/`.sel`/`.active`/`.held`/`aria-pressed` 駆動の CSS は全廃**(`.held` は `.pressed` へ、`aria-pressed` は「属性は残すが CSS のセレクタには使わない」= 状態表現は `.on` に一本化。ARIA 属性自体は各ウィジェットが内部で正しく付ける)。`.clipped` は PropertyWindow 固有の意味(クリップ)なので状態語彙とは別概念として残す。
- 状態遷移の視覚規約を 1 箇所の CSS で定義: hover=文字/縁がアクセント化(装飾のみ)、pressed=背景 `--fill-3`、on=背景アクセント薄膜+縁アクセント、disabled=単一 opacity+`cursor:not-allowed`。全ウィジェットがこの 1 定義を継承し、個別 CSS での上書きを禁止。
- CSS クラス名を責務に合わせて改名: `seg-btn` → `w-btn`、`hud-seg` → `w-group`。`pointerdown` の `stopPropagation`(カメラドラッグ抑止)はウィジェット基底で一度だけ書く。
- **タップターゲット: すべての操作要素は視覚サイズに関わらず `--hit-target-min`(既にトークンとして存在するが参照 0 件)以上のヒット領域を持つ**(padding か疑似要素で拡張)。オブジェクト一覧の行(~16px)も対象。`title` のみの説明は、長押しツールチップ(施策2の長押し基盤に載せる)か常時ラベルに置換。

**完了判定**: `.selected`/`.sel`/`.active`/`.held` の grep が 0 件。`createElement('button')` が `hud/widgets/` 以外で 0 件。`type = 'range'`/`'number'`/`'text'` が `hud/widgets/` 以外で 0 件。`--hit-target-min` の参照が全ウィジェットにある。

**効果**: 「同じ見た目は同じ挙動、同じ挙動は同じ見た目」の土台。以後の画面改修でウィジェットを書く作業が消える。ARIA が全ウィジェットに揃う。**新規パネルを足すたびに実装が分裂する現在の傾向がここで止まる。**

---

### 施策 5: オーバーレイ制度の統一(モーダル台帳・ESC・外側クリック・役割確定) [L]

**対象**: `src/game/hud/modal-controller.ts`(拡張 → `overlay-manager.ts` に改名)、`context-menu.ts`、`property-window.ts`、`object-picker.ts`、`result-screen.ts`、`dock-view.ts`、`save-browser.ts`、`settings-panel.ts`、`hud.ts`(ヘルプ)、`creative/ship-placer-panel.ts:629`、`game/game.ts`(handleInput の ESC 分配)、`map-picker.ts`(ウィンドウ台帳)、`src/perf-meter.ts`、`object-list-panel.ts:142`(検索の Escape)。

**変更方針**:
- `OverlayManager`(現 `ModalController` の後継)に全オーバーレイを登録制にする: モーダル(help/pause/save-browser/result/dock-view)、ポップアップ(ContextMenu/ObjectPicker)、ウィンドウ(PropertyWindow — PerfMeter 含む)。登録時に「ESC で閉じるか」「外側クリックで閉じるか」「入力ゲートするか」「排他グループ」を宣言する。
- **ESC は既存の入力経路に載せたまま持ち主を一人にする**: OverlayManager は自前の window keydown を張らない(施策自身が禁じる直付けになるうえ、`Input` のエッジキューと同フレームで競合する)。`Game.handleInput` が `input.takeKey(K.pauseMenu)` で取った ESC を OverlayManager にそのまま渡し、OverlayManager がスタック最上位へ配送する — 順序ハードコードは「開いているものがあれば最上位を閉じる → 何も無ければ pauseMenu を開く」の 1 規則に還元される。例外は入力欄フォーカス中の element-level keydown(`ValueInput` の Enter/Escape — 施策4の規約)のみ。`window` 直付け keydown 3 箇所は全廃(`launch-select.ts` はタイトル画面でオーバーレイ制度の外、`input.ts` は入力層本体なので対象外)。外側クリックの capture pointerdown 3 箇所は OverlayManager の 1 組に集約。
- **`tepui-release-touch-inputs` の発火条件を直す**: 現状は「開いている間 `sync` するたび」に発火し、2枚から1枚閉じただけでも仮想キーが全解放される。「入力ゲートが false→true に変わった瞬間だけ」に条件を絞り、台帳に加わる ResultScreen / DockView でも発火するようにする。
- **Escape の意味を 2 つに確定**: 入力欄フォーカス中=編集破棄、それ以外=最前面のオーバーレイを閉じる(何も無ければ一時停止メニューを開く)。**`object-list-panel` の「検索クリア」は廃止**し、クリアは `ValueInput` の ✕ ボタンで行う。
- ResultScreen を台帳に載せる(**閉じる手段は既にある** — 再出撃/タイトルへのボタン。追加すべきは台帳登録と入力ゲートのみ)。ヘルプは `HelpPanel` クラス化し `Hud.toggleHelp` の DOM 読みトグルを廃止。SettingsPanel/ObjectPicker/ContextMenu も状態フィールドを持たせ `style.display` 読みを廃止。
- **DockView を台帳に載せる際、`ViewManager` との二重管理にしないこと。**`ViewManager` は `isDockOpen` を持ち `current` をそこから導出する設計になっている(`view-manager.ts`)。ドックの開閉の**正本は `ViewManager`** とし、OverlayManager へは「開いた/閉じた」を通知するだけにする。逆向き(OverlayManager が閉じて `ViewManager` が知らない)を作らない。
- ContextMenu と PropertyWindow の役割を確定: **ContextMenu=「その場で 1 アクションを選ぶ使い捨て」(選択後必ず消える・状態を映さない)、PropertyWindow=「対象の継続観察と操作」(live 更新・クリップ可)**。同じ対象への右クリックはビューを問わず同じ種類の UI を開く(→ §7 質問2で戦闘ビューの扱いを確認)。空白右クリックのメニュー 2 実装(`Targeter.emptySpaceMenu` / `MapPicker.handleEmptySpaceRightClick`)を 1 実装へ。
- PropertyWindow の一時ウィンドウ排他台帳を `MapPicker` から OverlayManager へ移し、`perf-meter.ts` も同じ規則下に置く。
- **既存の共有物を作り直さないこと**: `hud/layout.ts` の `clampOverlayPosition`、`hud/shortcut-hint.ts` の `shortcutKeyLabel`、`hud/menu-actions.ts` の `MenuAction`+`MenuCommon`。いずれも既に単一実装で、OverlayManager はこれらを使う側になる。

**完了判定**: `window.addEventListener('keydown'` が `input.ts` と `launch-select.ts` 以外で 0 件。`document.addEventListener('pointerdown'` が `overlay-manager.ts` 以外で 0 件。`style.display ===` による状態判定が 0 件。

**効果**: 「ESC を押せば必ず一番手前が閉じる」「外を触れば一時的なものは消える」「モーダルの後ろは触れない」という予測可能性が全 UI で成立。

---

### 施策 6: レイアウト骨格の再構築(置き場 4 種+全パネル収納+safe-area 全面適用) [L]

**対象**: `src/game/hud/dom.ts`(STYLE の全面改稿と分割)、`hud/overlay-layer.ts`、`input/touch.ts` の配置 CSS、新設 `hud/viewport.ts`。

**変更方針**:
- 置き場を 4 種に確定する(§3)。`#hud-status`/`#hud-orbit`/`#hud-enemies` の絶対座標直書きを廃止し、`#hud-combat-shelf` を**常時 flex の棚として実体化**する(現在の `display:contents` による二重構造を廃止)。**シェルフをどの辺に置くかは画面クラス別に決める**: 広幅(pointer:fine)は現行の見た目を保つ下端、coarse/狭幅は現行実装どおり上端(下端は `#hud-stagestatus`・タッチパッド・PREDICT バーが既に取り合っており、現実装が上端に逃げたのはそのため)。ビュー別の表示規則(`#hud.map-mode #hud-status { display:none }` 等)と、狭幅時のみ `#hud-target` がシェルフ入りするメンバー差は維持条件として引き継ぐ。
- ドック幅・シェルフ高を CSS 変数化: `--rail-w-left`/`--rail-w-right`/`--shelf-h`。値の一本化ではなく**ブレークポイントごとに変数を再代入する**設計(狭幅用の別値は別値として残す — 全部を 300px に統一してはならない)。参照側(PREDICT バーの `calc`)はすべて変数参照になり、定義は各ブレークポイントの再代入 1 箇所ずつになる。施策3で導入した `--safe-*` を全要素へ適用する。
- すべてのパネルを共通 `PanelShell`(見出し+`CollapseToggle`+本文)に載せ、個別収納可能にする。折りたたみ状態は `localStorage`(`tepui.panelCollapsed`)へ永続。レールごと畳む現行トグルは維持(2 段階の収納)。
- ドックのタッチスクロール: `.hud-rail` に `pointer-events:auto` + `touch-action:pan-y` を与え、空き領域でもスクロール可能にする(カメラドラッグとの競合はレール領域が奪ってよい — レールはパネルの置き場であり 3D 操作面ではない)。
- `#hud .hud-dock > .panel[style*="display: none"]` を廃止し、非表示は `.hidden` クラスで表現する(哲学2の DOM 側規約)。
- 巨大 STYLE 文字列を「トークン注入/骨格(層・レール・シェルフ)/ウィジェット共通/パネル個別」の 4 ファイルに分割する。DockView/SaveBrowser の CSS は各自のファイルへ移動。
- 回転・リサイズ対応: `visualViewport` の resize/scroll を購読して `--safe-*`/`--vvh` を更新する小さなモジュール `hud/viewport.ts` を新設する(**購読者はこの 1 箇所のみ**。現状 `render/scene.ts`/`property-window.ts`/`context-menu.ts` が個別に `resize` を張っているので、後者2つは施策5で OverlayManager 側に寄せ、ここでは `viewport.ts` からの通知を受ける形にする)。

**効果**: どの画面サイズでも「置き場」が保たれ、以後のパネル追加が置き場の選択だけで済む。safe-area 問題が構造的に消える。

---

### 施策 7: 責務分割と命名の総整理 [M]

**施策4/5/6 の後に置く**(改名対象・分割線が確定してから着手する方が安い)。

**対象**: `hud/dom.ts`、`map-picker.ts`、`hud/settings-panel.ts`、`navball/navball-panel.ts`、`camera/overview-camera-panel.ts`、`object-list-panel.ts`、`display-time-panel.ts`、`frame-controls.ts`、`hud/panel.ts`、`plan/plan-editor.ts`、`creative/ship-placer-panel.ts`。

**変更方針**(改名はすべて旧名全文検索 0 件まで。CLAUDE.md / DEVELOP 文書も同一変更セットで更新):
- ファイル移設: `object-list-panel.ts` / `display-time-panel.ts` / `frame-controls.ts` を `hud/` 配下へ。**`anchor-zone.ts`/`rotation-zone.ts` が既に `hud/` にあるため、この移設で座標系 UI の 3 ファイルが同じ場所に揃う**(現状は 2 フォルダに分裂)。
- `SettingsPanel` → `PauseMenu`(実体に一致)。`ModalController` → `OverlayManager`(施策5)。
- **`NavballPanel` を廃止**し、天球グリッドトグルは `OverviewCameraPanel` 改め **`ViewOptionsPanel`(表示設定パネル)** に統合する(`querySelector` 相乗り+生成順依存を根絶。「表示」という 1 つの問いに答えるパネルは 1 枚)。`Navball.gridVisibility` の状態所有については `memos/hedalu244/refactoring_todo.md` の項目9と同じ論点なので、**どちらか一方の文書で決めて他方から消す**(重複管理しない)。
- `MapPicker`(926 行)を 3 分割: 候補集合と visibility(`MapPickables`)/ ヒットテストとメニュー構築(`MapContextActions`)/ ウィンドウ台帳(施策5で OverlayManager へ)。`map-pick.ts` は `map-pickable.ts` へ改名(型定義であることを名前に)。
- `HudPanels`(`panel.ts` の god オブジェクト)をパネル単位に分割(StatusPanel / OrbitPanel / TargetPanel / ContactsPanel)。軌道情報 3 系統は「戦闘=自艦 OrbitPanel、対象情報=PropertyWindow」の 2 系統に整理し、`#hud-target` の軌道行は PropertyWindow へ誘導する形に縮退。
- **PREDICT の呼び名 5 つを 1 つに統一**: id `hud-predict`、接頭辞 `predict-`、クラス名 `PredictPanel`、表示名 `PREDICT`。状態所有者 `DisplayWindowManager` は**改名しない**(こちらは「表示座標系+表示時刻の窓」を持つクラスであってパネルではない — パネル名との一致を狙うとかえって責務を誤解させる)。
- `dom.ts` は施策6の分割後、「HUD ルート構築+層生成」だけの `hud-root.ts` に改名。ヘルプ本文は `help-panel.ts` へ分離し、その際タッチ操作の語彙(長押し=メニュー、二本指ドラッグ=パン、ピンチ=ズーム、ダブルタップ=フォーカス — 施策2で確定するもの)を記載する。現状はキーボード操作表を coarse で丸ごと隠すだけで、**タッチ端末には操作説明が存在しない**。
- `result-screen.ts` の `showEnd`/`#hud-end` は `ResultScreen`/`#hud-result` に統一。
- `DockView` は造船ドックの意で維持し、画面端の `hud-dock-*` 側を `hud-rail-left/right`(`.hud-rail`)へ改名して同語二義を解消する。
- `PlanEditor`(844 行)からパネル DOM(`syncPanel` と Δv 入力)を `plan-panel.ts` に分離。`ShipPlacerPanel`(849 行)を「軌道要素フォーム」と「ラグランジュ点フォーム」に分割(`refactoring_todo.md` の同項目と重複するので、**着手時にどちらの文書で管理するかを決めて他方から消す**)。

**効果**: 「ファイル名=責務」が成立し、以後の改修で探索コストが消える。相乗り生成のような生成順依存バグの温床を根絶。

---

### 施策 8: 画面クラス別の最終仕上げとタッチ到達性の完了判定 [M]

**旧施策7に、旧施策5の後半(UI 側のタッチ到達性)を合流させた。**

**対象**: 施策6で分割した CSS、`dock-view.ts`、`save-browser.ts`、`object-picker.ts`、`property-window.ts`、`context-menu.ts`、`launch-select.ts`、`input/touch.ts`、`stage-utils/stage-status-panel.ts`。

**変更方針**:
- ブレークポイントを 3 クラスに確定し、名前を付けて全 CSS で共通使用: `compact`(幅 < 700px — スマホ縦)、`medium`(700〜1100px — スマホ横/iPad 縦)、`wide`(> 1100px)。加えて `coarse`(pointer:coarse)と `short`(高さ < 500px)を直交軸として併用。現行の 900/520px 混在を置換。
- 非レスポンシブ UI の本対応(施策3の応急処置を骨格に載せ替える): **DockView** = compact でヘッダ縦積み+部品グリッド 1 列+固定 120px/60px を `minmax` 化。**SaveBrowser** = compact で左右ペインをタブ切替に。**ObjectPicker** = compact ではトリガー直下でなく下端シート化。**PropertyWindow** = compact では画面下 40% のボトムシート(ドラッグ不要・クリップ概念は維持)。
- **compact 縦の既定表示**: 戦闘ビュー=グローバルステータス、ステージ状態パネル(HP/温度/電力)、タッチパッド、マーカー類のみ。ORBIT/CONTACTS は収納状態で開始。マップビュー=PREDICT バー+畳まれた左右レール。施策6の折りたたみ永続の初期値として実装する(ユーザーが開けば以後は開いたまま)。
- **タッチ到達性を 0 件にする**(施策2で残った分): スロットル段 1-4 = 戦闘シェルフに `SegmentedControl` として常設(→ §7 質問1)。放熱板/太陽電池 = `stage-status-panel` の既存 `.radiator-btn` を 44px 化して充てる(既にある)。リロード R / progradeReset F / followAttitude G / targetSelect T / ノード削除 X = 該当パネル・ウィンドウ内のボタンとして追加(ノード削除は軌道計画パネルと NodeGizmo メニューに既存 — 仮想キー不要)。ESC = 全モーダルに `CloseButton` があれば不要(施策5で保証)。F3/F5/F9 = 一時停止メニュー内の項目で代替済み。
- タッチ UI の出し入れ: `isTouchDevice` 常時表示をやめ、初回タッチ入力の検出で表示・マウス移動の検出で半透明化する(ハイブリッド端末での両立)。
- 仮想パッドの推力ラッチ表示: `.tbtn.on` の点灯と `syncModeButtons` の同期機構は既にあるので、**推力 6 ボタンへの配線だけを追加**する(`PlayerThrottle.latchedThrustKeys` を毎フレーム反映)。新機構は作らない。
- `launch-select.ts` の cssText 手書きレスポンシブをトークン+共通ブレークポイントに載せ替え。
- 検証マトリクス(§5)を全て通す。

**効果**: 目標 (a) の完成。3 クラス×2 軸の命名により、以後「どの画面で確認すべきか」が文書化される。

## 5. 検証

- 各施策とも `npm run typecheck` を必須とする。`src/physics/` には触れないので `test:physics` は不要(施策1では通したが、これは色定数の移動が physics に及ばないことの確認だった)。
- 見た目の検証はヘッドレス Chrome スクリーンショット(`/verify` の手順、CLAUDE.md の WebGPU フラグ)で以下のマトリクスを撮る: 375×667(スマホ縦)/ 667×375(スマホ横)/ 768×1024(iPad 縦)/ 1024×768(iPad 横)/ 1440×900(デスクトップ)。各サイズで 戦闘ビュー/マップビュー/DockView/SaveBrowser/一時停止メニュー の 5 画面。`--window-size` と `Emulation.setDeviceMetricsOverride`(pointer:coarse 模擬)を併用。
- タッチ操作の検証は CDP `Input.dispatchTouchEvent` で長押し→プロパティウィンドウ、二本指ドラッグ→パン、ピンチ→ズーム、ダブルタップ→フォーカスの 4 本をスモークとして流す(施策2の完了判定)。
- **施策ごとの完了判定 grep**(各施策の節にも再掲):
  - 維持義務(全施策): 色リテラルが `theme.ts`/`const.ts` の色定義節と §4 施策1に記した 2 件の意図的例外以外で 0 件(`#rrggbb`・`rgba()`・`0x` 形式)。
  - 施策2: coarse 用ピック定数が `const.ts` にあり、`matchMedia` の呼び出しが起動時 1 箇所。
  - 施策4: `.selected`/`.sel`/`.active`/`.held` が 0 件。`createElement('button')` と `type = 'range'/'number'/'text'` が `hud/widgets/` 以外で 0 件。
  - 施策5: `window.addEventListener('keydown'` が `input.ts`/`launch-select.ts` 以外で 0 件。`document.addEventListener('pointerdown'` が `overlay-manager.ts` 以外で 0 件。`style.display ===` による状態判定が 0 件。
  - 施策6: `vh` 単位の裸使用が 0 件(`dvh` フォールバック併記を除く)。`style*=` セレクタが 0 件。
  - 施策7: 旧名が 0 件。
- **回帰の観測点**: 「新しいパネルを足したら実装が分裂した」が第一版→第二版で実際に起きた(数値入力 4→5、状態語彙に `aria-pressed` 追加)。施策4以降は、**UI を追加する変更セットごとに施策4/5の grep を再実行する**ことを運用ルールとする。

## 6. 保留(今回やらないと決めたもの)

- マップビューの青写真/シンプル表示モード(`dev.md`)— 表示テーマの追加であり、トークン化が終わってから別計画で。
- DOM UI の MathJax 対応(`dev.md`)— 依存追加を伴い UI 骨格と独立。
- TRAJECTORY ウィンドウのプルダウン+検索+二次元グリッド化(`dev.md`)— ObjectPicker の compact シート化(施策8)とは別の機能追加。ウィジェット統一後に着手する方が安い。
- ゲームパッド対応 — タッチ対応(施策2)と入力層の抽象は共有できるが、要求が来るまで設計だけ意識して実装しない。
- モバイルの描画軽量化 — 軽量化計画の管轄。本計画は UI のみ。
- **再出撃サイクルのページ内完結**(`refactoring_todo.md`「再出撃サイクルの是正」)— ResultScreen が台帳に載る(施策5)のとリロード廃止は別問題。`Game` 再生成の設計判断を含むので UI 計画では扱わない。
- **`Navball.gridVisibility` の状態所有の是非** — 施策7で `ViewOptionsPanel` に統合する際、トグルの置き場は決まるが「グリッド可視状態を誰が持つか」は `refactoring_todo.md` 項目9 の論点。UI 側からは統合後の所有者候補を提示するに留める。

## 7. 確認したいこと(人間への質問)

第一版から未回答の 7 問はそのまま残っている(1〜7)。第二版で 2 問(8〜9)追加した。

1. 施策8の「スロットル段 SegmentedControl を戦闘シェルフに常設」はデスクトップでも表示される UI 追加になる。キーボード派には冗長かもしれない — 常設でよいか、タッチ時のみか。
2. 施策5で戦闘ビューの敵右クリックを ContextMenu から PropertyWindow に統一する提案は、戦闘中の視界占有が増える。戦闘中は従来どおり軽いメニューのままにする選択もある — どちらを取るか。
3. compact(スマホ縦)での既定「ORBIT/CONTACTS は収納で開始」(施策8)の閾値・初期選定に異論はないか。
4. `hud-dock-*` → `hud-rail-*` の改名(施策7)は localStorage キーや保存データには影響しないが、既存の目視デバッグ習慣(DevTools での id 検索)には影響する。改名の粒度はこれでよいか。
5. Δv 編集軸の色(パネル/3D ギズモの青/緑/赤)と戦闘ビューの軌道方向マーカー色(`COLOR_MARKER_PROGRADE/NORMAL/RADIAL` の灰/紫/シアン)は、同じ軸概念に二系統の色が併存している。将来どちらかに寄せて統一すべきか(寄せるなら、モノトーン基調のマーカー規約と衝突しない形をどう取るか)。
6. HUD に webfont を導入するか。施策1では Share Tech Mono を読み込みごと削除しシステム等幅スタックに統一した。ラテン文字だけでも専用書体を当てて世界観を強めたいなら、日本語部分との字面の差をどう扱うかを含めて別途決める必要がある。
7. 施策1で造船ドックの部品 HP 表示を「良 = モノトーン、注意 = 橙、危険 = 赤」に変えた(緑/橙/赤の信号機配色を廃止)。健全な部品が一目で「緑=OK」と読めなくなるが、この方針でよいか。
8. **施策の順序を第一版の一直線から組み替え、タッチのジェスチャ合成(旧施策5前半)を施策2へ前倒しした。**根拠は「機能の到達不能はスタイルの不統一より重い」「入力層の合成は他のどの施策にも依存しない」「タッチ実機で以後の UI を検証できるようになる」。見た目の一貫性を先に片付けたいという意図が別にあるなら、順序を戻す判断もありうる。どちらを取るか。
9. **`ValueInput` の Escape の扱い。**施策5で「Escape の意味は入力欄フォーカス中=編集破棄、それ以外=最前面を閉じる」の 2 つに確定し、`object-list-panel` の「Escape=検索クリア」を廃止する方針にした。ただし検索入力にフォーカスがある状態で Escape を押したとき、「入力の破棄(=検索前の文字列に戻る)」と「ウィンドウを閉じる」のどちらが自然かは検索欄では割れる(多くのアプリは前者、ただし検索欄では実質クリアと同義)。**検索用途の `ValueInput` だけ「Escape=空にする」を許す例外を認めるか、規約を厳守して ✕ ボタンに寄せるか。**
