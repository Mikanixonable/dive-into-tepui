# UI・デザイン改善計画 第三版

この文書は単体で読めるように書いてある。前提知識は「本リポジトリは TypeScript + Three.js WebGPU のブラウザゲームで、HUD は DOM オーバーレイである」ことのみ。旧版は残さず、改版時はこのファイルを全面的に書き直して版数を上げる。実地確認は 2026-08-14 時点のコードによる。

## 0. 結論の要約

**施策1〜8はすべて完了した。** 目標(a) モバイル/iPad のどの画面でも UI が崩れず最重要 UI だけが出て残りは収納できる、(b) 全 UI の配色/挙動/配置/粒度に単一の哲学から導かれる一貫性がある、(c) それを支える UI コードが疎結合・一責務・素直な命名である、の3つは達成した。規約そのものの正本は実装完了にあわせて `DEVELOP/DESIGN-RULES.md` へ書き起こし、`.claude/skills/ui-design/SKILL.md` から参照する形に切り替えている——**この計画書はもう規約の正本ではなく、8施策をどう完了させたかの記録**であり、以後の判断は `DESIGN-RULES.md` を読む。

到達した骨格:
- **トークン**: `theme.ts` が唯一の定義元。UI の CSS 文字列に色/寸法リテラルは残っていない(§4 施策1)。
- **ウィジェット**: `hud/widgets/`(12ファイル)の10種のみが押せる/切り替えられる/入力できる DOM を持つ。状態語彙は `.on`/`.pressed`/`.disabled` の3つに統一(§4 施策4)。
- **オーバーレイ**: `hud/overlay-manager.ts` の `OverlayManager` が全モーダル/ポップアップ/ウィンドウの ESC・外側クリック・排他・入力ゲートを一元管理(§4 施策5)。
- **レイアウト**: レール/戦闘シェルフ/中央モーダル/画面固定バッジの4種の置き場に還元され、`hud/breakpoints.ts` の `compact`/`medium`/`wide` × `coarse`/`short` へブレークポイントを統一(§4 施策6)。
- **タッチ**: `input/input.ts` が長押し=右クリック・二本指ドラッグ=パン・ダブルタップの3ジェスチャを合成し、タッチのみでゲームの全操作に到達できる(§4 施策2・8)。
- **命名**: `map-picker.ts`(926行)は候補集合+visibility(`object-pickables.ts`、197行)とヒットテスト+メニュー(`object-windows.ts`、816行)へ、`hud/panel.ts` の `HudPanels` は `StatusPanel`/`OrbitPanel`/`TargetPanel`/`ContactsPanel`/`GlobalStatusBar`/`MapScaleBadge` の6クラスへ、`hud/dom.ts`(1036行)は骨格構築(`hud-root.ts`)/骨格CSS(`skeleton-style.ts`)/パネル内容CSS(`panel-content-style.ts`)/寸法変数(`layout-tokens.ts`)へ分割した(§4 施策7)。

**完全にはやり切れなかった部分、既知の未検証範囲は §2 に列挙する。** 隠さず記録する——特に `creative/ship-placer-panel.ts`(844行)は分割の対象だったが未着手のまま残っている。

## 1. デザイン哲学(全施策の判断基準)

以下の7原則は実装済みの規約として `DEVELOP/DESIGN-RULES.md` §1 にそのまま持ち上げてあり、以後の判断はそちらを読む(この節は要点のみ)。

1. 一責務一 UI。
2. 状態の持ち主はクラス、DOM は表示(`style.display` を読んで分岐しない)。
3. 開く/閉じる/重なりの規則は `OverlayManager` 一人が持つ。
4. 見た目はトークン(`theme.ts`)からのみ導く。
5. レイアウトは流し込み+変数、固定 px は画面固定バッジと中央モーダルの中央寄せだけの最終手段。
6. タッチは第一級入力(タップ最小44px、ホバーは装飾、ピック判定にも適用)。
7. 名前は責務を言い切る(改名は痕跡を残さない)。

## 2. 積み残し(実装後もなお残っている点)

**実装を終えた時点で判明した/意図的に残した以下は、隠さず記録する。**

### 2-1. 未分割のまま残ったモジュール

- **`creative/ship-placer-panel.ts`(844行)は分割していない。** 施策7で「軌道要素フォーム」と「ラグランジュ点フォーム」に分ける計画だったが未着手。`memos/hedalu244/refactoring_todo.md` の「巨大モジュールの分割」節にもまだ載ったままで、責務は1クラス(`ShipPlacerPanel`)に同居している。
- **`object-windows.ts`(816行)は200行基準を大きく超えたまま。** `map-picker.ts`(926行)からの分割で候補集合構築とマップ visibility 判定は `object-pickables.ts`(197行)へ抜けたが、ヒットテスト・メニュー項目構築(`itemsFor`)・プロパティウィンドウの行/アクション構築・複製/リネームの実行が依然1ファイルに同居している。
- **`plan/plan-editor.ts`(707行)もまだ大きい。** パネル DOM(`syncPanel` と Δv 数値入力欄)は `plan/plan-panel.ts`(173行)へ抜けたが、Δv 編集(キー/ボタン/ドラッグ/ラッチ)とノードギズモの配線は依然同居している。
- `hud/dock-view.ts`(787行)・`hud/save-browser.ts`(599行)・`hud/property-window.ts`(555行)・`hud/object-list-panel.ts`(507行)も200行基準を超えているが、いずれも施策7の分割対象には元々入っていない(単一責務のまま行数が大きいだけと判断したもの)。

### 2-2. 検証マトリクスは全数を撮っていない

計画の §5(旧版)は 375×667 / 667×375 / 768×1024 / 1024×768 / 1440×900 の5サイズ ×(戦闘/マップ/DockView/SaveBrowser/一時停止メニュー)の5画面、計25枚を検証マトリクスとしていたが、**実施したのは 1440×900 / 375×667 / 667×375 / 768×1024 の戦闘ビュー・マップビューと、タッチ操作(長押し/二本指パン/ピンチ/ダブルタップ)のスモークのみ**。1024×768(iPad横)は未確認、**DockView・SaveBrowser・一時停止メニューは、どのサイズでも実地確認していない**。狭幅崩れの修正(コミット `15a6098`)はこの検証で見つかった範囲に対する修正であり、上記の未確認領域に同種の崩れが無いことは保証されていない。

### 2-3. `DEVELOP/SPEC.md` の同期漏れ

実装中に「操作系の一部の記述が実装より古いのでは」という指摘があった。実際に確認したところ、エンジン出力の段数(1)/2)/3)節)が「3段階」のまま4段目([4] キー、400.0 m/s²)追加前の記述で止まっていた——この文書更新の一環で直したが、**SPEC.md 全体を実装と網羅的に突き合わせる作業はしていない**。今後 `src/` 側を変更する際は、CLAUDE.md の「設計文書 — 更新は義務」の手順どおり同じ変更セットで SPEC.md も確認すること。

### 2-4. `main.ts` の起動失敗画面は規約の適用対象外

`src/main.ts` の `showFatalError`(WebGPU 初期化失敗などで出る)は `document.createElement('button')` で独自にボタンを組み、`hud/widgets/` を経由しない。**意図的な例外**——`Hud` の構築自体が失敗しても表示できる必要があり、`Hud`/`hud/widgets/` に依存できない。`DEVELOP/DESIGN-RULES.md` の完了判定 grep は `src/game/` 配下のみを対象にしており、`src/main.ts` はそもそも走査範囲外なので、この例外は監査に引っかからない(引っかからないこと自体が設計として妥当)。

### 2-5. `npm run test:physics` の失敗6件(この UI 作業とは無関係)

現在 401/407。失敗6件はすべて `tests/physics/body-visibility.test.ts` の可視性ルール(既定で見える天体クラス・フォーカス時の子/親/兄弟の可視化・木星系衛星の既定可視化など)で、`src/game/celestial/body-visibility.ts` の既定トグル値がテストの想定と食い違っている。UI改善計画の変更は `game/celestial/body-visibility.ts` の可視性ロジックそのものには触れていないため、この乖離は本計画に起因しない既存事象と判断し、修正していない。

### 2-6. `memos/hedalu244/refactoring_todo.md` と重複していた3項目の現状

第二版 §7/§4施策7 は以下3項目を「どちらか一方の文書で決めて他方から消す」としていたが、**いずれも decision の一本化はされておらず、`refactoring_todo.md` 側にまだ項目が残っている**(コード側の実態は確認済み):

1. **`ShipPlacerPanel` の分割** — 上記2-1のとおり未実施。`refactoring_todo.md`「巨大モジュールの分割」節の記載も未消去。
2. **`Navball.gridVisibility` の状態所有** — 変更していない。`DEVELOP/OWNERSHIP.md`(328行)が示すとおり、天球グリッド6トグルの可視状態は今も `Navball` が正本として持ち、DOM だけが `ViewOptionsPanel`(施策7で `NavballPanel`/`OverviewCameraPanel` を統合して新設)に同居している。`refactoring_todo.md` 項目9(「トグルの置き場所の選択が状態の置き場所を決めてしまった」)も未消去のまま残っている。
3. **再出撃サイクルのページ内完結** — 部分的に前進した。`hud/result-screen.ts` の `ResultScreen` は `OverlayManager` に登録され(施策5)、**再出撃ボタン自体は `KeyboardEvent` のディスパッチによりページ内で完結する**ようになった。ただし**タイトルへ戻るボタンは今も `location.href = location.pathname` によるページ全体のリロード**であり、`refactoring_todo.md`「再出撃サイクルの是正」が求めていた「`Game` 再生成によるページ内完結」そのものは未着手。

## 3. 到達点

理想状態として第二版 §3 に書いていた「置き場4種」「パネル個別収納」「ウィジェット1役割1実装」「オーバーレイ単一管理者」「タッチ完結」は達成し、その規約としての表現は `DEVELOP/DESIGN-RULES.md` の該当節(§2トークン/§3ウィジェット/§4オーバーレイ/§5レイアウト/§6タッチ)にある。ここでの再掲はしない——今後この理想状態の定義自体を見直すときは `DESIGN-RULES.md` を直接書き換える。

## 4. 施策一覧(完了)

施策1〜8はすべて完了しており、以下は実施後に確定した内容(着手時の想定から変わった点があれば明記)。個別の変更手順の指示は実装が終わった以上不要なので載せていない——挙動やコードを追うには `CLAUDE.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/DESIGN-RULES.md` を参照する。

---

### 施策 1: デザイントークンの単一定義と全リテラルの置換 — **完了**

**確定したトークン**(`src/game/theme.ts` が唯一の定義元。`injectThemeVariables()` が `:root` に kebab-case の CSS 変数として一度だけ注入する。`#touch-ui` が `#hud` の外にあるため `:root` に置く):
色 `ACCENT`/`ACCENT_SOFT`/`ACCENT_SECONDARY`/`DANGER`/`DANGER_FILL`/`BG`/`SURFACE_WEAK`/`SURFACE`/`SURFACE_OPAQUE`/`EDGE`/`TEXT_STRONG`/`TEXT`/`TEXT_MUTED`/`TEXT_DIM`、
アクセント薄膜4段+縁2段、中立薄膜4段 `FILL_1`〜`FILL_4`、`SHADE_1`/`SCRIM`/`BAR_BG`、
グロー混合率 `GLOW_STRONG`/`GLOW_WEAK`、Δv3軸 `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL`、
文字8段 `FONT_XXS`〜`FONT_3XL`、`FONT_FAMILY`、グリフ `GLYPH_BASE`/`GLYPH_2_3`/`GLYPH_1_3`/`GLYPH_POI`/`GLYPH_BORESIGHT`、
角丸4種、余白6段、トランジション2段、`HIT_TARGET_MIN`(44px)、`SAFE_AREA_TOP/RIGHT/BOTTOM/LEFT`。

**着手前の想定から変わった点**:
1. マーカーのグリフサイズは UI の文字スケールに入らない独立スケール(`GLYPH_*`)として分離した。
2. グローは色トークンでは表せず、**混合率トークン+`color-mix(in srgb, <色> var(--glow-strong), transparent)`** を規約とした。
3. 中立色に 0.22〜0.4 の段が無かったため `FILL_4`(0.32)と `DANGER_FILL`/`SURFACE_WEAK` を足した。
4. 色リテラルは `#rrggbb`/`rgba()` だけでなく 3D 側の `0x` 数値リテラルも対象に加えた。
5. 書体は当初想定(Share Tech Mono)を採用しなかった。日本語グリフを持たない、HUD の 9〜10px には不向き、という理由で不採用とし、その後施策3で別の書体構成(下記)に確定した。
6. 危険色の二重化(`WARNING`/`COLOR_HUD_HP_LOW`)を `DANGER` 1つへ統合した。
7. ゲーム世界の識別色(`COLOR_MARKER_ALLY`/`COLOR_MARKER_ENEMY`/`COLOR_MARKER_HP_EMPTY`)を `const.ts` に集約した。

**確定した責務境界**(`DEVELOP/DESIGN-RULES.md` §2 が正本): `theme.ts` = UI の見た目のトークン(何も import しない)。`const.ts` の色節 = ゲーム世界の識別色・演出色。**同じ色を DOM と 3D の両方で使う必要があるものだけ theme に置く**(Δv3軸が唯一の例)。両者は互いを import しない。

**検証結果**: `npm run typecheck` 通過。`npm run test:physics` は 401/407(失敗6件は本計画と無関係、§2-5)。UI の色/寸法リテラルの grep は `creative-stage.ts` の敵個体 accent 色、`render/glow-texture.ts` の canvas グラデーションの2件のみ残存し、いずれも意図的な例外(3D生成コードであり `DEVELOP/DESIGN-RULES.md` §7 の grep 走査対象外)。廃止した名前の残存は0件。見た目の実機確認は施策8の検証マトリクス(§2-2、一部のみ)で行った。

---

### 施策 2: 入力層のジェスチャ合成(タッチで右クリック・パン・ダブルタップに到達する) — **完了**

**対象**: `src/game/input/input.ts`、`src/game/const.ts`。

**確定した実装**:
- **長押し=右クリック**: `pointerType==='touch'` で `TOUCH_LONG_PRESS_MS`(500ms)静止したら `pendingRightClicks` へ積む。`TOUCH_LONG_PRESS_FEEDBACK_MS`(300ms)経過時点で `onLongPressFeedback` を呼び、`Game` がこれを `MarkerManager.set`/`.hide` へ配線してリング表示にする(`Input` 自身はマーカー層を知らない)。
- **二本指ドラッグ=パン**: `onPointerMove` が2本指のとき、指間距離の変化を `wheel`(ズーム)へ、重心移動を `panDx`/`panDy` へ**同時に**折り込む(排他にしない)。
- **ダブルタップ**: タッチ由来のクリック成立時のみ、`TOUCH_DOUBLE_TAP_MS`(400ms)・`TOUCH_DOUBLE_TAP_PX`(24px)以内の2連打を `pendingDoubleClicks` へ合成する。マウスの `dblclick` は既存経路のまま独立に処理する。
- **投影ピック半径の coarse 拡大**: `input/pointer-precision.ts` の `isCoarsePointer()`(起動時に一度だけ `matchMedia('(pointer: coarse)')` を評価)と `pickRadiusSq(fine, coarse)` を新設。`const.ts` に `MAP_PICK_PX_SQ_COARSE`/`TARGET_LOCK_PICK_PX_SQ_COARSE`(いずれも1936、半径44px相当)を並置し、`object-windows.ts` の全ピック箇所がこれを経由する。
- 右クリックのクリック判定閾値は `RIGHT_CLICK_MOVE_THRESHOLD`(50px)として `const.ts` に改名のみ行い、値は変更していない。

**検証結果**: CDP `Input.dispatchTouchEvent` で長押し→プロパティウィンドウ・二本指ドラッグ→パン・ピンチ→ズーム・ダブルタップ→フォーカス移動の4本を確認。マウス由来のクリックとタッチ由来の合成クリックは `Input` の同じキューを共有し、消費側(30箇所超)は無改修で動いた。

---

### 施策 3: 破損の即時修復と、トークン層で完結する決定事項の適用 — **完了**

**対象**: `hud/object-picker.ts`、`hud/dom.ts`(現 `hud-root.ts`/`skeleton-style.ts`)、`theme.ts`、`const.ts`、`input/touch.ts`、`public/index.html`。

**確定した内容**:
- `ObjectPicker` の固定 520px 幅・オブジェクト一覧の固定 544px 高・`dom.ts` の固定 480px 最小幅は、いずれも `min(…, calc(100vw − 24px))`/`min(…, 60dvh)` 系の可変値に置換した。
- `theme.ts` に `SAFE_AREA_TOP/RIGHT/BOTTOM/LEFT`(`env(safe-area-inset-*, 0px)` を注入)を追加し、タッチ UI の下端群と常設パネルの下端をこれに切り替えた。全要素への適用(施策6)より先に着手可能な範囲だけをここで直した。
- `vh` の裸使用を `dvh` へ機械置換した(フォールバックとして同一セレクタに `NNvh`→`NNdvh` の対句を残す形を正式な書き方として確定)。
- **軌道方向マーカーの色を Δv 軸の青/緑/赤へ統一した**(§7-5): `const.ts` の `COLOR_MARKER_PROGRADE`/`NORMAL`/`RADIAL`(灰/紫/シアン)を廃止し、`.mk-pro`/`.mk-nrm`/`.mk-rad` は `theme.ts` の `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL` を参照する。マーカーのモノトーン基調規約に対する明示された例外として `DEVELOP/DESIGN-RULES.md` に記載した。
- **HUD の書体は当初計画(外部 CDN + `display=swap`、日本語はシステムフォールバック)から変わった**: 最終的に `@fontsource/jetbrains-mono`(ラテン、400のみ)と `@sarap422/font-hackgen`(日本語含む残り全て)を npm 依存としてバンドルし、`main.ts` が読み込む形にした(外部リクエストは0本のまま)。理由は、実行時検証(コミット `15a6098`)で外部 CDN 経由の読み込みが二重リクエストと表示遅延を生んでいたため——日本語をシステム等幅へ委ねる当初案ではなく、既にプロジェクトが持っていた日本語対応等幅書体を採用してラテン/日本語とも統一書体で描画する形に確定した。`FONT_FAMILY` は `'JetBrains Mono', 'HackGen', ui-monospace, …` の順。

**検証結果**: 375×667 / 667×375 のスクリーンショットで ObjectPicker・オブジェクト一覧・ヘルプが画面内に収まることを確認。`COLOR_MARKER_PROGRADE`/`NORMAL`/`RADIAL` の grep は0件。

---

### 施策 4: ウィジェット基盤の統一 — **完了**

**確定した10種**(`hud/widgets/`、1ウィジェット1ファイル、`widget-base.ts`/`widget-style.ts` が共通土台): `Button`/`ToggleSwitch`/`SegmentedControl<T>`/`TabBar<T>`/`CloseButton`/`ValueInput`/`Slider`/`HoldButton`/`buildCollapseToggle`/`Meter`。当初案の10種目「CollapseToggle」は既存の `buildCollapseToggle` 関数をそのまま踏襲する形に確定し、クラス化はしていない。

**状態語彙**: `.on`(選択/点灯)/`.pressed`(押下中、JS付与)/`.disabled`+`aria-disabled` の3つに統一。`.selected`/`.sel`/`.active`/`.held`/`aria-pressed` 駆動の CSS は全廃した(grep 0件)。`.clipped` は `PropertyWindow` 固有の意味として維持。

**確定した例外**: `hud/object-picker.ts` の絞り込み欄(`.op-filter`)は打鍵ごとの即時再描画が要るため `ValueInput` を使わず生の `<input>` のまま——`DEVELOP/DESIGN-RULES.md` §3 に明記した唯一の例外。

**確定した規約**: `ValueInput` は Enter=確定・Escape=破棄・blur=確定。**確定は前回確定値から変わっているときだけ `onCommit` を呼ぶ**(フォーカスして何も打たずに blur しても呼び出し側の状態を編集扱いにしない、レビューで見つかった不具合の修正)。`escapeBehavior: 'revert' | 'clear'` を型で明示し、既定 `'revert'`、`'clear'` は検索欄限定(§7-9)。`--hit-target-min` は `widget-base.ts` の `expandHitTarget` が `pointer:coarse` のときだけ要素自身の寸法で確保する(fine ポインタでは効かせない、隣接要素のヒット領域を侵さないよう疑似要素では広げない)。

**検証結果**: `createElement('button')`/`createElement('input')` が `hud/widgets/`・`save/save-transfer.ts`(ファイルピッカー)・`hud/object-picker.ts`(上記例外)以外で0件。旧状態語彙のgrepも0件。

---

### 施策 5: オーバーレイ制度の統一 — **完了**

**確定した実装**(`hud/overlay-manager.ts` の `OverlayManager`、`modal-controller.ts` から改名): `OverlayKind` は `'modal' | 'popup' | 'window'` の3種。`open`/`reconfigure`/`close` で `closeOnEscape`/`closeOnOutsideClick`/`gatesInput`/`exclusiveGroup` を宣言する。`closeTopmostOnEscape()`/`dispatchShortcut(code)` が最前面から順に処理する。`document` への capture-phase `pointerdown` リスナは `OverlayManager` の1本のみ。

**ESC の意味は2つに確定**: 入力欄フォーカス中は `ValueInput` 自身の `keydown` が `stopPropagation()` して編集を破棄し、`Input` の `window` 購読へは届かない。それ以外は `Game.handleInput` が `input.takeKey(K.pauseMenu)` を取り `closeTopmostOnEscape()` を呼び、何も閉じなければ一時停止メニューを開く。

**項目ショートカットはマップビューでのみ効く**: `dispatchShortcut` 自体にビュー判定は無く、`object-windows.ts` の `windowParts` が `showShortcuts = cameraSystem.overviewMode` によって戦闘ビューのプロパティウィンドウにショートカットそのものを載せないことで実現している(`[F]`/`[T]` は自機のRCS/ターゲット選択キーと衝突するため)。

**`tepui-release-touch-inputs` は入力ゲートの false→true 遷移時のみ発火**するよう直した(以前の「開いている間毎回発火」を修正)。`kind: 'modal'` の任意のエントリが開いていることが `body.hud-overlay-modal-open` クラス(タッチUI非表示)の駆動源。

**ContextMenu=使い捨て、PropertyWindow=継続観察 の役割を確定**: **同じ対象への右クリックは戦闘ビュー・マップビューを問わず必ず `PropertyWindow` を開く**(`object-windows.ts`)。ContextMenu が残るのは空域(`'empty-space'`)右クリックのみ。`Targeter` は独自の `ContextMenu` を持たず(基地右クリックの `ContextMenu<Base>` のみ例外として残る——プロパティを持たない対象のため)。`ResultScreen`/`DockView` を含む全モーダルが台帳に登録される。`DockView` の開閉の正本は今も `ViewManager`(`isDockOpen`)のままで、`OverlayManager` へは一方向で通知するだけ、という設計判断は当初案どおり維持した。

**検証結果**: `window.addEventListener('keydown'`/`document.addEventListener('pointerdown'` が規定の例外ファイル(`input.ts`/`input/touch.ts`/`stage-select.ts`/`overlay-manager.ts` 自身)以外で0件。`style.display ===` による状態判定も0件。

---

### 施策 6: レイアウト骨格の再構築 — **完了**

**確定した骨格**: 置き場4種(レール/戦闘シェルフ/中央モーダル/画面固定バッジ)。`#hud-combat-shelf` を常時 `display:flex` の棚として実体化し(旧 `display:contents` の二重構造を廃止)、`pointer:fine` かつ `wide`/`medium` では画面下端、`coarse`/狭幅(`MQ_MEDIUM_DOWN`)では上端に再アンカーする。

**確定したブレークポイント**(`hud/breakpoints.ts` が唯一の定義元): 幅 `compact`(<700px)/`medium`(700〜1100px)/`wide`(>1100px)、直交軸 `coarse`(`pointer:coarse`)/`short`(高さ<500px)。`MQ_COMPACT`/`MQ_MEDIUM_DOWN`/`MQ_COARSE`/`MQ_SHORT`/`MQ_COARSE_SHORT` の5つの文字列だけがここにあり、他ファイルは埋め込むだけ。

**確定した寸法変数**: `hud/layout-tokens.ts` の `--rail-w-left`/`--rail-w-right`/`--shelf-h` を `:root` へブレークポイントごとに再代入する形にした(一本化ではなく、ブレークポイントごとの別値は別値のまま)。

**確定したパネル収納**: `hud/panel-shell.ts` の `PanelShell`(見出し+`CollapseToggle`+本文)にすべてのパネルが載り、折りたたみ状態は `localStorage`(`tepui.panelCollapsed`、パネルidごと)へ永続する。レール自体の折りたたみ(`.hud-rail.collapsed`)とパネル個別の折りたたみは独立し、同じ2関数(`loadPanelCollapsed`/`savePanelCollapsed`)を共有する。compact 幅の既定値(ORBIT/CONTACTS・左右レールが畳まれた状態で開始)は `hud-root.ts` の構築時に `isCompactViewport()` を一度だけ読んで決める。

**確定した回転・リサイズ対応**: `hud/viewport.ts` の `startViewportTracking()`/`onViewportChange` が `visualViewport` の `resize`/`scroll` を購読する唯一の箇所になり、`--vvh`/`--safe-*` を更新する。`PropertyWindow`/`ContextMenu` は個別の `resize` リスナをやめてこれを購読する形に切り替えた(`render/scene.ts` の描画解像度合わせだけは3D側の関心事として対象外のまま)。

**確定したCSS分割**: `layout-tokens.ts`/`skeleton-style.ts`/`panel-content-style.ts`/`hud/widgets/widget-style.ts` の4ファイル(いずれも `hud-root.ts` の1つの `<style>` へ連結して注入)。`DockView`/`SaveBrowser`は自己完結した個別コンポーネントとして各自 `ensureStyle()` を持つ形にした(この2つは4分割の対象に含めない、という当初案どおりの判断)。

**検証結果**: `vh` の裸使用0件(`dvh` 対句を除く)。`style*=` セレクタ0件。狭幅での崩れは実行時検証(コミット `15a6098`)で追加発見・修正した(戦闘シェルフのパネルの内容切り落とし、coarse の棚高さ、グローバルステータスバーの画面幅超過)。

---

### 施策 7: 責務分割と命名の総整理 — **完了(一部積み残しあり、§2-1参照)**

**確定したファイル移設**: `object-list-panel.ts`/`display-time-panel.ts`(→`predict-panel.ts`)/`frame-controls.ts` を `hud/` 配下へ移設し、`anchor-zone.ts`/`rotation-zone.ts` と揃えた。

**確定した改名**: `SettingsPanel`→`PauseMenu`。`ModalController`→`OverlayManager`。`hud/dom.ts`→`hud-root.ts`。`showEnd`/`#hud-end`→`ResultScreen`/`#hud-result`。`hud-dock-left/right`→`hud-rail-left/right`(`.hud-rail`)。`map-pick.ts`→`object-pickable.ts`。PREDICT の呼び名は id `hud-predict`/接頭辞 `predict-`/クラス名 `PredictPanel`/表示名 `PREDICT` の4つに統一し、状態所有者 `DisplayWindowManager` は当初案どおり改名しなかった(パネルではなく「表示座標系+表示時刻の窓」を持つクラスであるため)。

**確定した統合**: `NavballPanel` を廃止し、天球グリッドトグルは `OverviewCameraPanel` を改めた `ViewOptionsPanel`(表示設定パネル)へ統合した。**`Navball.gridVisibility` の状態所有そのものは動かしていない**(§2-6参照——DOM の置き場だけを1つに統合し、状態の持ち主を決め直す論点は未決着のまま残した)。

**確定した分割**: `map-picker.ts`(926行)→ `object-pickables.ts`(候補集合・visibility、197行)+ `object-windows.ts`(ヒットテスト・メニュー構築・アクション実行・ウィンドウ台帳、816行)。ウィンドウ台帳自体(一時ウィンドウの排他)は施策5で `OverlayManager` の `exclusiveGroup: 'property-window-temp'` へ移した。`hud/panel.ts` の `HudPanels`(351行)→ `StatusPanel`/`OrbitPanel`/`TargetPanel`/`ContactsPanel`/`GlobalStatusBar`/`MapScaleBadge` の6クラス(パネル単位に1クラス)。軌道情報は「戦闘=自艦は `OrbitPanel`、対象情報は `PropertyWindow`」の2系統に整理し、`TargetPanel` から軌道要素・相対傾斜角の行を削除してプロパティウィンドウへ誘導する案内行に置き換えた。`plan/plan-editor.ts`(844行)からパネルDOM(`syncPanel`とΔv数値入力)を `plan/plan-panel.ts`(173行)へ分離した。

**未達**: `ShipPlacerPanel`(844行)の分割は着手していない(§2-1)。

**検証結果**: 旧名の全文検索は `CLAUDE.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/SPEC.md`/`DEVELOP/DESIGN-RULES.md` を含め0件(`ModalController`/`modal-controller.ts`/`hud/dom.ts`/`SettingsPanel`/`NavballPanel`/`HudPanels`/`DisplayTimePanel`/`hud-dock-left/right`/`showEnd`/`#hud-end`/`HudToggleButton`/`IconToggleButton`/`map-picker.ts`/`MapPicker`/`overview-camera-panel.ts`/game直下の`object-list-panel.ts`・`frame-controls.ts`/`map-pick.ts` のいずれも)。

---

### 施策 8: 画面クラス別の最終仕上げとタッチ到達性の完了判定 — **完了**

**確定した非レスポンシブ対応**: `DockView` は compact でヘッダ縦積み+タブ切替、`SaveBrowser` は compact で左右ペインを `TabBar<'slots'|'snapshots'>` によるタブ切替に、`ObjectPicker`/`PropertyWindow` は compact でトリガー直下ではなく画面下端のボトムシート化(`PropertyWindow` は `max-height:40dvh`)にした。

**確定したタッチ到達性の解消**: スロットル1-4は `StatusPanel` に `SegmentedControl` を置き、`document.body` の `touch-ui-active` クラス(`TouchControls.setPointerKind` が管理)が立っている間だけ表示する。装填([R])・プログレード姿勢リセット([F])・視点RCS追従切替([G])・照準に近い敵をターゲット選択([T])は `StatusPanel` に常設のボタン(`Input.tapKey` で単発の押下エッジを合成)として追加した。放熱板/太陽電池パドルのボタンは既存の44px化済みボタンをそのまま使用。ノード削除・ESC・F3/F5/F9 は既存のモーダル/メニュー経由で到達可能なため新規実装なし(SPEC.md §1 に到達経路を記載)。

**確定したタッチUIの出し入れ**: `TouchControls` は常に構築されるが最初は非表示で、初回タッチ入力(`onPointerKindChange`)で `.shown` になり、以後マウス操作を検知するたびに `.faded`(不透明度0.35)へ切り替わる——一度表示されたら消えない。

**確定したブレークポイント適用**: `stage-select.ts` のレスポンシブ CSS はトークン+`breakpoints.ts` の共通クエリへ載せ替えた。

**検証結果**: 実行時検証(コミット `9c82eb2`・`15a6098`)で音声解錠のポインタ移動誤消費、HUDボタンのフォーカス残留による Space 連打誤発火、`ValueInput` の blur確定の隔動作、無変更Δv入力によるノード消去、戦闘ビューウィンドウの `[F]`/`[T]` 奪取、セーブブラウザ裏でのΔv編集、3本指操作での誤ジャンプ、中断長押しの幽霊右クリック、長押しリング未配線、PREDICTパネル非表示、入力ゲート遮蔽幕のドック誤被覆、44pxタップ領域の隣接誤爆、右レール折りたたみによるTARGET隠蔽の13件を検出・修正した。検証マトリクスは §2-2 のとおり一部のみ実施。

## 5. 検証(実施結果)

- `npm run typecheck` は全施策で通過を確認済み。
- `npm run test:physics` は施策1着手時に407/407で通過を確認(色定数の移動が physics に影響しないことの確認)、現在は401/407——失敗6件は本計画と無関係(§2-5)。
- ヘッドレス Chrome スクリーンショットでの見た目検証は 1440×900 / 375×667 / 667×375 / 768×1024 の戦闘ビュー・マップビューのみ実施(§2-2、全数未了)。
- タッチ操作の検証は CDP `Input.dispatchTouchEvent` で長押し→プロパティウィンドウ、二本指ドラッグ→パン、ピンチ→ズーム、ダブルタップ→フォーカスの4本を確認済み。
- 各施策の完了判定 grep(色/寸法リテラル、`style.display`、`window`/`document` の keydown/pointerdown 直付け、旧状態語彙、`vh` 裸使用、`createElement`)はいずれも規定の例外を除き0件であることを施策4完了時点と本稿執筆時点の両方で確認した。
- **回帰の観測点**: 第一版→第二版で「新しいパネルを足すと実装が分裂する」という回帰が実際に起きていたが、施策4以降にウィジェット/オーバーレイの単一実装が確定してからは同種の分裂は観測されていない。今後 UI を追加する変更セットでは `DEVELOP/DESIGN-RULES.md` §7 の grep を再実行する運用を継続する。

## 6. 保留(今回やらないと決めたもの)

- マップビューの青写真/シンプル表示モード(`dev.md`)— 表示テーマの追加であり別計画で扱う。
- DOM UI の MathJax 対応(`dev.md`)— 依存追加を伴い UI 骨格と独立。
- TRAJECTORY ウィンドウのプルダウン+検索+二次元グリッド化(`dev.md`)— `ObjectPicker` の compact シート化(施策8で実施済み)とは別の機能追加。
- ゲームパッド対応 — タッチ対応(施策2)と入力層の抽象は共有できるが、要求が来るまで実装しない。
- モバイルの描画軽量化 — 軽量化計画の管轄。本計画は UI のみ。

## 7. 決定事項(回答済み)

第一版・第二版で挙げた9問はすべて回答を得て、実装はこれに従った。以下は決定の記録であり、再検討したくなったらこの節を書き換えたうえで該当する §4 の記述も同じ変更セットで直すこと。

1. **スロットル段 `SegmentedControl` は「タッチ時のみ」表示する。** 常設ではない。→ 施策8で実装(`touch-ui-active` クラス連動)。
2. **右クリックは常に `PropertyWindow` に統一する。** 戦闘ビューの敵右クリックも `ContextMenu` をやめ `PropertyWindow` を開く。→ 施策5で実装。戦闘中の視界占有は行数をビューに応じて絞ることで抑えた(`showShortcuts`/`combatTargetPickable` による絞り込み)。
3. **compact 縦の既定(ORBIT/CONTACTS は収納で開始)はこのまま。** → 施策8で実装。
4. **`hud-dock-*` → `hud-rail-*` の改名はこの粒度で行う。** → 施策7で実装。
5. **Δv 軸の色に統一する(3D ギズモ側の青/緑/赤を正とする)。** 戦闘ビューの軌道方向マーカー色を廃止し、`theme.ts` の `AXIS_PROGRADE`/`AXIS_NORMAL`/`AXIS_RADIAL` を参照させる。→ 施策3で実装。マーカーのモノトーン基調規約に対する明示された例外として `DEVELOP/DESIGN-RULES.md` に記載した。
6. **HUD に表示書体を導入する。** 当初案(外部 CDN + `display=swap`、日本語はシステム等幅へフォールバック)は施策3の実装過程で変更し、`@fontsource/jetbrains-mono`(ラテン)+`@sarap422/font-hackgen`(日本語含む残り全て)を npm 依存としてバンドルする形に確定した(理由は §4 施策3参照)。日本語をシステムフォントへ落とす案は採らなかった。
7. **部品 HP 表示のモノトーン基調はこのまま。**(良=モノトーン、注意=橙、危険=赤)
8. **施策の順序は第二版のまま。** タッチのジェスチャ合成を施策2へ前倒しした構成で進めた。
9. **検索用途の `ValueInput` には「Escape=空にする」の例外を認める。** ただし `escapeBehavior: 'revert' | 'clear'` を型で明示させ、既定は `'revert'`。→ 施策4で実装。
