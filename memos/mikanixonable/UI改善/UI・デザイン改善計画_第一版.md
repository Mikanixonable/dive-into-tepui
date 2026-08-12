# UI・デザイン改善計画 第一版

この文書は単体で読めるように書いてある。前提知識は「本リポジトリは TypeScript + Three.js WebGPU のブラウザゲームで、HUD は DOM オーバーレイである」ことのみ。施策番号は着手順序と一致させる(軽量化計画と同じ規約)。旧版は残さず、改版時はこのファイルを全面的に書き直して版数を上げる。

## 0. 結論の要約

- 目標は3つ: **(a) モバイル/iPad の縦横どの画面でも UI が崩れず、最重要 UI だけが出て残りは収納できる**、**(b) 全 UI(ウィンドウ・モーダル・ボタン・トグル・スライダー・バー)の配色/挙動/配置/粒度に単一の哲学から導かれる一貫性を与え、プレイヤーのメンタルモデルを成立させる**、**(c) それを支える UI コードを疎結合・一責務・素直な命名に書き換える**。
- 現状調査の結論: レスポンシブ対応は部分的に存在する(`dom.ts` に 5 本のメディアクエリ)が、**DockView / SaveBrowser / ObjectPicker / PropertyWindow は完全に非レスポンシブ**、`env(safe-area-inset-*)` は 0 件、回転時の JS 再レイアウトも 0 件。テーマは `theme.ts` が「唯一の定義元」を名乗りながら実際は色リテラルが数十箇所に散在し、フォントサイズ 22 種・角丸 8 種・ボタン実装 9 系統・トグル実装 6 系統・ESC の意味 4 通りに分裂している。タッチでは右クリック相当(プロパティウィンドウ/各種メニュー)とパンが**一切できない**。
- 解決は表面的なパッチではなく、**①デザイントークン → ②ウィジェット基盤 → ③レイアウト骨格 → ④ウィンドウ制度 → ⑤タッチ入力 → ⑥責務・命名整理 → ⑦画面別レスポンシブ仕上げ** の順に土台から作り直す。施策 1〜2 が完了するまで施策 3 以降の CSS を書かない(トークンなしで書いた CSS は全部書き直しになるため)。

## 1. デザイン哲学(全施策の判断基準)

以下の 7 原則が全施策の上位規範。実装中に迷ったらここに戻る。個別の見た目の趣味より原則の一貫性を優先する。

1. **一責務一 UI。** 1 つのウィンドウ/パネルは 1 つの問いに答える。「このパネルは何を答えるものか」を一文で言えないパネルは分割か廃止。
2. **状態の持ち主はクラス、DOM は表示。** `style.display` や class の有無を読んで開閉状態を判定するコードは禁止(現状ヘルプ・SettingsPanel・ObjectPicker・ドック折りたたみが違反)。
3. **開く/閉じる/重なりの規則は一人が持つ。** ESC・外側クリック・排他・入力ゲートは単一のオーバーレイ管理者が裁く。各ウィンドウが `document` に独自の keydown/pointerdown を張ることを禁止する。
4. **見た目はトークンからのみ導く。** 色・透明度段階・余白・角丸・フォントサイズ・トランジションはトークン(定数+CSS 変数)の有限集合から選ぶ。リテラル値の直書きを禁止する。
5. **レイアウトは流し込み+変数、固定 px は最終手段。** 位置は「ドック(左右の縦積み)/シェルフ(下端の横並び)/中央モーダル/画面固定バッジ」の 4 種の置き場のどれかに属させる。同じ長さを 2 箇所に書かない(現状ドック幅が 6 箇所に重複)。
6. **タッチは第一級入力。** すべての操作はタッチだけで完結できる。タップターゲットは最小 44px。ホバーは装飾であり情報を持たない(`title` 属性だけの説明を禁止)。
7. **名前は責務を言い切る。** 実装から乖離した名前・多義的な名前・歴史的経緯の名前は見つけ次第改名する(CLAUDE.md の「改名は痕跡を残さない」規約に従い、旧名は全文検索 0 件にする)。

## 2. 現状の問題(調査結果の要点、根拠付き)

実装者が現地確認する際の索引。行番号は 2026-08-12 時点の main 相当。

### 2-1. レイアウト・レスポンシブ
- viewport meta は `viewport-fit=cover` 付きで存在する(`public/index.html:5`)のに `env(safe-area-inset-*)` の使用が src 全体で 0 件。iPhone ノッチ/ホームバー、iPad ジェスチャバーに `bottom:12px` 系要素(タッチパッド `src/game/input/touch.ts:38-58`、`#hud-status` 等)が潜り込む。
- ドック幅の指定が `src/game/hud/dom.ts:57-58, 275`(基準値 `min(300px,30vw)`/`min(300px,33vw)`)に加え、ブレークポイント別の別値として `dom.ts:473-474, 490, 501-502, 511` にも散在する。CSS 変数化されていないため、幅を参照する側(PREDICT バーの `calc`)と定義する側の対応をブレークポイントごとに手で揃えており、変更が必ず漏れる。
- メディアクエリは `dom.ts:451-536` と `touch.ts:65-114` に存在(900px / 520px / pointer:coarse / landscape+max-height:500px)。ただし **`#dock-view`(dom.ts:537-663)、`#save-browser`(dom.ts:664-757)、`property-window.ts`、`object-picker.ts`(幅 520px 固定 — 375px 端末で画面外)、`context-menu.ts`、`node-gizmo.ts` にメディアクエリ 0 件**。`#dock-view .dock-part-row-main { grid-template-columns:1fr 120px 60px auto }`(dom.ts:622)は iPad 縦 768px 以下で潰れる。
- `#hud-object-list { max-height:544px }`(dom.ts:148)はどのメディアクエリでも上書きされず、横向き端末(高さ 375〜500px)で画面高を超える。
- `100vh`/`vh` のみ使用で `dvh` 未使用。iOS Safari のアドレスバー伸縮で `86vh`(dom.ts:399)等がずれる。
- `orientationchange` / `visualViewport` / `matchMedia` の購読は src 全体で 0 件(resize 購読は `render/scene.ts:25`, `property-window.ts:243`, `context-menu.ts:82` 等の少数のみ)。回転時に JS 側で再レイアウトする仕組みが存在しない。
- `pointer:fine` かつ幅 901〜1100px(マウス接続の狭いウィンドウ)では戦闘ビューの 228px×3 パネル(`#hud-status` left:12 / `#hud-orbit` left:252 / `#hud-enemies` right:12、dom.ts:113-125)が素のまま並び重なる。
- 収納できるのは左右ドック・PREDICT バー・オブジェクト一覧 body の 3 系統のみ(`dom.ts:823-844`)。`#hud-status`/`#hud-orbit`/`#hud-enemies`/`#hud-stagestatus`/`#navball`/MAP VIEW/座標系ほかは個別収納不可。
- `#hud .hud-dock > .panel[style*="display: none"]`(dom.ts:59)というインライン style 文字列マッチの壊れやすいセレクタが現役。
- ドック自体は `pointer-events:none` のまま `overflow-y:auto`(dom.ts:53)なので、ドックの空き領域を掴んでタッチスクロールできない。

### 2-2. テーマ・ウィジェット
- `theme.ts` は面/縁/文字/アクセントの色 12 定数のみ。hover・disabled 透明度・角丸・余白・フォント・トランジションのトークンは存在しない。`const.ts:513-548` に別系統の色 30 個超があり、`theme.ts:1` の「唯一の定義元」コメントは虚偽状態。
- `SURFACE`/`EDGE` と同名・別値のローカル定数が `context-menu.ts:10-11` と `touch.ts:12-13` に存在(touch.ts:10-11 のコメントは古い値 0.09 を引く化石)。体系外の色: `dock-view.ts:272` の Material 系 `#4caf50/#ff9800/#f44336`、`plan-editor.ts:151-159` の Tailwind 系 `#3b82f6/#10b981/#ef4444`(PRO/NRM/RAD なのに `COLOR_MARKER_*` と不一致)、`creative-stage.ts:252` の `#ff6a00` 直書き(ACCENT のハードコピー)ほか。
- アクセントの薄膜アルファが `.06〜.38` の **10 段階**、フォントサイズ **22 種**(8.8px, 10.4px, 14.67px 等の機械的縮小の名残を含む)、角丸 **8 種**、ボタン級 padding **11 通り**、transition **5 種**。
- トグル実装 **6 通り**(`HudToggle`/`HudToggleButton`/`IconToggleButton`/SegmentedControl 2 択代用/settings-panel の `.stoggle` 手書き/touch.ts の `.tbtn.on` 手書き)。選択状態のクラス語彙 **6 種**(`.on`/`.active`/`.sel`/`.selected`/`aria-pressed`/`data-pinned`)。
- ボタンの「押せる矩形」が 9 系統以上、閉じるボタンだけで 3 実装(`.dock-close-btn`/`.sb-close-btn`/`.sclose`)、タブ 3 実装、HP バー 4 実装、スライダー 3 実装、数値入力 4 実装。
- hover の表現 4 方式、`:active` があるのは 2 箇所のみ、disabled の透明度 3 値・カーソル 2 種。主力ボタン `.seg-btn` に hover 定義がない(dom.ts:239-247)。
- Enter=確定 / Escape=キャンセル / blur=確定 の規約に従うのは 2 箇所のみ(`display-time-panel.ts:60-67`, `property-window.ts:282-285`)。Escape の意味が「編集破棄/検索クリア/ポップを閉じる/ポーズメニュー開閉」の 4 通りに割れている。
- CSS クラス `seg-btn` は segmented control 専用の名でありながら全ボタンに付く汎用クラス(buttons.ts:6,75,106,139)。`hud-seg` も同様に流用され、打ち消し例外(dom.ts:313)を生んでいる。

### 2-3. ウィンドウ・モーダル制度
- モーダル台帳(`hud/modal-controller.ts:5`)に載るのは `help`/`settings`/`save-browser` の 3 つだけ。**ResultScreen(`#hud-end`)と DockView は台帳外**で、入力ゲートも排他も効かない。ResultScreen には閉じる手段自体がない。
- ESC の処理順は `game.ts:762-767` の呼び出し順ハードコード。加えて **`window` 直付け keydown が `Input` 本体(input.ts:77)と `launch-select.ts:112` の他に 3 箇所**(`context-menu.ts:94`, `property-window.ts:244`, `ship-placer-panel.ts:629`)あり、この順序の外で ESC を消費する。さらに input 要素直付けの keydown(フォーカス中のみ効く)が `object-picker.ts:99` / `display-time-panel.ts:62` / `property-window.ts:282-285`(rename)にある。単一の持ち主が存在しない。
- 外側クリックで閉じる判定も `context-menu.ts:86` / `property-window.ts:238` / `object-picker.ts:107` が独立に capture リスナを張る。
- 同じ艦を戦闘ビューで右クリックすると ContextMenu、マップで右クリックすると PropertyWindow(`targeter.ts:44` vs `map-picker.ts:57-58`)。役割分担が未確定。
- 軌道情報が 3 系統に散在: 戦闘 `#hud-orbit`(dom.ts:882)、マップの PropertyWindow「軌道」グループ(map-picker.ts:708)、`#hud-target` の相手軌道(panel.ts:273)。同じ `orbit-info.ts` を別 UI が別書式で表示。
- 「表示」パネルが二重定義: `OverviewCameraPanel`(title「表示」だが中身は天体クラス表示トグル、`overview-camera-panel.ts:30`)と `NavballPanel`(title「表示」だが中身は天球グリッドトグルで、前者の DOM に querySelector で相乗りし、無ければ id `navball` の別パネルを生成 — 生成順で ID もオーナーも変わる、`navball-panel.ts:20-27`)。
- 状態の持ち主が DOM: ヘルプ(`hud.ts:54` が `style.display` を読んでトグル)、SettingsPanel(`settings-panel.ts:100`)、ObjectPicker(`object-picker.ts:120,141`)、ドック折りたたみ(class が唯一の状態)。`modal-controller.ts:2-3` 自身が「computed style から状態を推測するのは誤り」と明言しているのに他所で現役。
- `PropertyWindow` の一時ウィンドウ排他(高々 1 枚)は `MapPicker.windows`/`tempWindowKey`(map-picker.ts:60-62)にあるが、同じクラスを使う PerfMeter(perf-meter.ts:56)は台帳外。
- `ModalController`(modal-controller.ts:47)はモーダルを開くたび `tepui-release-touch-inputs` イベントを発火し、`touch.ts:157` が押しっぱなしの仮想キーを全解放する契約がある(モーダルの下で仮想スラスタが焚きっぱなしになる事故の防止)。台帳外モーダル(ResultScreen/DockView)ではこの解放が働かない。
- `MenuAction` 型は既に `src/game/hud/menu-actions.ts` の単一 union + `MenuCommon` ファクトリに統一済みで、`map-picker.ts`/`targeter.ts`/`nav-target.ts`/`node-gizmo.ts`/`plan-editor.ts` はそこから import している(この点は問題なし — 実装時に別ファイルを新設して二重化しないこと)。

### 2-4. タッチ入力
- 仮想パッド(`input/touch.ts`)は並進 6・回転 6・モード 2(制動/微動)・FIRE・ZOOM・ユーティリティ 6(warp±/計画/ノードへ/ヘルプ/ホールド)を持つ。表示条件は `isTouchDevice()`(touch.ts:129-131)による常時表示。
- **右クリック相当の合成(長押し等)が存在しない**ため、タッチでは以下が不可能: マップのプロパティウィンドウ(map-picker.ts:252)、空域メニュー(:375)、ノードメニュー(node-gizmo.ts:194)、ターゲット指定(targeter.ts:232)、ナビターゲット(nav-target.ts:120)。**ゲームの中核操作の過半がタッチ不能**。
- パンは中ボタンドラッグ限定(input.ts:140-146)でタッチ不能。二本指ジェスチャはピンチ(ズーム)のみ実装(input.ts:126-135, 156-162)で二本指ドラッグ=パンは未実装。
- ダブルクリックはブラウザ `dblclick` 依存(input.ts:114-117)でタッチでは不安定。`object-list-panel.ts:449` の `dblclick`/`:454` の `contextmenu`、`save-browser.ts:223` の `dblclick` ロードはタッチ不能。
- 仮想ボタンが無い操作: スロットル段 1-4、放熱板 9/0、太陽電池 7/8、リロード R、targetSelect T、progradeReset F、followAttitude G、カメラロール、ノード削除 X、pauseMenu ESC、restart R、F3/F5/F9。
- タップターゲット 44px 未満: `.seg-btn` 実高 ~19px、`.icon-toggle-btn` min-width 20px、オブジェクト一覧行 ~16px、`.dock-toggle` 26px、`.toggle-track` 34×18、`.prop-window-btn` 18px。
- `IconToggleButton`/`HudToggleButton` の説明が `title` 属性のみ(buttons.ts:106,133)でタッチでは読めない。
- 右クリックのクリック判定閾値だけマジックナンバー 50(input.ts:196、他は `CLICK_MOVE_THRESHOLD=6`)。
- タッチ UI は safe-area 非考慮の固定 px 配置(touch.ts:34-58)。

### 2-5. 責務・命名
- `dom.ts` が 1035 行で、全パネルの CSS・レイアウト・ヘルプ本文・ドックトグル・SVG オーバーレイ生成が同居。
- `MapPicker` が picker を名乗りながらウィンドウ台帳・メニュー構築・アクション実行(設定を開く/艦艇配置を開く/複製)まで担う。`map-pick.ts` と `map-picker.ts` は一文字違いで別責務。
- `SettingsPanel` の実体は一時停止メニュー(pauseMenu キーで開き、終了・スナップショット・負荷表示を持つ)。
- `DockView`(造船ドック)と `hud-dock-left/right`(画面端パネル収納)で "dock" が同語二義。
- HUD パネルなのに `hud/` 外にあるファイル: `src/game/object-list-panel.ts`, `src/game/display-time-panel.ts`, `src/game/frame-controls.ts`。
- `DisplayTimePanel` は CSS 接頭辞 `dtp-`、id `hud-displaytime`、表示名 `PREDICT` の 3 つの呼び名を持つ。
- `theme.ts` の `TEXT`/`TEXT_DIM` を `dom.ts:4` が `INK`/`INK_SOFT` に別名輸入し、同じ色に 2 語彙。
- `PlanEditor` は 813 行でパネル・ギズモ・メニュー・入力処理を 1 クラスに持つ。

## 3. 理想状態(到達点の宣言)

- **画面の置き場は 4 種に還元される**: ①左右ドック(縦積み・折りたたみ可・タッチスクロール可)、②下端シェルフ(戦闘計器の横並び・狭幅では横スクロール)、③中央モーダル層(全画面 or センタリング、必ずオーバーレイ管理者の台帳に載る)、④画面固定バッジ(グローバルステータス/ビューバッジ/縮尺)。すべてのパネルはこのどれかに属し、絶対座標の直書きは④のみに許す。
- **すべてのパネルが個別に収納できる**。パネルは共通の `PanelShell`(見出し+折りたたみトグル+本文)に載り、折りたたみ状態はクラスが持ち localStorage に永続する。モバイル縦画面の既定は「最重要のみ展開」: 戦闘ビュー=ステージ状態+照準系マーカー+タッチパッド、マップビュー=PREDICT バー+ドック(全パネル収納状態)。
- **色・寸法はデザイントークンの有限集合**: 色 = アクセント2 + 警告1 + 面/縁/文字の各段階、アルファ 4 段、フォントサイズ 5 段、角丸 2 種、spacing 4 段、transition 2 種。CSS 変数として `#hud` ルートに注入され、TS 定数と同源。
- **ウィジェットは 1 役割 1 実装**: Button / ToggleSwitch / TabBar / CloseButton / Slider / ValueInput / HoldButton / SegmentedControl / CollapseToggle / Meter(バー)。選択状態は `.on`、無効は `.disabled` + `aria-disabled`、押下は `:active` 相当の共通クラス、確定/キャンセルは Enter/Escape/blur の単一規約。
- **オーバーレイは単一管理者**が ESC・外側クリック・排他・入力ゲートを裁き、全モーダル(ヘルプ/一時停止/セーブ/リザルト/造船)が台帳に載る。ContextMenu は「その場で 1 つ選ぶだけの使い捨てメニュー」、PropertyWindow は「対象を継続観察・操作するウィンドウ」と役割を確定し、同じ対象への右クリックはビューを問わず同じ種類の UI を開く。
- **タッチだけで全操作が完結する**: 長押し=右クリック、二本指ドラッグ=パン、ピンチ=ズーム、ダブルタップ=フォーカス。仮想パッドは safe-area を避け、全ボタン 44px 以上。キーボードは加速手段であって必須手段ではない。

## 4. 施策一覧(番号=着手順序)

### 施策 1: デザイントークンの単一定義と全リテラルの置換 [M]

**対象**: `src/game/theme.ts`(全面改稿)、`src/game/const.ts:513-548`(COLOR_* の整理)、色・寸法リテラルを持つ全ファイル(`dom.ts`, `context-menu.ts`, `touch.ts`, `object-picker.ts`, `property-window.ts`, `node-gizmo.ts`, `dock-view.ts`, `plan-editor.ts`, `save-browser.ts`, `launch-select.ts`, `result-screen.ts`, `display-time-panel.ts`, `marker-manager.ts`, `creative-stage.ts`, `lead-markers.ts`, `stage-status-panel.ts`, `panel.ts`)。

**変更方針**:
- `theme.ts` を「UI トークンの唯一の定義元」に実態を合わせる。追加するトークン: `ALPHA_HOVER`/`ALPHA_SELECTED`/`ALPHA_FILL`/`ALPHA_SHADOW`(アクセント薄膜は現行 10 段階 → 4 段に統合)、`FONT_XS/S/M/L/XL`(22 種 → 5 段。小数 px は全廃)、`RADIUS_S`(ボタン・入力)/`RADIUS_M`(パネル・ウィンドウ)、`SPACE_1〜4`(2/4/8/12px 相当)、`TRANSITION_FAST`/`TRANSITION_SLOW`、`HIT_TARGET_MIN`(44px)。
- 起動時に一度、`#hud` と `#touch-ui` のルートへ CSS 変数(`--accent`, `--surface`, `--edge`, `--font-m`, `--radius-s`, `--space-2`, `--dock-w-left`, `--dock-w-right`, `--safe-b` 等)として注入する関数を `theme.ts` に置く。以後の CSS はすべて `var(--…)` で書く。`ACCENT_RGB`(theme.ts:7)のような手動同期文字列は生成関数に置き換えて廃止。
- `context-menu.ts:10-11` と `touch.ts:12-13` の同名別値ローカル定数を削除し theme 参照に統一。`dock-view.ts:272` の Material 色は `COLOR_HUD_HP_OK/LOW` 系トークンへ置換。
- **Δv 軸の三色をトークン化する**: 現状、DOM パネル(`plan-editor.ts:151-159`)と 3D ギズモ(`plan-gizmo-3d.ts`)は既に PRO 青/NRM 緑/RAD 赤で一致しているが、値がリテラル二重書きである。この青/緑/赤の三色を `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL` トークンとして theme に定義し、両者をそこから参照させる。戦闘ビューの軌道方向マーカー色 `COLOR_MARKER_PROGRADE/NORMAL/RADIAL`(const.ts:526-528、灰/紫/シアン)は**別の語彙のまま変更しない**(あれは Δv 編集軸ではなく機体周囲の方位表示で、モノトーン基調+注意色の規約に属する)。同じ軸概念に二系統の色があること自体を解消したくなったら、それは本施策ではなく人間の判断を仰ぐ(§7 に質問として計上)。
- `const.ts` の `COLOR_*` のうち UI 汎用のもの(`COLOR_HUD_*`, `COLOR_TOUCH_*`)は theme へ移管し、マーカー個別色(`COLOR_MARKER_*`)とステージ演出色(`COLOR_STAGE0_GROUP_ACCENTS`)は const 側に残して theme から再輸出しない(ゲームプレイ定数とテーマの境界を明確化)。依存方向は const → theme を禁じ **theme が UI 色の定義元、const は theme の UI 色を参照しない**(現状は theme.ts が const.ts の色を再輸出しており逆 — `ACCENT = C.COLOR_ACCENT` 等を theme 側の直定義に反転し、ゲームプレイ側が同じ色を使う場合は theme から import する)。`dom.ts:4` の `INK`/`INK_SOFT` 別名輸入は廃止し `TEXT`/`TEXT_DIM` に統一。
- フォントの整合: `theme.ts:18` の `FONT` は `'JetBrains Mono', 'HackGen', monospace` だがどちらの webfont もロードされておらず、逆に `public/index.html:7` が Google Fonts から Share Tech Mono をロードしているのにどこからも参照されていない。**Share Tech Mono を採用して `FONT` の先頭に入れるか、ロードごと削除するかを一意に決め**(推奨: 採用 — モバイル実機は両フォント未インストールで素の monospace に落ちるため、唯一ロード済みの webfont を使う)、`FONT` トークンと index.html を一致させる。
- 置換は機械的に全件(白黒の薄膜 rgba も `--fill-1〜4` 系へ)。完了判定: `#` 色コード・`rgba(` リテラルの grep が theme.ts と const.ts の色定義節(COLOR_MARKER_*/COLOR_STAGE0_*)以外で 0 件。

**効果**: 以後の全施策の CSS がトークンで書ける。配色一貫性の物理的保証(逸脱はコンパイル/grep で検出可能)。ダーク基調+橙アクセント+シアン第二色という既存の良い決定はそのまま維持する。

### 施策 2: ウィジェット基盤の統一 [L]

**対象**: `src/game/hud/buttons.ts`(改組)、新設 `src/game/hud/widgets/`(または buttons.ts の拡張。ファイル分割は 1 ウィジェット 1 ファイル)、既存の手書きウィジェット全箇所(`settings-panel.ts:28-72` の `.stoggle`、`touch.ts` の `.tbtn`、`dock-view.ts`/`save-browser.ts` の生 `<button>`、スライダー 3 実装、HP バー 4 実装、数値入力 4 実装、閉じるボタン 3 実装、タブ 3 実装)。

**変更方針**:
- ウィジェットを次の 10 種に確定し、それ以外の「押せる/切り替えられる/入力できる DOM」の自作を禁止する:
  1. `Button`(単発。現 `hudButton`)
  2. `ToggleSwitch`(ON/OFF。現 `HudToggle` のトラック+ノブ型に一本化。`HudToggleButton`・`IconToggleButton`・`.stoggle`・`.tbtn` の点灯型は「ボタンだが状態を持つ」= `Button` の `on` 状態表示に統合)
  3. `SegmentedControl`(3 択以上の排他。2 択の ON/OFF に使うことを禁止 → ToggleSwitch へ)
  4. `TabBar`(タブ切替。dock-view / save-browser / launch-select の 3 実装を統合)
  5. `CloseButton`(✕。3 実装統合、44px タップ領域)
  6. `Slider`(display-time-panel の予測区間グラデ機能を持つ 1 実装に統合。settings-panel/ship-placer は同実装のオプション)
  7. `ValueInput`(数値/文字入力。`DurationValueInput` を汎用化。**Enter=確定、Escape=破棄、blur=確定** を唯一の規約とし、4 実装を統合)
  8. `HoldButton`(押しっぱなし。現 `HudHoldButton`)
  9. `CollapseToggle`(現 `buildCollapseToggle` を維持。property-window/object-list の独自折りたたみもこれへ)
  10. `Meter`(HP/温度/電力バー。4 実装統合。「バーは常に左から右へ満ちる・危険は WARNING 色」の規約)
- 状態クラス語彙を統一: 選択/点灯=`.on`、押下中=`.pressed`(JS 付与。タッチと `:active` の差を吸収)、無効=`.disabled` + `aria-disabled`。`.active`/`.sel`/`.selected`/`data-pinned` は全廃(改名は全文検索 0 件まで)。
- 状態遷移の視覚規約を 1 箇所の CSS で定義: hover=文字/縁がアクセント化(装飾のみ、情報を載せない)、pressed=背景 `--fill-3`、on=背景アクセント薄膜+縁アクセント、disabled=opacity `--alpha-disabled` 単一値+`cursor:not-allowed`。全ウィジェットがこの 1 定義を継承し、個別 CSS での上書きを禁止。
- CSS クラス名を責務に合わせて改名: `seg-btn` → `w-btn`(汎用ボタン)、`hud-seg` → `w-group`。`pointerdown` の `stopPropagation`(カメラドラッグ抑止)はウィジェット基底で一度だけ書く。
- タップターゲット: すべての操作要素は視覚サイズに関わらず 44px 以上のヒット領域を持つ(padding か疑似要素で拡張)。`title` のみの説明は、長押しでツールチップ表示(施策 5 の長押し基盤に載せる)か常時ラベルに置換。

**効果**: 「同じ見た目は同じ挙動、同じ挙動は同じ見た目」というメンタルモデルの土台。以後の画面改修でウィジェットを書く作業が消える。ARIA が全ウィジェットに揃う。

### 施策 3: レイアウト骨格の再構築(置き場 4 種+全パネル収納+safe-area) [L]

**対象**: `src/game/hud/dom.ts`(STYLE の全面改稿と分割)、`src/game/hud/overlay-layer.ts`、`src/game/input/touch.ts` の配置 CSS、`public/index.html`。

**変更方針**:
- 置き場を 4 種に確定する(§3 理想状態)。`#hud-status`/`#hud-orbit`/`#hud-enemies` の絶対座標直書き(dom.ts:113-125)を廃止し、シェルフ `#hud-combat-shelf` を常時実体化する(現在は狭幅時のみ flex の棚として実体化し、広幅では `display:contents` で子を絶対配置する二重構造 — これを廃止し、常に flex の棚とする)。**シェルフをどの辺に置くかは画面クラス別に決める**: 広幅(pointer:fine)は現行の見た目を保つ下端、coarse/狭幅は現行実装どおり上端(`dom.ts:458` `top:76px` — 下端は `#hud-stagestatus`(中央)・タッチパッド(touch.ts の bottom:6-12px 群)・PREDICT バーが既に取り合っており、現実装が上端に逃げたのはそのため)。ビュー別の表示規則(`#hud.map-mode #hud-status { display:none }` 等)と、狭幅時のみ `#hud-target` がシェルフ入りするメンバー差は維持条件として引き継ぐ。
- ドック幅・シェルフ高・下端余白を CSS 変数化: `--dock-w-left`/`--dock-w-right`/`--shelf-h`/`--safe-t`/`--safe-b`(`env(safe-area-inset-*)` を合成)。値の一本化ではなく**ブレークポイントごとに変数を再代入する**設計(現状の 473-474/490/501-502 は狭幅用の別値であり、全部を 300px に統一してはならない)。参照側(PREDICT バーの `calc(12px + min(300px,30vw) + 8px)` 等)はすべて変数参照に変わり、定義は各ブレークポイントの再代入 1 箇所ずつになる。
- すべてのパネルを共通 `PanelShell`(見出し+CollapseToggle+本文)に載せ、個別収納可能にする。折りたたみ状態は `localStorage`(`tepui.panelCollapsed`)へ永続。ドックごと畳む現行トグルは維持(2 段階の収納)。
- `vh` を `dvh` に置換(フォールバック併記)。`#hud-object-list { max-height:544px }` は `max-height: min(544px, 60dvh)` 系へ。
- ドックのタッチスクロール: `.hud-dock` に `pointer-events:auto` + `touch-action:pan-y` を与え、空き領域でもスクロール可能にする(カメラドラッグとの競合はドック領域が奪ってよい — ドックはパネルの置き場であり 3D 操作面ではない)。
- `#hud .hud-dock > .panel[style*="display: none"]`(dom.ts:59)を廃止し、非表示は `.hidden` クラスで表現(施策の哲学 2「状態の持ち主はクラス」の DOM 側規約)。
- 巨大 STYLE 文字列を「トークン注入/骨格(層・ドック・シェルフ)/ウィジェット共通/パネル個別」の 4 ファイルに分割(dom.ts 分割の第一歩。パネル個別 CSS は将来的に各パネルのモジュールへ移す)。DockView/SaveBrowser の CSS は各自のファイルへ移動。
- 回転・リサイズ対応: `visualViewport` の resize/scroll を購読して `--safe-*`/`--vvh` を更新する小さなモジュール `hud/viewport.ts` を新設(購読者はこの 1 箇所のみ)。

**効果**: どの画面サイズでも「置き場」が保たれ、以後のパネル追加が置き場の選択だけで済む。iPhone/iPad の safe-area 問題が構造的に消える。

### 施策 4: オーバーレイ制度の統一(モーダル台帳・ESC・外側クリック・役割確定) [L]

**対象**: `src/game/hud/modal-controller.ts`(拡張 → `overlay-manager.ts` に改名)、`src/game/hud/context-menu.ts`、`src/game/hud/property-window.ts`、`src/game/hud/object-picker.ts`、`src/game/hud/result-screen.ts`、`src/game/hud/dock-view.ts`、`src/game/hud/save-browser.ts`、`src/game/hud/settings-panel.ts`、`src/game/hud/hud.ts`(ヘルプ)、`src/game/creative/ship-placer-panel.ts:631`、`src/game/game.ts:759-801`(handleInput の ESC 分配)、`src/game/map-picker.ts`(ウィンドウ台帳)。

**変更方針**:
- `OverlayManager`(現 ModalController の後継)に全オーバーレイを登録制にする: モーダル(help/pause/save-browser/result/dock-view)、ポップアップ(ContextMenu/ObjectPicker)、ウィンドウ(PropertyWindow — PerfMeter 含む)。登録時に「ESC で閉じるか」「外側クリックで閉じるか」「入力ゲートするか」「排他グループ」を宣言する。
- **ESC は既存の入力経路に載せたまま持ち主を一人にする**: OverlayManager は自前の window keydown を張らない(施策自身が禁じる document 直付けになるうえ、`Input` のエッジキュー(first-come-first-served 消費)と同フレームで競合するため)。`Game.handleInput` が `input.takeKey(K.pauseMenu)` で取った ESC を **OverlayManager にそのまま渡し**、OverlayManager がスタック最上位のオーバーレイに配送する — `game.ts:762-767` の順序ハードコードは「開いているものがあれば最上位を閉じる → 何も無ければ pauseMenu を開く」の 1 規則に還元される。例外は入力欄フォーカス中の element-level keydown(ValueInput の Enter/Escape — これは施策 2 の規約)のみ。UI モジュールの `window` 直付け keydown(`context-menu.ts:94`, `property-window.ts:244`, `ship-placer-panel.ts:629`)は全廃(`launch-select.ts:112` はタイトル画面でオーバーレイ制度の外、`input.ts:77` は入力層本体なので対象外)。外側クリックの capture pointerdown 3 箇所(§2-3)は OverlayManager の 1 組に集約。
- `ModalController` が持つ `tepui-release-touch-inputs` 発火(モーダルを開いた瞬間に押しっぱなしの仮想キーを全解放する契約、modal-controller.ts:47 → touch.ts:157)は OverlayManager に引き継ぎ、台帳に加わる ResultScreen / DockView が開くときにも発火するようにする。
- Escape の意味を 2 つに確定: 入力欄フォーカス中=編集破棄(ValueInput の規約)、それ以外=最前面のオーバーレイを閉じる(何も無ければ一時停止メニューを開く)。「検索クリア」等の第三の意味は廃止。
- ResultScreen を台帳に載せ、閉じる手段(再出撃/タイトルへ の明示ボタン)を持たせる。ヘルプは `HelpPanel` クラス化し `Hud.toggleHelp` の DOM 読みトグルを廃止。SettingsPanel は状態フィールドを持たせ `style.display` 読みを廃止。
- ContextMenu と PropertyWindow の役割を確定: **ContextMenu=「その場で 1 アクションを選ぶ使い捨て」(選択後必ず消える・状態を映さない)、PropertyWindow=「対象の継続観察と操作」(live 更新・クリップ可)**。この規約に従い、戦闘ビューの敵右クリック(targeter.ts)もマップと同じ PropertyWindow を開くよう統一する(項目はビューに応じて `itemsFor` が出し分け — 同じ対象は常に同じ窓)。空白右クリックのメニューは combat/map の 2 実装(`Targeter.emptySpaceMenu` / `MapPicker.handleEmptySpaceRightClick`)を 1 実装へ。
- `MenuAction` は既存の `src/game/hud/menu-actions.ts`(単一 union + `MenuCommon`)をそのまま維持する。別ファイルの新設・二重化をしないこと。
- PropertyWindow の一時ウィンドウ排他台帳を MapPicker から OverlayManager へ移し、PerfMeter も同じ規則下に置く。

**効果**: 「ESC を押せば必ず一番手前が閉じる」「外を触れば一時的なものは消える」「モーダルの後ろは触れない」という予測可能性が全 UI で成立。ウィンドウ関連の後続改修が 1 箇所で済む。

### 施策 5: タッチ入力の第一級化 [L]

**対象**: `src/game/input/input.ts`、`src/game/input/touch.ts`、`src/game/const.ts`(閾値定数)、`src/game/object-list-panel.ts:449,454`(施策 6 の hud/ 移設前なので `game/` 直下にある)、`src/game/hud/save-browser.ts:223`、投影ピック半径を持つ各所(`map-picker.ts`/`targeter.ts`/`node-gizmo.ts`)。

**変更方針**:
- **長押し=右クリック**: `Input` の pointer 処理に「`pointerType==='touch'` で 500ms 静止(移動 < CLICK_MOVE_THRESHOLD)したら `pendingRightClicks` へ積み、以後のクリック化を抑止」を追加。既存の右クリック消費側(map-picker/targeter/nav-target/node-gizmo)は無改修で動く(エッジキューの下で合成するため)。長押し開始 300ms でハプティクス代わりの視覚リング(マーカー層)を出す。
- **二本指ドラッグ=パン**: 現行ピンチ実装(input.ts:126-162)を拡張し、2 本指の重心移動を `panDx/panDy` へ、間隔変化を `wheel` へ同時に折り込む(排他にしない — 実指は回しながら開く)。これで中ボタン専用だったパンがタッチ可能になる。
- **ダブルタップ**: ブラウザ `dblclick` 依存をやめ、`Input` が自前でタップ 2 連(400ms/24px 以内)を `pendingDoubleClicks` に合成(マウスは現行 `dblclick` 経路を維持)。`object-list-panel.ts` の `dblclick`/`contextmenu` 直付けと `save-browser.ts:223` は、それぞれ行タップ選択+長押しメニュー/明示ロードボタンに置換。
- 右クリック閾値のマジックナンバー 50(input.ts:196)に名前を付けて `const.ts` へ移す(**命名のみ。値は 50 のまま変えない** — 右ドラッグ後でもクリック扱いを許す意図的に緩い値であり、6 に揃えるとデスクトップの右クリック感触が変わる)。
- **投影ピック半径の coarse 拡大**: タップターゲット 44px の原則を DOM ボタンだけでなく screen-projected なピック閾値にも適用する。`pointer:coarse` のとき `MAP_PICK_PX_SQ`・`TARGET_LOCK_PICK_PX_SQ`・NodeGizmo のハンドル/アーム径を係数で拡大(定数は const.ts に coarse 用を並置し、選択は起動時の matchMedia 一回)。指でマップのラベル・AN/DN・アプシス・ノードを狙えることが施策 5 の完了条件に含まれる。
- 仮想ボタンの欠落を埋める(§2-4 の一覧)。ただし全部をボタンにせず、次の方針で: スロットル段 1-4 = 戦闘 HUD のシェルフに `SegmentedControl`(タッチ/マウス共通の常設 UI に昇格 — キーの複製ではなく「タッチでも押せる本物の UI」を作る)。放熱板/太陽電池 = ステージ状態パネルの既存ボタン(radiator-btn)を 44px 化して充てる(既にある)。リロード R / progradeReset F / followAttitude G / targetSelect T / ノード削除 X = 該当パネル・ウィンドウ内のボタンとして追加(例: ノード削除は軌道計画パネルと NodeGizmo メニューに既存 — 仮想キー不要と確定)。ESC = 全モーダルに CloseButton があれば不要(施策 4 で保証)。F3/F5/F9 = 一時停止メニュー内の項目で代替済み(settings-panel)。**「キーボード専用機能を数えるのではなく、タッチで到達できない“機能”を数えて 0 にする」**を完了条件とする。
- タッチパッドの safe-area 対応(`--safe-b` 参照)と、`isTouchDevice` 常時表示の見直し: 初回タッチ入力の検出で表示・マウス移動の検出で半透明化(ハイブリッド端末で両立)。
- 仮想パッドの推力ラッチ表示: `.tbtn.on` の点灯 CSS と `syncModeButtons` の同期機構は既にある(touch.ts:33,134-)ので、**推力 6 ボタンへの配線だけを追加**する(ラッチ状態 `PlayerThrottle.latchedThrustKeys` を毎フレーム `.on` に反映)。新機構は作らない。

**効果**: タッチだけで全機能に到達可能になり、iPad が一級のプレイ環境になる。長押し/二本指の合成は Input のエッジキュー内で行うため、消費側 30 箇所超は無改修。

### 施策 6: 責務分割と命名の総整理 [M]

**対象**: `src/game/hud/dom.ts`、`src/game/map-picker.ts`、`src/game/hud/settings-panel.ts`、`src/game/navball/navball-panel.ts`、`src/game/camera/overview-camera-panel.ts`、`src/game/object-list-panel.ts`、`src/game/display-time-panel.ts`、`src/game/frame-controls.ts`、`src/game/hud/panel.ts`、`src/game/plan/plan-editor.ts`。

**変更方針**(改名はすべて旧名全文検索 0 件まで。CLAUDE.md / DEVELOP 文書も同一変更セットで更新):
- ファイル移設: `object-list-panel.ts` / `display-time-panel.ts` / `frame-controls.ts` を `hud/` 配下へ(HUD パネルは hud/ に置くという規約の成立)。
- `SettingsPanel` → `PauseMenu`(実体に一致)。`ModalController` → `OverlayManager`(施策 4)。`NavballPanel` → 廃止し、天球グリッドトグルは `OverviewCameraPanel` 改め **`ViewOptionsPanel`(表示設定パネル)** に統合(現状の querySelector 相乗り+生成順依存を根絶。「表示」という 1 つの問いに答えるパネルは 1 枚)。
- `MapPicker` を 3 分割: 候補集合と visibility(`MapPickables`)/ ヒットテストとメニュー構築(`MapContextActions`)/ ウィンドウ台帳(施策 4 で OverlayManager へ)。`map-pick.ts` は `map-pickable.ts` へ改名(型定義であることを名前に)。
- `HudPanels`(panel.ts の god オブジェクト)をパネル単位に分割(StatusPanel / OrbitPanel / TargetPanel / ContactsPanel)。軌道情報 3 系統(§2-3)は「戦闘=自艦 OrbitPanel、対象情報=PropertyWindow」の 2 系統に整理し、`#hud-target` の軌道行は PropertyWindow へ誘導する形に縮退。
- `DisplayTimePanel` の 3 つの呼び名を「PREDICT」に統一(id `hud-predict`、接頭辞 `predict-`、クラス名 `PredictPanel`)。
- `dom.ts` は施策 3 の分割後、「HUD ルート構築+層生成」だけの `hud-root.ts` に改名。ヘルプ本文は `help-panel.ts` へ分離し、その際タッチ操作の語彙(長押し=メニュー、二本指ドラッグ=パン、ピンチ=ズーム、ダブルタップ=フォーカス — 施策 5 で確定するもの)を記載する。現状はキーボード操作表を coarse で丸ごと隠すだけ(`#hud-controls { display:none }`)で、タッチ端末には操作説明が存在しない。
- `result-screen.ts` の `showEnd`/`#hud-end` は `ResultScreen`/`#hud-result` に統一。
- `DockView` は造船ドックの意で維持し、画面端の `hud-dock-*` 側を `hud-rail-left/right`(`.hud-rail`)へ改名して同語二義を解消(パネル収納側を rail と呼ぶ)。
- `PlanEditor`(813 行)からパネル DOM(`syncPanel`)を `plan-panel.ts` に分離(編集ロジックと表示の分割。ギズモは既に node-gizmo.ts で分離済み)。

**効果**: 「ファイル名=責務」が成立し、以後の改修で探索コストが消える。相乗り生成(NavballPanel)のような生成順依存バグの温床を根絶。

### 施策 7: 画面クラス別の最終仕上げ(モバイル縦/横・iPad・デスクトップ) [M]

**対象**: 施策 3 で分割した CSS、`dock-view.ts`、`save-browser.ts`、`object-picker.ts`、`property-window.ts`、`context-menu.ts`、`launch-select.ts`。

**変更方針**:
- ブレークポイントを 3 クラスに確定し、名前を付けて全 CSS で共通使用: `compact`(幅 < 700px — スマホ縦)、`medium`(700〜1100px — スマホ横/iPad 縦)、`wide`(> 1100px)。加えて `coarse`(pointer:coarse)と `short`(高さ < 500px)を直交軸として併用。現行の 900/520px 混在を置換。
- 非レスポンシブ 4 UI の対応: **DockView** = compact でヘッダ縦積み+部品グリッド 1 列+`grid-template-columns` の固定 120px/60px を `minmax` 化。**SaveBrowser** = compact で左右ペインをタブ切替(スロット一覧⇄スナップショット)に。**ObjectPicker** = `width:min(520px, calc(100vw - 24px))`+compact ではトリガー直下でなく下端シート化。**PropertyWindow** = compact では画面下 40% のボトムシート(ドラッグ不要・クリップ概念は維持)。
- **compact 縦の既定表示(最重要 UI の選定)**: 戦闘ビュー=グローバルステータス、ステージ状態パネル(HP/温度/電力)、タッチパッド、マーカー類のみ。ORBIT/CONTACTS パネルは収納状態で開始。マップビュー=PREDICT バー+畳まれた左右レール。この既定は施策 3 の折りたたみ永続の初期値として実装(ユーザーが開けば以後は開いたまま)。
- `launch-select.ts` の cssText 手書きレスポンシブをトークン+共通ブレークポイントに載せ替え。
- 検証マトリクス(§5)を全て通す。

**効果**: 目標 (a) の完成。3 クラス×2 軸の命名により、以後「どの画面で確認すべきか」が文書化される。

## 5. 検証

- 各施策とも `npm run typecheck` を必須とする。`src/physics/` には触れないので `test:physics` は不要。
- 見た目の検証はヘッドレス Chrome スクリーンショット(`/verify` の手順、CLAUDE.md の WebGPU フラグ)で以下のマトリクスを撮る: 375×667(スマホ縦)/ 667×375(スマホ横)/ 768×1024(iPad 縦)/ 1024×768(iPad 横)/ 1440×900(デスクトップ)。各サイズで 戦闘ビュー/マップビュー/DockView/SaveBrowser/一時停止メニュー の 5 画面。`--window-size` と `Emulation.setDeviceMetricsOverride`(pointer:coarse 模擬)を併用。
- タッチ操作の検証は CDP `Input.dispatchTouchEvent` で長押し→プロパティウィンドウ、二本指ドラッグ→パン、ピンチ→ズームの 3 本をスモークとして流す。
- 完了判定 grep: 色リテラルが theme.ts と const.ts の色定義節以外で 0 件(施策 1)、`.active`/`.sel`/`.selected` 0 件(施策 2)、`window.addEventListener('keydown'` が `input.ts`(入力層本体)と `launch-select.ts`(タイトル画面)以外で 0 件(施策 4 — OverlayManager 自身も張らない)、旧名 0 件(施策 6)。

## 6. 保留(今回やらないと決めたもの)

- マップビューの青写真/シンプル表示モード(dev.md 269-275 行)— 表示テーマの追加であり、本計画のトークン化が終わってから別計画で。
- DOM UI の MathJax 対応(dev.md 281 行)— 依存追加を伴い UI 骨格と独立。
- TRAJECTORY ウィンドウのプルダウン+検索+二次元グリッド化(dev.md 330-341 行)— ObjectPicker の compact シート化(施策 7)とは別の機能追加。ウィジェット統一後に着手する方が安い。
- ゲームパッド対応 — タッチ対応(施策 5)と入力層の抽象は共有できるが、要求が来るまで設計だけ意識して実装しない。
- モバイルの描画軽量化(dev.md 65 行「実装はせず相談したい」)— 軽量化計画の管轄。本計画は UI のみ。

## 7. 確認したいこと(人間への質問)

1. 施策 5 の「スロットル段 SegmentedControl を戦闘シェルフに常設」はデスクトップでも表示される UI 追加になる。キーボード派には冗長かもしれない — 常設でよいか、タッチ時のみか。
2. 施策 4 で戦闘ビューの敵右クリックを ContextMenu から PropertyWindow に統一する提案は、戦闘中の視界占有が増える。戦闘中は従来どおり軽いメニューのままにする選択もある — どちらを取るか。
3. compact(スマホ縦)での既定「ORBIT/CONTACTS は収納で開始」(施策 7)の閾値・初期選定に異論はないか。
4. `hud-dock-*` → `hud-rail-*` の改名(施策 6)は localStorage キーや保存データには影響しないが、既存の目視デバッグ習慣(DevTools での id 検索)には影響する。改名の粒度はこれでよいか。
5. Δv 編集軸の色(パネル/3D ギズモの青/緑/赤)と戦闘ビューの軌道方向マーカー色(`COLOR_MARKER_PROGRADE/NORMAL/RADIAL` の灰/紫/シアン)は、同じ軸概念に二系統の色が併存している。施策 1 では前者のトークン化のみ行い後者は触らないが、将来どちらかに寄せて統一すべきか(寄せるなら、モノトーン基調のマーカー規約と衝突しない形をどう取るか)。
