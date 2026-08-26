# HUD 総合リファクタリング計画(2026-08-27)

対象は `src/game/hud/` 配下の 86 ファイル・14,861 行(`panels/physical-object-list-panel.ts` は
個別対応中のため全手順から除外する)。実地確認はコミット `9101ad73` 時点のコードによる。

この文書は単体で読めるように書いてある。前提知識は「本リポジトリは TypeScript + Three.js WebGPU の
ブラウザゲームで、HUD は DOM オーバーレイであり、見た目のトークンは `src/game/theme.ts` に一元化
されている」ことのみ。

## 目的

HUD 全体に `DEVELOP/CODING-RULE.md` からの逸脱が蓄積している。実測で確認した主なものは次のとおり。

- **同じ処理の独立再実装が 8 系統**。テキスト差分書き込み(4 箇所)、間引き同期(6 箇所)、
  メーター同期(5 箇所)、パネルルートへの到達手段(5 箇所・3 方式)、折りたたみトグル配線(3 箇所)、
  コスト表示の三項式(5 箇所)、相対傾斜角の計算式(2 箇所)、整数刻み `ValueMapping`(5 箇所)。
- **モジュール 500 行・関数 100 行の基準超過が 12 件**。最大は `windows/help-panel.ts` の 765 行、
  最長関数は `windows/settings-view.ts` のコンストラクタ約 210 行。
- **アクセス修飾子の欠落が 92 件**。同一ファイル内で `private` は明示されるのに `public` だけ
  省略される、という一貫した抜け漏れになっている。
- **死んだコードが 4 種**。どこからも import されない重複関数、到達しない CSS ルール、到達しない
  `var()` フォールバック 12 箇所、読まれない変数への代入。
- **コメント規約違反が約 200 件**。うち「コメントの不足」(規約 3.2)が約 110 件で最大、英語コメント
  18 件、実装と矛盾したコメント 4 件。

加えて、リファクタリングでは直せない**実バグと仕様矛盾**が見つかっている(後述「ユーザー判断を
要する項目」)。

修正後に期待される状態は、上記の重複・基準超過・修飾子欠落・死んだコード・コメント違反が、
それぞれ後述の達成目標に書いた件数まで落ちていることである。**プレイヤーから見える挙動と見た目は
一切変えない。**

## 決めたこと

**A. 挙動・見た目を変える是正は、この計画に入れない。**
`CLAUDE.md` は「挙動を変える必要があると判断したら、それはリファクタリングではなく仕様変更なので、
直さずに報告し `/modify-feature` へ回す」と定めている。調査で見つかった仕様矛盾・見た目の変わる
統一は、末尾の「ユーザー判断を要する項目」へ分離し、手順には含めない。
**覆す場合**: 該当項目を手順として起こし直す。手順 1〜26 はいずれもその項目に依存していないので、
既存手順の書き換えは要らない。

**B. `currentView` の二重正本は、現状の設計を維持する。**
`hud/panel-shell.ts:27` のモジュール変数 `currentView` と、`game/view-manager.ts:25` の
`private worldView`(冒頭コメントで「正本」と明言)が二重に現在ビューを持ち、
`view-manager.ts:114` の `setPanelCollapsedView()` で手動同期している。規約 1.6 の
「正データが複数箇所に分散」に当たるが、解消案はいずれも成立しない:

- `panel-shell` が `ViewManager` を参照する案 —— `view-manager.ts` は既に `panel-shell.ts` から
  import しており、逆向きの import を足すと `panel-shell → view-manager → hud → panel-shell` の
  循環になる(`hud.ts:5` が `panel-shell.ts` から `HudWorldView` を import しているため)。
  さらに `Hud` は `main.ts:118` で `ViewManager` より**先に**生成される(タイトル画面から HUD を
  使うための意図的な順序)ので、コンストラクタで参照を渡すこと自体ができない。
- ビューを引数で都度渡す案 —— クリックハンドラや初回構築時など「ビュー変更通知の外」でも現在ビューが
  要るため、結局どこかに保持変数が残り、上と同じ構築順序の制約に帰着する。

現状 `worldView` を書き換える経路は `ViewManager.setView()` とコンストラクタだけで、どちらも末尾で
無条件に `applyChrome()`(= `setPanelCollapsedView` と `hud.setWorldView` をペアで呼ぶ)を通るため、
**同期漏れが起きる経路は存在しない**。潜在的リスクは、将来 `ViewManager` に `worldView` を書き換える
メソッドを足して `applyChrome()` を呼び忘れた場合に初めて顕在化する。
**覆す場合**: 手順 7 で作る `panel-collapse-state.ts` の設計から見直しになる。

**C. `orbit-chart.ts` と `orbit-projection-chart.ts` の本体は共通化しない。**
描画する量も座標系も別物(前者は直交軸+目盛り、後者は緯度経度グリッド+テクスチャ+独自のパン/ズーム
状態)で、規約 1.5 の「個別に調整されうる要素」に当たる。共通化するのは、既に共通下回りとして
`orbit/chart-canvas.ts` が存在するのに抽出し漏れている定数と CSS だけ(手順 10)。
**覆す場合**: 手順 10 の範囲を広げる。

**D. `orbit/tick-scale.ts` と `orbit/calendar-ticks.ts` は共通化しない。**
`DEVELOP/SPEC/PLAN.md:134-145` は暦の区切り(時/日/月/年)を画面上の距離基準で間引く目盛りを、
同 179-186 は候補間隔(10 分〜1 年)から本数上限 6 本で選ぶ目盛りを、それぞれ**別のアルゴリズムとして
書き分けている**。似ているのはループの形だけで、仕様が別物。
**覆す場合**: 手順 10 に統合手順を足す。

**E. `windows/index.ts` バレルは維持し、迂回している側を揃える。**
規約 1.11 は「`index.ts` による一括再 export は、公開境界として意図的に設計したディレクトリに限る」
と定める。現状は同一シンボル(`PauseMenu`・`ContextMenu`・`PropertyWindow`/`PropertyRow`)が
バレル経由 6 箇所と直接 import 11 箇所の両方で参照されていて、境界として機能していない。
`windows/` は `src/main.ts`・`src/launcher.ts`・`src/game/game.ts` など HUD の外から使われる位置に
あり、境界としての意味はある。よってバレルを残し、`hud/` 内部から迂回している 6 ファイルを
バレル経由へ揃える(手順 24)。
**覆す場合**: 手順 24 を「バレル廃止・全 6 箇所を直接 import へ」に差し替える(変更箇所は 6 ファイル
6 箇所で、コストはほぼ同じ)。

**F. `hud/utils.ts` に DOM を扱う関数を置く。**
現状の `utils.ts` は `fmtDist`/`fmtSpeed`/`fmtDateTime` など文字列整形だけで DOM 型への参照がない。
手順 4 で `setText` を移すと、初めて DOM 依存が入る。冒頭コメントの役割定義を「HUD 表示の共通処理」へ
広げて受け入れる。別ファイルを立てるほどの分量(4 行)ではない。
**覆す場合**: 手順 4 の移設先を新規ファイルへ変える。

## 達成目標

全手順の実施後、次がすべて成り立つこと。

1. `npm run typecheck` と `npm run test:physics` が通り、`npm run build` が成功する。
2. **重複の解消**——次の grep がいずれも期待件数になる(対象は `src/game/hud/`、除外ファイルを除く)。
   - `grep -rn "private setText" src/game/hud/` が **0 件**(現在 4 件)。
   - `grep -rn "nextSyncAt" src/game/hud/` のうち**定義**が 1 箇所に集約されている(現在 6 クラスが
     各自 `private nextSyncAt = 0` と `SYNC_INTERVAL_MS` を持つ)。
   - `grep -rn "document.getElementById" src/game/hud/panels/ src/game/hud/orbit/` が **0 件**
     (現在 5 件。いずれもパネルルートへの到達手段)。
   - `grep -rn "コストなし" src/game/hud/panels/` が **1 件**(現在 5 件)。
   - `grep -rn "Math.acos" src/game/hud/orbit/` が **1 件**(現在 2 件、同一式)。
   - `grep -rn "THEME_PRESETS.find" src/game/hud/` が **0 件**(現在 2 件、同一式)。
   - 折りたたみトグルの配線(`onPanelCollapsedViewChange` の購読 + `savePanelCollapsed` のクリック
     登録)が **1 箇所**になっている(現在 3 箇所)。
3. **基準超過の解消**——`src/game/hud/` 配下(除外ファイルを除く)に **500 行を超える `.ts` が 0 件**、
   **100 行を超える関数・メソッド・コンストラクタが 0 件**。
   確認: `find src/game/hud -name '*.ts' -not -name 'physical-object-list-panel.ts' | xargs wc -l | sort -rn | head`
   の先頭が 500 未満。
4. **アクセス修飾子**——`src/game/hud/` 配下のクラスメンバーとコンストラクタで修飾子が省略されている
   ものが **0 件**(現在 92 件)。
5. **死んだコードの除去**——次がすべて 0 件。
   - `grep -rn "shortcutKeyLabel" src/game/hud/windows/help-panel.ts`(現在 1 件、どこからも未参照)。
   - `grep -n "w-close.pressed\|w-close.disabled" src/game/hud/widgets/widget-style.ts`(現在 2 件)。
   - `grep -c "var(--radius-\w*, \|var(--glass-quiet, " src/game/hud/style/combat-view-style.ts`
     (現在 12 件、すべて `theme.ts` の定義値と完全一致する到達しないフォールバック)。
6. **`forEach` の解消**——`grep -rn "\.forEach(" src/game/hud/` が **0 件**(現在 13 件、すべて
   `for...of` へ機械的に置換可能で挙動は変わらない)。
7. **import 経路**——`grep -rn "from '\.\./hud-root'" src/game/hud/` の結果に
   `COLLAPSE_EXPANDED_GLYPH`/`COLLAPSE_COLLAPSED_GLYPH`/`PREDICT_TOGGLE_LABELS`/
   `buildCollapseToggle`/`CollapseToggleLabels` が **含まれない**(現在 3 ファイルが hud-root 経由の
   再 export を使っている)。`hud-root.ts` の `export { ... } from './widgets';` ブロックが消えている。
8. **コメント**——英語コメントが 0 件(`grep -rn "^\s*//\s*[A-Za-z]" src/game/hud/` の結果が
   識別子・URL を含む行だけになる)。「計画書 N」「§N-N」形式の検討メモ参照が 0 件。
   直前にコメントを持たない関数・メソッドが 0 件(1 行の getter/setter と本文が空のものを除く)。
9. **挙動と見た目が変わっていないこと**——`npm run dev` で次を目視し、変更前と差がない:
   戦闘ビューの Vessel/Orbit/Target/Enemies パネルの各行の位置と余白、レール折りたたみボタンの
   開閉、マップビューへの切替時のパネル移動、ヘルプパネル(`H` キー)のタブ切替、設定ビューの
   配色・描画・BGM の各タブ、セーブブラウザのスロット/スナップショット一覧、資源移送ダイアログ。

## 手順

### グループ A — 死んだコードを消す

#### 手順 1. 到達しないコードを削除する

**目的**: 参照されない関数・到達しない CSS ルール・読まれない代入を消す。どれも実行時に一切効果を
持たないので、**この時点で挙動は変えない**。最初に消しておくと、以降の手順で追随させる対象が減る。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/help-panel.ts:758-765` | `export function shortcutKeyLabel` を削除。同一実装が `windows/shortcut-hint.ts:3` にあり、利用側 2 箇所(`windows/context-menu.ts:8`・`windows/property-window.ts:8`)はどちらもそちらを import している。help-panel 側は 0 参照 |
| `src/game/hud/widgets/widget-style.ts:26` | セレクタから `.w-close.pressed` を削除。`CloseButton`(`widgets/close-button.ts`)は `pressed` クラスを付与しない |
| `src/game/hud/widgets/widget-style.ts:28` | セレクタから `.w-close.disabled` を削除。`CloseButton` に `setEnabled` 相当のメソッドが無く、`disabled` クラスを付ける経路がリポジトリ全体に存在しない |
| `src/game/hud/style/combat-view-style.ts:11,13,46,79,98,124,133,154,220,255(×2),256` | `var(--x, リテラル)` のフォールバック部を削除し `var(--x)` にする。12 箇所すべてフォールバック値が `theme.ts` の定義(`RADIUS_PANEL='16px'`/`RADIUS_CONTROL='11px'`/`RADIUS_MICRO='8px'`/`--glass-quiet`)と完全一致し、これらは `injectThemeVariables()` で常時 `:root` に注入されるため到達しない |
| `src/game/hud/windows/resource-transfer-dialog.ts:167-172` | `bBase` 分岐で `bPowerJ`/`bMags`/`bRcsFuel`/`bRcsMaxFuel` に代入している 4 行を削除。テンプレート側(196,200,205,221,225,230,246,249,254 行)はすべて `isBBase ? 基地専用文言 : bXxx を使う式` の形で、`isBBase` が真のときは必ず前半で短絡するため、この 4 値は一度も読まれない |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "shortcutKeyLabel" src/game/hud/windows/help-panel.ts` が 0 件。
- `grep -n "w-close.pressed\|w-close.disabled" src/game/hud/widgets/widget-style.ts` が 0 件。
- `grep -c "var(--radius-\w*, \|var(--glass-quiet, " src/game/hud/style/combat-view-style.ts` が 0 件。
- `npm run dev` で戦闘ビューを開き、パネルの角丸とガラス地の見た目が変わっていないこと(削除した
  フォールバックは到達しないので変わらないはず)。閉じるボタンの押下・ホバーが従来どおり効くこと。

### グループ B — バグを直す

#### 手順 2. 改名可能な名前の未エスケープ埋め込みを直す

**目的**: 資源移送ダイアログが、プレイヤーが改名できる艦名・基地名を `innerHTML` のテンプレートへ
エスケープせず埋め込んでいる。艦名に `<` や `"` を含めるとダイアログの表示が壊れる。
`windows/property-window.ts:254-281` のインラインリネーム UI から任意の文字列を設定できるので、
到達可能な経路がある。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/resource-transfer-dialog.ts:179,190,204,215,229,240,253,265` | `${a.name}` / `${bName}` の 8 箇所を、テンプレートへの直接埋め込みから `textContent` 経由の代入へ変える。`windows/save-browser.ts`・`windows/property-window.ts` が既に `textContent` で名前を入れており、そちらの形に合わせる |
| `src/game/hud/windows/resource-transfer-dialog.ts:267,278` | `${p.name}`(部品名)も同じ形へ揃える。部品名は現状カタログ名で改名経路が無いため優先度は低いが、同一関数内で扱いを割らない |

**達成条件と検証**
- `npm run typecheck` が通る。
- `npm run dev` でドッキングして資源移送ダイアログを開き、艦名・基地名・部品名が従来どおり表示される。
- プロパティウィンドウから自機の名前を `<b>x` に改名してから同ダイアログを開き、`<b>x` が
  そのまま文字として表示される(タグとして解釈されず、以降のレイアウトも崩れない)。

#### 手順 3. 型で保証されていないアサーションを潰す

**目的**: 規約 1.11 は「型アサーション `as` と非 null アサーション `!` は、その前提が型以外の仕組みで
保証されている場合に限る」と定める。次の 4 系統は前提が型でもコードでも保証されておらず、前提が
崩れると実行時例外になる。**この時点で挙動は変えない**(現状どのケースも前提は成立している)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/orbit-guide-tab.ts:111-124,175-181` | `private lissajousRow!` の条件付き代入をやめる。現在 179 行の `if (group === 'collinear')` でのみ代入され、前提は**別ファイル** `orbit-guide-settings.ts` の `GUIDE_GROUPS = ['collinear','triangular','secondary','resonant']` に `'collinear'` が含まれること。`'collinear'` の群だけループの外で組み立て、ループは残り 3 群だけを回す形にすると、直線的な代入になり `!` が不要になる |
| `src/game/hud/orbit/orbit-analysis-window.ts:167,173,318` | `this.scales[this.tab as ScaleTab]` の 3 箇所。`AnalysisTab`(3 値)から `ScaleTab`(2 値)への絞り込みが、DOM の hidden クラス付与という表示側の措置にしか支えられていない。型ガード関数 `function isScaleTab(tab: AnalysisTab): tab is ScaleTab { return tab !== 'projection'; }` を足し、`commitScale` は先頭で早期 return、`buildScaleField` の `getCurrent` はガード越しに読む形へ |
| `src/game/hud/panels/target-panel.ts:57,58,60` | `'hp' in target ? (target as { hp: number }).hp : 1000` 等 3 箇所。`CombatTarget = Enemy \| Player \| Base` はすべてクラスなので、`target instanceof Ship`(`hp`/`maxHp` の持ち主)と `target instanceof Enemy`(`proteinHudSnapshot` の持ち主)で型安全に絞れる。同じグループの `panels/vessel-panel.ts` が既に `instanceof Player` / `instanceof Base` で書いており、そちらへ揃える |
| `src/game/hud/panels/base-view-parts-tab.ts:142,212,304` と `src/game/hud/panels/base-view-shared.ts:77` | `p.type === 'rcs_tank'` の直後の `p as RcsTankPart` が 4 箇所。`Part` が判別可能ユニオンでないため narrowing が効いていない。`base-view-shared.ts` に `export function isRcsTank(p: Part): p is RcsTankPart` を 1 つ定義して 4 箇所を置き換える |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -n "lissajousRow!" src/game/hud/panels/orbit-guide-tab.ts` が 0 件。
- `grep -n "as ScaleTab" src/game/hud/orbit/orbit-analysis-window.ts` が 0 件。
- `grep -n "in target" src/game/hud/panels/target-panel.ts` が 0 件。
- `grep -rn "as RcsTankPart" src/game/hud/` が 0 件。
- `npm run dev` で軌道ガイドタブの共線点群を開いてリサジュー行が出ること、軌道分析ウィンドウで
  高度/接近/投影の 3 タブを往復してスケール入力欄の値が保たれること、敵と基地の両方をターゲット
  ロックして Target パネルの装甲バーが従来どおり出ること、基地ドックで RCS タンクの補給が効くこと。

### グループ C — 横断する重複を集約する(挙動不変)

#### 手順 4. テキスト差分書き込みを 1 箇所へ集約する

**目的**: 「`els` マップから要素を引き、`textContent` が変わっているときだけ書く」という同一実装が
4 クラスにある。ローカル変数名(`e` / `element`)以外は完全に一致している。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/utils.ts` | `export function setElementText(els: ReadonlyMap<string, HTMLElement>, id: string, text: string): void` を追加。冒頭コメントの役割定義を「HUD 表示の共通処理」へ広げる |
| `src/game/hud/orbit/orbit-panel.ts:111-114` | `private setText` を削除し、呼び出し 9 箇所(78,80-86 行)を `setElementText(this.els, ...)` へ |
| `src/game/hud/panels/target-panel.ts:111-114` | 同上。呼び出し 8 箇所(68,73-76,90,95,105 行) |
| `src/game/hud/panels/top-bar.ts:49-52` | 同上。呼び出し 1 箇所(15 行) |
| `src/game/hud/panels/vessel-panel.ts:270-273` | 同上。呼び出し 1 箇所(255 行) |
| `src/game/hud/panels/map-scale-badge.ts:38` | 関数化されていないインライン版。同じ形なので `setElementText` へ寄せる |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "private setText" src/game/hud/` が 0 件。
- `npm run dev` で Vessel/Orbit/Target パネルとトップバーの数値が毎フレーム更新されること、
  マップ縮尺バッジの数値が更新されること。

#### 手順 5. パネルルート要素への到達を `els` 経由へ統一する

**目的**: パネル本体の hidden 切替のために、コンストラクタで受けた `els` を使わず
`document.getElementById(...)` や `closest(...)` で毎フレーム DOM を検索している箇所が 5 つあり、
3 通りのばらばらな方式になっている。原因は `PanelShell` が生成するルート要素に `data-id` が無く、
`hud-root.ts:364-371` の `collectDataIdElements` が拾えないこと。生成元に 1 行足せば 5 箇所すべてが
`els` 経由になる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panel-shell.ts:152` | `this.el.id = id;` の直後に `this.el.dataset['id'] = id;` を足す。これで `PanelShell` の全ルート要素が `els` に入る。既存の `data-id` 値(`reference-row`・`orbit-actions` など)と `hud-orbit`/`hud-enemies`/`burn-management-panel`/`hud-vessel-status`/`hud-target` は衝突しないことを確認済み |
| `src/game/hud/orbit/orbit-panel.ts:55` | `document.getElementById('hud-orbit')` を `this.els.get('hud-orbit')` へ |
| `src/game/hud/panels/enemies-panel.ts:38` | `document.getElementById('hud-enemies')` を `this.els.get('hud-enemies')` へ |
| `src/game/hud/panels/burn-management-panel.ts:130` | `document.getElementById('burn-management-panel')` を `this.els.get('burn-management-panel')` へ |
| `src/game/hud/panels/vessel-panel.ts:179,186` | `document.getElementById('hud-vessel-status')` の 2 箇所を `this.els.get('hud-vessel-status')` へ |
| `src/game/hud/panels/target-panel.ts:41` | `this.els.get('tgtbody')?.closest('#hud-target')` を `this.els.get('hud-target')` へ |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "document.getElementById" src/game/hud/panels/ src/game/hud/orbit/` が 0 件。
- `npm run dev` で次の表示/非表示が従来どおり切り替わること: 自機が無いとき Vessel パネルが隠れる、
  マップビューで Orbit パネルが畳まれる、ターゲット未固定で Target パネルが隠れる、
  敵が居ないとき Enemies パネルが隠れる、ブースター未接続で燃焼管理パネルが隠れる。

#### 手順 6. 折りたたみトグルの配線を 1 箇所へ統合する

**目的**: 「トグルを作り、保存状態を復元し、ビュー切替を購読し、クリック時に保存する」という同一の
制御フローが 3 箇所にある(`panel-shell.ts` の `wirePanelCollapse`、同ファイルの `PanelShell`
コンストラクタ内、`hud-root.ts` の `buildRailToggle`)。**この時点で挙動は変えない**。

`PanelCollapseWiring`(`panel-shell.ts:112-121`)は既に `toggleRoot`/`toggleId`/`toggleClassName`/
`target`/`labels`/`storageId`/`defaultCollapsed`/`extraHitEls` の 8 フィールドを持ち、残り 2 箇所の
要求(ラベルの動的生成・DOM 挿入位置の違い)は既存フィールドで吸収できる。型変更は
`defaultCollapsed?: boolean` を `defaultCollapsed?: PanelDefaultCollapsed`
(`boolean | ((view: HudWorldView) => boolean)`、現在は非 export)へ広げる 1 点だけで足りる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panel-shell.ts:112-121` | `PanelDefaultCollapsed` を export し、`PanelCollapseWiring.defaultCollapsed` の型をそれへ広げる |
| `src/game/hud/panel-shell.ts:166-185` | `PanelShell` コンストラクタ内の配線を `wirePanelCollapse({...})` の呼び出しへ置き換える。戻り値の購読解除関数は現状どおり捨てる(`PanelShell` に `dispose()` は無く、リスナーは張りっぱなしのまま。破棄経路を新設するのは機能追加なのでここではやらない) |
| `src/game/hud/hud-root.ts:86-101` | `buildRailToggle` の中身を `wirePanelCollapse({...})` の呼び出しへ置き換える。`labels` は `railToggleLabels(side)` を 1 回だけ計算して渡す(`side` のみに依存する純関数なので出力は同一)。`defaultCollapsed` は `() => isCompactViewport()` の関数形で渡す |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "onPanelCollapsedViewChange" src/game/hud/` の結果が、定義 1 件と `wirePanelCollapse` 内の
  購読 1 件だけになる(現在は購読が 3 箇所)。
- `npm run dev` で次を確認: 各パネルの見出しクリックとトグルボタンで開閉できる、左右レールの
  折りたたみボタン(◀/▶)が効く、開閉状態がリロード後も保たれる、戦闘⇄マップの切替で Orbit パネルの
  折りたたみ状態がビューごとに切り替わる。

#### 手順 7. 折りたたみ状態モジュールを `panel-shell.ts` から分離する

**目的**: `panel-shell.ts`(195 行)が「パネルの外枠を組み立てる」`PanelShell` クラスと、
「折りたたみ状態を localStorage へ永続化し、ビュー切替に応じて再適用する」関数群という異質な 2 つの
関心を同居させている。後者は `PanelShell` を一切参照せず(依存は `PanelShell` → 関数群の一方向)、
`hud-root.ts`・`view-options-panel.ts`・`predict-panel.ts` から `PanelShell` を介さず直接使われている
実績がある。行数(195 行)は 500 行基準を下回るので、分割の根拠は**責務の異質性と独立利用の実績**。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panel-collapse-state.ts`(新規) | `panel-shell.ts:1-139` のうち折りたたみ状態クラスタを移す。公開するのは `HudWorldView`・`PanelCollapseWiring`・`PanelDefaultCollapsed`・`wirePanelCollapse`・`setPanelCollapsedView`・`onPanelCollapsedViewChange`・`loadPanelCollapsed`・`savePanelCollapsed`。`PanelShell` が `currentView` を直接読んでいる箇所は、読み取り専用の取得手段を足すか、`wirePanelCollapse` へ寄せた手順 6 の結果として不要になる |
| `src/game/hud/panel-shell.ts` | `PanelShell` クラスだけを残す(約 55 行)。新モジュールから import する |
| `src/game/view-manager.ts:11` | `setPanelCollapsedView` の import 元を新モジュールへ |
| `src/game/hud/hud.ts:5` | `HudWorldView` の import 元を新モジュールへ |
| `src/game/hud/hud-root.ts:8-14` | `PanelShell` は `panel-shell.ts` から、`HudWorldView`/`loadPanelCollapsed`/`onPanelCollapsedViewChange`/`savePanelCollapsed` は新モジュールから(import 文が 2 本に分かれる) |
| `src/game/hud/panels/view-options-panel.ts:28` | `wirePanelCollapse` の import 元を新モジュールへ |
| `src/game/hud/panels/predict-panel.ts:5` | 同上 |

**達成条件と検証**
- `npm run typecheck` が通る。
- `wc -l src/game/hud/panel-shell.ts` が 100 行未満。
- `npm run dev` で手順 6 と同じ開閉の確認項目がすべて通ること。

#### 手順 8. 間引き同期の定型句を共通化する

**目的**: 「前回から一定時間経つまで sync を早期 return する」処理が 6 クラスに独立実装されている。
6 クラスとも `private nextSyncAt = 0` を持ち、`performance.now()` の使い方と `now + 間隔` の代入は
完全に一致する。差分は間隔値(100ms が 4 クラス、250ms が 2 クラス)と比較の向きだけ
(`EnemiesPanel` だけ `if (now >= nextSyncAt) { ... }` のブロック形、他 5 つは `if (now < ...) return;`。
`now === nextSyncAt` の扱いも含めて意味は同値)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/utils.ts`(または新規の小モジュール) | 実時刻の締切を内包する小さなクラス(例: `SyncThrottle`)を追加。`constructor(intervalMs: number)` と、締切を過ぎていれば真を返して次の締切を進める 1 メソッドを持つ |
| `src/game/hud/orbit/orbit-analysis-window.ts:20,100,220-221` | 250ms でこれを使う形へ |
| `src/game/hud/orbit/orbit-panel.ts:14,24,63-64` | 100ms |
| `src/game/hud/panels/target-panel.ts:12,25,44-45` | 100ms |
| `src/game/hud/panels/enemies-panel.ts:9,28,46-47,68` | 250ms。ブロック形を早期 return 形へ揃える(意味は同値)。hidden 切替がスロットルの外側・末尾にある構造は変えない |
| `src/game/hud/panels/top-bar.ts:7,10,18-19` | 100ms |
| `src/game/hud/panels/vessel-panel.ts:18,51,190-191` | 100ms |

**注意**: 5 クラス(`EnemiesPanel` を除く)は、締切チェックの**前**に表示/非表示の反映を毎フレーム行う
イディオムを共有している(`target-panel.ts:40-41` のコメントが理由を述べている)。この順序を崩さない。

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "SYNC_INTERVAL_MS" src/game/hud/` が 0 件(各クラスがコンストラクタで間隔を渡す形になる)。
- `npm run dev` で 6 つのパネル(軌道分析ウィンドウ・Orbit・Target・Enemies・トップバー・Vessel)が
  従来どおり更新され、表示/非表示の切替はカクつかず毎フレーム反映されること。

#### 手順 9. 基地ビューのコスト表示とボタンクラス付与を集約する

**目的**: `freeProcurement() ? 'コストなし' : \`${x.toLocaleString()} Cr\`` という同じ三項式が 5 箇所、
`classList.add('dock-btn', 'dock-btn-*')` が 9 箇所に反復している。表示規約が変われば全箇所を同時に
直す必要があるので、規約 1.5 の判定基準(共通化した側が変わったら参照側も変わるべきか)に Yes で
答えられる。**タブ本体(部品/艦/ショップ)は共通化しない**——各行が持つ情報が entity ごとに異なり、
規約 1.5 の「個別に調整されうる要素」に当たる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/base-view-shared.ts` | `export function costLabel(freeProcurement: boolean, amount: number): string` を追加(`BasePanelContext` 型ではなく素の boolean を取り、依存を増やさない)。既に `buildSectionHeader(): HTMLElement` があり DOM を扱う前例があるので、`dock-btn` クラス付与のヘルパーもここへ置ける |
| `src/game/hud/panels/base-view-parts-tab.ts:82,133,231` | コスト表示 3 箇所を `costLabel(...)` へ |
| `src/game/hud/panels/base-view-vessels-tab.ts:94` | 同上 1 箇所 |
| `src/game/hud/panels/base-view-shop-tab.ts:56` | 同上 1 箇所(接頭辞なしで価格だけを出す形なので、接頭辞は呼び出し側で付ける) |
| `src/game/hud/panels/base-view-parts-tab.ts:86-87,137-138,169,216,235-236` | `dock-btn` クラス付与 5 箇所 |
| `src/game/hud/panels/base-view-vessels-tab.ts:71,73,97` | 同 3 箇所 |
| `src/game/hud/panels/base-view-shop-tab.ts:59` | 同 1 箇所 |
| `src/game/hud/panels/base-view-parts-tab.ts:105-113,193-201` | 部品名+種別ラベルを組む 9 行が同一ファイル内で重複している。`private buildPartInfo(part: Part): HTMLElement` へ抽出 |
| `src/game/hud/panels/base-view-parts-tab.ts:69-90,96-97,131-140,226-239` | 「`cost > 0 && (freeProcurement() \|\| money >= cost)` で有効判定 → `dock-btn-complete` トグル → ラベル出し分け」が 3 箇所で逐語的に反復。共通ヘルパーへ抽出 |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "コストなし" src/game/hud/panels/` が 1 件。
- `npm run dev` でクリエイティブ以外のステージから基地へドッキングし、部品タブ(修理・換装・売却・
  燃料補給)、艦タブ(発進・新造・部品を見る)、ショップタブ(購入)の各ボタンのラベル・色・
  有効無効が従来どおりであること。クリエイティブステージ(調達コストなし)でも「コストなし」表示が
  従来どおり出ること。

#### 手順 10. `orbit/` と `style/` の抽出漏れを集約する

**目的**: 共通の置き場が既に存在するのに、そこへ入っていない重複が 3 系統ある。**この時点で挙動は
変えない**。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/orbit/orbit-info.ts:59-62` と `src/game/hud/orbit/orbit-analysis-data.ts:144` | `Math.acos(clamp(dot(hHatA, hHatB))) * 180 / Math.PI` という相対傾斜角の式が一字一句同じまま 2 箇所にある。`orbit-info.ts` に `export function relativeInclinationDeg(hHatA: Vec3, hHatB: Vec3): number` を切り出し、両方から呼ぶ |
| `src/game/hud/orbit/chart-canvas.ts` | `ASPECT_RATIO = '16 / 9'`・`MARK_RADIUS = 3`・`MARK_RING_WIDTH = 1`・線幅 `1.5` と、パンズームの CSS(`touch-action: none; cursor: grab;` / `cursor: grabbing;`)をここへ移す。この共通下回りモジュールが既に存在すること自体が「共有する」という判断の証拠 |
| `src/game/hud/orbit/orbit-chart.ts:41,51,52,53,57-58` | 上記定数・CSS の重複定義を削り `chart-canvas.ts` から読む |
| `src/game/hud/orbit/orbit-projection-chart.ts:25,31,32,33,39-40` | 同上 |
| `src/game/hud/orbit/orbit-chart.ts:206-254` | `timeAxis`/`distanceAxis`/`DISTANCE_TICK_INTERVALS_KM`/`fmtAxisDist` は時間・距離という具体的な単位系を知っており、同ファイル冒頭コメントの「何をプロットするかは知らない」という宣言と食い違う。`orbit-chart-axes.ts`(新規)へ分離する |
| `src/game/theme.ts` | `export const LIGHT_PALETTE` を追加(`THEME_PRESETS.find((p) => p.tone === 'light') ?? THEME_PRESETS[0]!`) |
| `src/game/hud/style/hud-layout-style.ts:5` と `src/game/hud/style/marker-style.ts:6` | 同一式の重複を消し、`theme.ts` から import する |
| `src/game/hud/panels/guide-value-field.ts:42-47,76-81,184-199,238-244` | `COUNT_MAPPING`/`CYCLES_MAPPING`/`REPEAT_DAYS_MAPPING`/`REVS_PER_REPEAT_MAPPING`/`ZERO_VELOCITY_COUNT_MAPPING` の 5 つが上限値以外まったく同一の `toSlider`/`fromSlider`/`format`/`parse` を持つ。`integerCountMapping(max: number): ValueMapping` のファクトリへ括る。同ファイル 40 行の `OPACITY_MAPPING = RANGE_MAPPING` が同種の問題を別名 export で解いている前例 |
| `src/game/hud/panels/orbit-guide-tab.ts:497-514,525-538` | `syncAll` の KindRow ループと CombinedKindRow ループのうち、15 行と 14 行が変数名以外完全に一致する。両者とも `GuideKindSharedSettings` を実装した型を扱い、構築側は既に `buildSharedKindFields` が `SharedKindFields` を返して共通化済み。`syncSharedKindFields(row: SharedKindFields, settings: GuideKindSharedSettings): void` を新設して置き換える(見出しトグルと `configPanel` の hidden 判定だけは呼び出し元に残す——CombinedKindRow は複数軸ボタンの論理和で判定するため形が違う) |

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "Math.acos" src/game/hud/orbit/` が 1 件。
- `grep -rn "THEME_PRESETS.find" src/game/hud/` が 0 件。
- `npm run dev` で軌道分析ウィンドウの高度/接近/投影タブのグラフが従来どおり描かれ、
  ドラッグでパン・ホイールでズームできること。相対傾斜角の表示値が Orbit パネルと軌道分析ウィンドウで
  一致すること。模式図スタイルへ切り替えてマーカーの配色が従来どおりであること。
  軌道ガイドタブで種類行・小題行の本数/範囲/色/透明度スライダーが従来どおり効くこと。

### グループ D — 大型ファイルを分割する(挙動不変)

各手順とも**挙動は変えない**。分割の根拠は規約 1.5 の「巨大な責務を分割するためなら、1 箇所参照でも
分割する」であり、規約 1.2 が禁じる「1 箇所からしか参照されない小さな関数を正当性なく別モジュールへ
置く」に当たらないことを、各手順の対象規模で示す。

#### 手順 11. `help-panel.ts`(765 行)からコンテンツを分離する

**目的**: 「操作説明として何が存在するか」(データ 237 行超と型 5 種)と「それをどう検索・描画・
選択するか」(挙動)が 1 ファイルに同居している。`panels/graphics-panel.ts` が
`render/graphics-settings.ts` の宣言表を別モジュールから受け取る既存の形と同じ構図。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/help-content.ts`(新規、約 340 行) | `help-panel.ts` の 8-40 行(型と `HELP_CATEGORIES`)、44-280 行(`HELP_ENTRIES`)、282-332 行(`KEYBOARD_ROWS`/`ARROW_KEYS`/`AUXILIARY_KEYS`)、334-340 行(`BEHAVIOR_LABELS`/`INPUT_LABELS`)、346-362 行(`normalize`/`entryCodes`/`entryMatchesCode`/`scopeMatches`)を移す |
| `src/game/hud/windows/help-panel.ts` | 上記を削除し新モジュールから import(約 420 行へ)。`import * as C` も不要になる |

**達成条件と検証**
- `npm run typecheck` が通る。`wc -l src/game/hud/windows/help-panel.ts` が 500 未満。
- `npm run dev` で `H` キーからヘルプを開き、表示対象(戦闘/マップ)・入力方式・カテゴリの各タブ、
  検索欄、キーボード図のキー選択と対応する操作行のハイライトが従来どおり動くこと。

#### 手順 12. `property-window.ts`(562 行)を 4 つの副概念へ分割する

**目的**: 「行+グループ+詳細折りたたみ」「操作項目一覧」「関連物体一覧」「タイトルのインライン
リネーム」という 4 つが同居し、private フィールド 20 個がそれぞれに割り当てられている。規約 1.4 の
「漠然とした多数の情報がひとつのクラスに入っている」状態。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/property-window-rows.ts`(新規、約 125 行) | 96-100, 396-410, 413-470, 474-492, 494-499, 501-506 行を移す。フィールド `rowsEl`/`lastRowValues`/`lastRowShapeKey`/`collapsibleContainerEl`/`toggleEl`/`collapsibleExpanded`/`groupExpanded` の 7 個が移動 |
| `src/game/hud/windows/property-window-items.ts`(新規、約 60 行) | 234-242, 286-314 行。フィールド `itemsEl`/`lastItemsKey` の 2 個 |
| `src/game/hud/windows/property-window-related-items.ts`(新規、約 95 行) | 317-380, 382-386, 388-393 行。フィールド 7 個 |
| `src/game/hud/windows/property-window-rename.ts`(新規、約 55 行) | 201-207, 255-270, 272-282 行。フィールド `titleMainEl`/`renameCallback`/`renaming`/`lastTitle` の 4 個 |
| `src/game/hud/windows/property-window.ts` | 外枠(コンストラクタ骨格・`contains`・`syncHeader`/`syncBadge`・`setControls`・`setExpandedPanel`・`clipped`・`bringToFront`/`reclamp`/`moveTo`・`dispose`/`close`)だけを残す(約 290 行へ) |
| `src/game/hud/windows/index.ts` | 移動した型(`PropertyRow`・`PropertyWindowItem`・`PropertyWindowRelatedItem`)の再 export 元を新モジュールへ |

**分割を阻む依存(実装時に処理する)**
- `syncRelatedItems` は `this.win.body.insertBefore(this.relatedEl, this.rowsEl)` で行パネルの直前へ
  自分を挿している。関連物体パネルが前後関係を知らずに済むよう、`PropertyWindow` 側が両者の
  `.element` を持って挿入順序を管理する形にする。
- `lastTitle` は現在 `syncHeader()` が書き換えてリネームの比較対象に使っている。分割後は
  `syncHeader` から `rename.updateTitle(title)` を明示的に呼ぶ。
- 行・項目・関連の各 `sync` は末尾で `this.reclamp()` を呼んでいる。分割後は `PropertyWindow` 側の
  委譲メソッドが直後に呼ぶ。

**達成条件と検証**
- `npm run typecheck` が通る。`wc -l src/game/hud/windows/property-window.ts` が 500 未満。
- `npm run dev` で物体を右クリックしてプロパティウィンドウを開き、行の表示・グループの折りたたみ・
  詳細の開閉・関連物体一覧の開閉とクリックでのフォーカス移動・タイトルのリネーム・操作項目の
  クリックとショートカットキーが従来どおり動くこと。ウィンドウのドラッグ移動とクリップも確認する。

#### 手順 13. `save-browser.ts`(606 行)から描画関数を抽出する

**目的**: 606 行のうち「スロット一覧の描画」68 行と「スナップショット一覧の描画」138 行が、
クラスの永続フィールドを書き換えず引数化できる。**状態ごとのクラス分割はしない**——
`viewedSlotId`/`viewedStageId`/`statusLine` が両系統から双方向に書き込まれるため、分割すると
クラス間のやり取りが増えるだけで責務は減らない(規約 1.2 の「たらい回し」と同じ弊害)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/save-browser-shared.ts`(新規) | `stageLabel()`(112-115)、`mainBtn()`/`smallBtn()`(462-476)を移す |
| `src/game/hud/windows/save-browser-slot-pane.ts`(新規) | `buildSlotsPane()`/`buildSlotRow()`(254-321)を、コールバック集約 interface を引数に取る関数として移す |
| `src/game/hud/windows/save-browser-snapshot-pane.ts`(新規) | `num()`(117-121)、`SNAPSHOT_KIND_LABEL`(123-125)、`buildSnapshotPane()`/`buildSnapshotList()`/`buildSnapshotCard()`(323-460)を移す |
| `src/game/hud/windows/save-browser.ts` | 状態・`rebuild()`・`handle*` 群を残す。`STYLE`(17-110)のうちスロット/スナップショット固有のクラス(`.sb-slot-*`/`.sb-snap-*`)は各新ファイルへ移し、それぞれが `injectOnce` で注入する(`property-window.ts` 等と同じ前例)。約 300 行台へ |

**達成条件と検証**
- `npm run typecheck` が通る。`wc -l src/game/hud/windows/save-browser.ts` が 500 未満。
- `npm run dev` でセーブブラウザを開き、スロットの選択・改名・複製・書き出し・削除・読み込み・
  新規作成・取り込み、スナップショットのステージタブ切替・いま撮る・ピン留め・改名・削除・分岐・
  読み込みが従来どおり動くこと。モバイル幅でのペイン切替タブも確認する。

#### 手順 14. `settings-view.ts` のコンストラクタ(約 210 行)を分割する

**目的**: コンストラクタが 100 行基準の 2 倍以上ある。BGM タブは専用の状態
(`activeTrack`/`stopButton`/`trackButtons`/`seekSlider`/`seekTimeLabel`/`seeking`/`seekRefreshTimer`)
とメソッド 4 つがクラス全体に漏れており、規約 1.4 の「クラス内の一部の情報だけをいじり続ける集合」の
典型。描画タブが既に `GraphicsPanel` へ委譲している形をそのまま使う。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/bgm-settings-panel.ts`(新規) | `settings-view.ts` の 15 行(`SEEK_REFRESH_MS`)、17-22 行(`fmtSeekTime`、命名は `formatSeekTime` へ)、174-261 行(BGM タブ構築)、311-349 行(`previewTrack`/`updateTrackButtons`/`updateSeekControls`/`refreshSeekPosition`)を移す。公開するのは `element` と、試聴を止める 1 メソッド |
| `src/game/hud/panels/theme-panel.ts`(新規、約 30 行) | 138-167 行(配色タブ)。`GraphicsPanel` との対称性のために切り出す |
| `src/game/hud/windows/settings-view.ts` | 上記を委譲呼び出しへ置換。`toggle(false)` 内の 4 行を新パネルの 1 メソッド呼び出しへ。コンストラクタ約 100 行、ファイル約 190 行へ |

**注**: `restorePersistedOpenState()`(276 行)は規約 1.11 が禁じる二段初期化の形をしているが、
実体は `SettingsView` ⇄ `Launcher` の循環参照(`launcher.ts:76` が `SettingsView` を要求し、
`settings-view` の `onOpenChange` は `launcher.current` を参照する)と、`launcher.start()` の完了後に
呼ばれる必要があるという起動順序の制約による。コンストラクタ引数へ繰り上げると、起動シーケンス
(ローディング表示・ステージ選択)より先に設定モーダルが開く。**この手順では直さない。**

**達成条件と検証**
- `npm run typecheck` が通る。`settings-view.ts` のコンストラクタが 100 行未満。
- `npm run dev` で設定ビューを開き、配色タブでプリセットを切り替えて即座に配色が変わること、
  描画タブの各項目が効くこと、BGM タブで曲の試聴・音量・シーク・停止が動くこと、
  設定ビューを閉じたときに試聴が止まること。

#### 手順 15. `view-options-panel.ts`(513 行)からゼロ速度曲線を分離する

**目的**: 「ガイド」タブに、天球グリッド(黄道・赤道・月軌道・月赤道・星空)と、まったく別の
関心であるゼロ速度曲線(CR3BP・ヤコビ定数・ラグランジュ点スナップ)が同居している。ゼロ速度曲線の
フィールド群は `ZeroVelocitySettings`/`lagrangePointJacobi`/`JACOBI_MAPPING` にしか依存せず、
このクラスの他の状態(ボディクラス・グリッド)と交わらない。同一ファイル内の `OrbitGuideTab` が
既に同じ形で独立クラス化されている。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/zero-velocity-section.ts`(新規、約 100-110 行) | `view-options-panel.ts` の 30-35 行(`ZERO_VELOCITY_SECTION_ROWS`)、186-195 行(フィールド 10 個)、325-368 行(構築)、477-481 行(`setZeroVelocitySettings`)、483-487/489-491/493-499/501-513 行(`commitZeroVelocity`/`commitZeroVelocityRange`/`snapZeroVelocityToLagrange`/`syncZeroVelocity`)を移す。初期値はコンストラクタ引数で受ける |
| `src/game/hud/panels/view-options-panel.ts:210-384` | コンストラクタを private メソッドへ分割: `buildTargetTab`(248-276)、`buildGuideTab`(280-323、ゼロ速度曲線を除いた残り)、`buildOrbitTab`(371-376)。同ファイルの `OrbitGuideTab` が使う `buildSystemRow`/`buildGroupTabBody` の命名に揃える。分割後のコンストラクタは外枠・3 タブ呼び出し・タブ可視化初期化だけ |
| `src/game/hud/panels/view-options-panel.ts:188,190,191,193,194` | `ReturnType<typeof buildValueField>` を使っている 5 箇所を、`guide-value-field.ts` が既に export している `ValueField` interface へ揃える(`orbit-guide-tab.ts` はそちらを使っている) |

**達成条件と検証**
- `npm run typecheck` が通る。`view-options-panel.ts` が 500 行未満、コンストラクタが 100 行未満。
- `npm run dev` でマップビューの表示設定パネルを開き、対象タブの天体/機体クラス循環ボタン、
  ガイドタブの天球グリッド各トグルと星空、ゼロ速度曲線のスイッチ・ヤコビ定数入力・
  ラグランジュ点スナップ・範囲・本数・透明度が従来どおり効くこと。

#### 手順 16. `orbit-analysis-window.ts`(493 行)から汎用ジェスチャ変換を切り出す

**目的**: ポインタ/ホイール/ピンチをパン量・ズーム量へ変換する部分が、orbit 固有の知識を一切持たない
形(`onPan`/`onZoom` のコールバックを受ける)で既に書かれており、同一ファイル内の 2 箇所
(`chart.element` と `projectionTab.chart.element`)から同じシグネチャで呼ばれている実績がある。
**`applyPan`/`applyZoom`(451-476 行)は切り出さない**——`this.tab === 'approach'` で分岐して
`this.scales`/`this.approachPan`/`this.altitudeCenterM` を書き換える orbit 固有のオーケストレーションで、
切り出すと規約 1.2 の「たらい回し」になる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/widgets/pointer-pan-zoom.ts`(新規、約 55-60 行) | 398-425 行(`attachChartPanZoom`)、428-446 行(`handlePanZoomMove`)と、これらだけが参照しているフィールド `pointers`/`lastPanPoint`/`lastPinchDist`(121-123 行)・定数 `WHEEL_ZOOM_SENSITIVITY`/`PINCH_ZOOM_SENSITIVITY`(32-33 行)を、状態を内包するクラスへ移す。コンストラクタ内で `addEventListener` まで完結させ、二段初期化を作らない |
| `src/game/hud/orbit/orbit-analysis-window.ts:143-152` | 2 箇所の呼び出しを新クラスの生成へ置き換える |

**達成条件と検証**
- `npm run typecheck` が通る。`orbit-analysis-window.ts` が 450 行未満。
- `npm run dev` で軌道分析ウィンドウの高度/接近タブと投影タブそれぞれで、ドラッグによるパン、
  ホイールによるズーム、タッチでの 2 本指ピンチが従来どおり効くこと。

#### 手順 17. `resource-transfer-dialog.ts`(458 行)を資源区画ごとに分割する

**目的**: `render()`(138-290 行)と `bindEvents()`(292-411 行)がいずれも 100 行超で、内部は
「電力」「弾薬」「RCS 燃料」「パーツ・物資」という互いに独立した資源種別が縦に並んでいるだけ。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/resource-transfer-dialog.ts:96-98` | 自前の `<style>` 注入(重複防止も無い)を `injectOnce('resource-transfer-dialog', STYLE)` へ。`draggable-window.ts`・`object-picker.ts`・`save-browser.ts`・`property-window.ts`・`context-menu.ts` が既に使っている |
| `src/game/hud/windows/resource-transfer-dialog.ts:185-208,304-344` | 電力区画を `renderPowerSection`/`bindPowerEvents` へ |
| `同:210-233,347-384` | 弾薬区画を同様に |
| `同:235-257,387-410` | RCS 燃料区画を同様に |
| `同:259-283` | 基地在庫区画を同様に |
| `同:151-153,164-166,414,419-420,435,448-449` | `ship.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank')` が同一ファイル内で 5 箇所重複。手順 3 で作る `isRcsTank` を使う private ヘルパーへ集約 |
| `同:195,196,199,245,246,305,314,388,397` | 送電量 100000(=100kJ)と燃料移動量 10(kg)が、表示文言("100kJ →" 等)とイベントハンドラのリテラルとで別々に直書きされている。名前付き定数を 1 箇所に置き、表示・ロジック双方から参照する |

**達成条件と検証**
- `npm run typecheck` が通る。`render()`/`bindEvents()` がいずれも 100 行未満。
- `npm run dev` で艦同士および艦と基地でドッキングし、電力・弾薬・RCS 燃料の各移送ボタン、
  基地在庫のパーツ受け渡し、RCS 燃料の均等割りが従来どおり動くこと。ダイアログを 2 回開いても
  `<style>` が二重に入らないこと(開発者ツールで `<head>` を確認)。

#### 手順 18. `predict-panel.ts` と `hud-root.ts` の大型関数を分割する

**目的**: どちらも 100 行基準を超える 1 関数の中に、独立した複数の画面部品が同居している。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/predict-panel.ts:276-379`(約 104 行) | private メソッドへ分割: `buildDurationRows`(285-298)、`buildModeRow`(300-320)、`buildScrubberRow`(322-359)。目盛り行と折りたたみ配線(361-378)は 4 行/13 行と小さいので分割しない(規約 1.2 の「小関数の追い出し」になる) |
| `src/game/hud/panels/predict-panel.ts:4` | `PREDICT_TOGGLE_LABELS` を `'../hud-root'` の再 export 経由ではなく `'../widgets'` から取る(同ファイル 3 行目が既に `'../widgets'` から 5 つの部品を import しているので、その import 文へ合流させる) |
| `src/game/hud/hud-root.ts:158-302`(約 144 行) | `buildInfoPanels` をパネル単位の関数へ分割(同一ファイル内に置く): `buildVesselStatusPanel`(159-201)、`buildOrbitInfoPanel`(203-224)、`buildBurnManagementPanel`(228-254)、`buildTargetPanel`(256-291)、`buildEnemiesPanel`(293-301)。5 つの `PanelShell` インスタンスは関数外へ返されず、各関数は受け取ったレール要素だけで完結するので機械的に分離できる。ファイル全体は 404 行で 500 行基準を下回るため、**別ファイルへは出さない**(出すと `configureCombatPanel`/`PanelShell`/`KEY_MAPPING` の import が増えるだけで責務は変わらない) |

**達成条件と検証**
- `npm run typecheck` が通る。両ファイルに 100 行を超える関数が無い。
- `grep -n "from '../hud-root'" src/game/hud/panels/predict-panel.ts` の結果に
  `PREDICT_TOGGLE_LABELS` が含まれない。
- `npm run dev` で表示時刻パネル(期間ピル・目盛り表記トグル・スクラバー・ジャンプ入力)が
  従来どおり動くこと。戦闘ビューの 5 パネルがすべて従来どおり表示されること。

#### 手順 19. `panel-content-style.ts`(716 行)を画面単位へ分割する

**目的**: 1 ファイルが 10 種近い別々のパネル/画面のスタイルを持っている。既に別ファイルになっている
`combat-view-style.ts`/`map-view-style.ts` と同じ粒度で切り出せる。

**変更が必要な箇所**

節境界は実測値(`awk` でトップレベルセレクタの変化点を抽出して確認)。

| 新ファイル(`src/game/hud/style/` 配下、すべて新規) | 移す行範囲 | 対象 |
| --- | --- | --- |
| `combat-panel-rows-style.ts` | 8-92 | protein 対象詳細・Vessel/Orbit/燃焼管理/combat-panel/Enemies の計器行 |
| `plan-panel-style.ts` | 93-111 | `#hud-plan` と表示設定共通の行部品(`.w-group`/`.w-toggle`/`.body-class-row`) |
| `view-options-style.ts` | 112-123, 202-208 | `#hud-view-options` のコンテナ/タイトル/本体とタブ本体 |
| `predict-style.ts` | 124-174 | `#hud-predict-wrap`/`#hud-predict-toggle`/`#hud-predict` |
| `frame-controls-style.ts` | 175-201 | `.hud-frame-controls`(座標系/カメラ FOV 操作) |
| `orbit-guide-style.ts` | 209-238 | `.orbit-guide-*` |
| `stage-controls-style.ts` | 239-264 | `#hud-stage-controls` |
| `object-placer-style.ts` | 265-280 | `#hud-object-placer` |
| `navball-style.ts` | 281-291 | `#navball` |
| `result-screen-style.ts` | 292-304 | `#hud-result` |
| `help-panel-style.ts` | 305-425 | `#hud-help`(内側の `@media` 321-323 を含む) |
| `stage-status-style.ts` | 426-438 | `#hud-stagestatus` |
| `pause-menu-style.ts` | 439-468 | `#hud-pause-menu` |
| `settings-view-style.ts` | 469-628 | `#hud-settings-view`(ドック版 474-488 を含む) |

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/style/panel-content-style.ts:629-716` | 全パネル横断で 1 箇所に集めてある `@media` ブロックを、各行の対象に応じて分割先ファイルの末尾へ移す。`combat-view-style.ts`/`map-view-style.ts` は「各ファイルが自分の `@media` を内包する」流儀で書かれており(`hud-root.ts:35-37` のコメントが「カスケードの後勝ちを利用する箇所は各ファイル内で完結させてある」と述べている)、そちらへ揃える。**この 88 行が最も壊れやすい**——移し先を間違えると狭い幅でだけ崩れる |
| `src/game/hud/style/panel-content-style.ts` | 分割後は空になるので、ファイルごと削除する。1-6 行の import(`const` と `breakpoints`)は各分割先が必要な分だけ持つ |
| `src/game/hud/hud-root.ts:15-19,38-39` | `PANEL_CONTENT_STYLE` の import を分割後の 14 本へ差し替え、`STYLE` の結合順を更新する。「骨格 → パネル内容 → ビュー別上書き」という相対順序は維持する(`LAYOUT_TOKENS_STYLE` → `SKELETON_STYLE` → 分割した各パネルスタイル → `COMBAT_VIEW_STYLE` → `MAP_VIEW_STYLE`) |

**注**: 物体一覧パネル(`#hud-physical-object-list`)の CSS はこのファイルには無く
`map-view-style.ts` 側にある。除外対象ファイルとの競合は起きない。

**達成条件と検証**
- `npm run typecheck` が通る。`wc -l src/game/hud/style/panel-content-style.ts` が 200 行未満。
- `npm run dev` で次をすべて目視し、変更前と差がないこと: 戦闘パネルの各行、表示設定パネル、
  表示時刻パネル、座標系操作、軌道ガイドタブ、ステージ操作、物体配置、ナビボール、結果画面、
  ヘルプ画面、ステージ状況バッジ、一時停止メニュー、設定ビュー。**ウィンドウ幅を狭めて
  medium/compact の各ブレークポイントでも同じ確認を行う**(`@media` の移動で最も壊れやすい)。

### グループ E — 機械的な是正

#### 手順 20. アクセス修飾子を全数明示する

**目的**: 規約 1.11 は「クラスのメンバーには `public`、`protected`、`private` のいずれかを明示する。
コンストラクタにも明示する」と定める。92 件の欠落があり、`private` は明示されるのに `public` だけ
省略されるという一貫した抜けになっている。**この時点で挙動は変えない**。

**変更が必要な箇所**(件数の内訳。判定は「その操作を外部へ約束するか」で行い、外部参照の有無は
grep で確認済み)

| ファイル | 件数 | 備考 |
| --- | --- | --- |
| `src/game/hud/hud.ts` | 24 | フィールド 15・コンストラクタ・パラメータプロパティ・メソッド 7 |
| `src/game/hud/widgets/` 各ファイル | 24 | `button.ts` 5・`slider.ts` 6・`value-input.ts` 5・`segmented-control.ts` 5・`tab-bar.ts` 5・`meter.ts` 5・`toggle-switch.ts` 3・`pulldown.ts` 3・`hold-button.ts` 3・`close-button.ts` 2 |
| `src/game/hud/windows/pause-menu.ts` | 12 | コールバックフィールド 7・コンストラクタ・メソッド 4 |
| `src/game/hud/windows/save-browser.ts` | 8 | |
| `src/game/hud/overlay-manager.ts` | 8 | |
| `src/game/hud/windows/help-panel.ts` | 7 | |
| `src/game/hud/frame/anchor-zone.ts` | 7 | |
| `src/game/hud/windows/settings-view.ts` | 6 | |
| `src/game/hud/frame/rotation-zone.ts` | 5 | |
| `src/game/hud/panel-shell.ts` | 4 | |
| `src/game/hud/windows/result-screen.ts` | 4 | |
| `src/game/hud/orbit/orbit-panel.ts` | 3 | |
| `src/game/hud/windows/resource-transfer-dialog.ts` | 3 | |
| `src/game/hud/panels/top-bar.ts` | 2 | |
| `src/game/hud/panels/enemies-panel.ts`・`target-panel.ts` | 2 | `onSelectRight`(`game/map-context-actions.ts` が代入) |
| `src/game/hud/frame/frame-controls.ts` | 1 | |

**要判断 5 件**(grep 上は外部参照ゼロだが、同種クラス群の慣習と食い違う。実装時にユーザーへ問う):
`hud.ts:32` の `helpPanel` フィールド、`overlay-manager.ts:64` の `isOverlayOpen`、
`windows/help-panel.ts:451` の `isOpen` getter、`windows/resource-transfer-dialog.ts:128` の `close`、
`windows/save-browser.ts:603` の `dispose`。いずれも `OverlayHandle` を実装するクラス群が
`close`/`contains`/`dispose` を軒並み public にしている対称性からは public 寄り。

**達成条件と検証**
- `npm run typecheck` が通る。
- `src/game/hud/` 配下(除外ファイルを除く)のクラスメンバー・コンストラクタで修飾子が省略されて
  いるものが 0 件。

#### 手順 21. `forEach` を `for...of` へ置き換える

**目的**: 規約 1.11 は「イテレーターが存在すれば `for...of` を使い、存在しない場合のみ素の `for` 文を
使う。`filter` や `map` が適している可能性があればそちらを使う」と定め、`forEach` を挙げていない。
13 箇所すべて機械的に置換でき、**挙動は変わらない**(途中脱出や非同期を含むものは無い)。

**変更が必要な箇所**

| ファイル:行 | 対象 | 置換の形 |
| --- | --- | --- |
| `hud-root.ts:367` | NodeList | 単純な `for...of` |
| `panels/guide-kind-def.ts:143,161` | 配列 | `for (const [i, def] of list.entries())`(インデックスを `def.index` に使用) |
| `panels/base-view-parts-tab.ts:44` | 配列 | `entries()` |
| `panels/base-view-parts-tab.ts:267` | 配列 | 単純 |
| `panels/base-view-vessels-tab.ts:30` | 配列 | `entries()` |
| `panels/base-view.ts:341` | NodeList | `entries()`。コールバック内の `if (!item) return;` は `continue` へ(等価) |
| `panels/base-view-shop-tab.ts:28` | 配列 | `entries()` |
| `windows/help-panel.ts:598,603,608,740,744,747` | NodeList | 単純 |

**達成条件と検証**
- `npm run typecheck` が通る。`grep -rn "\.forEach(" src/game/hud/` が 0 件。
- `npm run dev` でヘルプ画面のフィルタ切替、基地ビューの 3 タブ、軌道ガイドの種類一覧が
  従来どおり表示されること。

#### 手順 22. import 経路を整理する

**目的**: 実体が別の場所にあるシンボルを、責務の異なるモジュール経由で取っている経路がある。
規約 1.2 の「不要なたらい回し」と 1.11 の「`index.ts` による一括再 export は公開境界に限る」。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/panels/view-options-panel.ts:5-10` | `COLLAPSE_COLLAPSED_GLYPH`/`COLLAPSE_EXPANDED_GLYPH`/`CollapseToggleLabels` を `'../widgets'` から取る。`hudRail` は `hud-root.ts` 自身の export なので `'../hud-root'` のまま(import 文が 2 本に分かれる) |
| `src/game/hud/windows/property-window.ts:9` | `COLLAPSE_COLLAPSED_GLYPH`/`COLLAPSE_EXPANDED_GLYPH` を `'../widgets'` から取る |
| `src/game/hud/hud-root.ts:27-33` | 上記 2 件と手順 18 の `predict-panel.ts` を直した後、`export { ... } from './widgets';` ブロックを削除する。**除外対象ファイルも同じ経路を使っているため、そちらの対応が済むまでこの削除は保留する**(削除以外の手順は先に進められる) |
| `src/game/hud/hud-root.ts:7`・`hud.ts:19`・`view-badge.ts:2`・`object-groups.ts:7`・`orbit/orbit-analysis-window.ts:8`・`frame/anchor-zone.ts:12` | `windows/` のサブモジュールを直接 import している 6 箇所を、バレル `'./windows'`/`'../windows'` 経由へ揃える(決めたこと E) |
| `src/game/hud/widgets/index.ts` | `injectOnce` を再 export する。現在バレルに無いため、`orbit/orbit-chart.ts:4`・`orbit/orbit-projection-chart.ts:4`・`frame/anchor-zone.ts:9`・`windows/object-picker.ts:7`・`windows/draggable-window.ts:14`・`windows/save-browser.ts:14`・`windows/property-window.ts:11`・`windows/context-menu.ts:12` の 8 ファイルがバレルを迂回して `'../widgets/inject-style'` を直接読んでいる。8 箇所をバレル経由へ揃える |

**注**: `injectOnce` は `widgets/` 内部からは 1 度も使われておらず(利用は全て `orbit/`・`frame/`・
`windows/` から)、置き場所と実態がずれている。移設は責務の再定義を伴うのでこの手順では行わず、
バレルからの再 export で経路だけ揃える。

**達成条件と検証**
- `npm run typecheck` が通る。
- `grep -rn "from '\.\./widgets/inject-style'" src/game/hud/` が 0 件。
- `grep -rn "from '\./windows/\|from '\.\./windows/" src/game/hud/` が 0 件。
- `npm run build` が成功する(循環 import が入ると失敗しうるため、この手順では必ず通す)。

### グループ F — CSS のトークン化(見た目不変の分だけ)

#### 手順 23. `combat-view-style.ts` の余白をトークン経由にする

**目的**: `style/` の 8 ファイル中、`combat-view-style.ts` だけが `var(--space-N)` を 1 度も使わず
padding/margin/gap を生の px で書いている(他ファイルは一貫して使用。`map-view-style.ts` は 33 回)。
規約 1.12 の「余白のリテラルを直書きしない」に反する。**トークンの定義値と完全一致する 13 箇所だけを
置き換え、見た目は変えない。**

`theme.ts` の余白 6 段: `--space-1`=2px, `--space-2`=4px, `--space-3`=6px, `--space-4`=8px,
`--space-5`=12px, `--space-6`=18px。

**変更が必要な箇所**

| ファイル:行 | プロパティ | 現在値 | 置換後 |
| --- | --- | --- | --- |
| `combat-view-style.ts:14` | padding 第2値 | 12px | `var(--space-5)` |
| `combat-view-style.ts:77` | padding 第2値 | 4px | `var(--space-2)` |
| `combat-view-style.ts:96` | padding 第1値 | 6px | `var(--space-3)` |
| `combat-view-style.ts:96` | padding 第2値 | 8px | `var(--space-4)` |
| `combat-view-style.ts:151` | gap 第1値 | 2px | `var(--space-1)` |
| `combat-view-style.ts:153` | padding 第2値 | 8px | `var(--space-4)` |
| `combat-view-style.ts:182` | gap | 6px | `var(--space-3)` |
| `combat-view-style.ts:196` | margin-top | 6px | `var(--space-3)` |
| `combat-view-style.ts:210` | gap | 2px | `var(--space-1)` |
| `combat-view-style.ts:219` | padding 第1値 | 4px | `var(--space-2)` |
| `combat-view-style.ts:219` | padding 第2値 | 6px | `var(--space-3)` |
| `combat-view-style.ts:248` | padding 第1値 | 4px | `var(--space-2)` |
| `combat-view-style.ts:285` | padding 第1値 | 8px | `var(--space-4)` |

**この手順で触らないもの**: 同ファイルの 10px/7px/5px/3px/1px(計 14 箇所)は既存 6 段のどれとも
一致せず、丸めると見た目が px 単位で動く。特に `7px` は 7 箇所(29,93,116,151,152,153,217 行)で
反復使用されており、単発の例外ではなく一貫したパターンになっている。**末尾「ユーザー判断を要する
項目」へ回す。**

**達成条件と検証**
- `npm run typecheck` が通る。
- `npm run dev` で戦闘ビューを開き、Vessel/Orbit/Target/Enemies パネルの各行の余白・
  接触対象一覧の行間・トップバーの内側余白が変更前と**1px も変わっていない**こと。
  変更前後でスクリーンショットを撮って比較するのが確実。

### グループ G — コメント

#### 手順 24. 実装と矛盾したコメントを直す

**目的**: 規約 3.3-13 が禁じる「実装と矛盾したもの・古くなったもの」。読む人を積極的に誤らせるので、
コメント関連では最優先で直す。

**変更が必要な箇所**

| ファイル:行 | 矛盾の内容 |
| --- | --- |
| `src/game/hud/widgets/pulldown.ts:23-24` | 「`sync()` は毎フレーム呼ばれるが」とあるが、`Pulldown` に `sync` という名のメソッドは存在しない(外部状態を反映するのは `setSelected`)。存在しないメソッド名を実在するものへ直す |
| `src/game/hud/panels/vessel-panel.ts:1-2` | 2 つ矛盾がある。(a) 「(#hud-status)」とあるが実際の id は `hud-vessel-status`。(b) 「自機が無ければ隠す」とあるが、実装(175-179 行)の非表示条件は `game.activeControllableEntity === null` で、自機以外を操作中でもパネルは残る |
| `src/game/hud/panels/burn-management-panel.ts:161-162` | 「ブースター追加は現段階では暫定 UI。ゲーム側が実装済みと明示した時だけ有効化する」とあるが、`canAttach` は `player.ts:340` から実データが渡され、`onAttach` も `game.ts:189` で `player.attachBooster()` へ実配線済み。機能は完成している |
| `src/game/hud/panels/predict-panel.ts:285` | 「行1: 未来/過去それぞれの期間ピル(1周/1日/7日/28日/任意…」とあるが、実際の `FIXED_DURATIONS`(13-19 行)は 1周/1日/10日/1ヶ月/3ヶ月 で、7日・28日は存在せず「任意」に相当するピルも無い(任意入力は常時表示の数値欄) |
| `src/game/hud/orbit/orbit-analysis-window.ts:1-4` | 「…を渡すことだけを持つ」とあるが、実装は比較対象天体の保持・切替(105,208-210 行)とチャートのパン/ズーム中継(142-151 行)も持つ。手順 16 の分割後の姿に合わせて書き直す |

**達成条件と検証**
- `npm run typecheck` が通る。
- 各コメントが指す識別子・条件が実装と一致していることを、該当行を読んで確認する。

#### 手順 25. 英語コメントと検討メモ参照を日本語・自己完結へ直す

**目的**: 規約 3.1「言語は日本語に統一する」と 3.3-9「検討メモ・課題管理文書への参照」。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/windows/resource-transfer-dialog.ts:148,155,168,169,303,312,325,333,346,355,367,374,386,392,402,424,433` | 英語コメント 17 件を日本語化。ただし `// Power transfer A -> B` の類は規約 3.3-12「その場に書かれた実装と同じことを言っているもの」にも当たるので、単純な翻訳ではなく**削除するか、区画の意味を与える 1 行へ書き換える**。手順 17 の区画分割で各区画が関数になるので、その関数の冒頭コメントへ集約するのが自然 |
| `src/game/hud/style/hud-layout-style.ts:18` | `/* DADS-style persistent focus treatment: a bright keyline plus a dark contrast edge. */` を日本語へ。内容(なぜ二重のアウトラインか)は妥当なので趣旨は残す |
| `src/game/hud/panels/guide-value-field.ts:193` | 「(計画書 8 の #9 と同じ方針)」の参照を削り、方針の中身だけ残す |
| `src/game/hud/panels/orbit-guide-tab.ts:40` | 「(計画書 8 の #9)」を同様に |
| `src/game/hud/panels/view-options-panel.ts:326` | 「(計画書 4.3)」を同様に |
| `src/game/hud/style/panel-content-style.ts:73` | 「§7-1 の決定により」の章番号参照を削る(`DEVELOP/SPEC/` に該当節が見当たらない) |
| `src/game/hud/panels/base-view-parts-tab.ts:119` | 「3段階だった健全時/中間の色分けは」の過去形(規約 3.3-5)を消し、現在の色分け規約だけ書く |

**達成条件と検証**
- `grep -rn "^\s*//\s*[A-Za-z]" src/game/hud/` の結果が、識別子や URL を含む行だけになる。
- `grep -rn "計画書" src/game/hud/` が 0 件。
- `grep -rn "§[0-9]" src/game/hud/` が 0 件。

#### 手順 26. 責務外への言及を削り、不足しているコメントを足す

**目的**: 規約 3.1「そのモジュールの責務外のことに言及しない」と 3.2「直前に 1 行もコメントがない
関数・メソッドは、それだけで不足とみなす」。**全手順の最後に置く**——グループ B〜F でコードが移動
するため、先にやると二度手間になる。

**変更が必要な箇所**

| 分類 | 件数 | 主な対象 |
| --- | --- | --- |
| 他モジュールの内部処理の説明(3.3-8)・呼び出し元への言及(3.3-3, 3.3-4)・委譲の痕跡(3.3-7) | 約 42 | `overlay-manager.ts`(1-4, 24-25, 40-42, 53-54)、`orbit/orbit-analysis-data.ts`(1-3, 40, 45-48, 90-91, 111-113)、`windows/context-menu.ts`(3-4, 49-53, 70-71, 91-92)、`windows/property-window.ts`(1-5, 138-140, 172-174, 233-234)、`panels/target-panel.ts`(1-4)、`panels/guide-kind-def.ts`(5-8, 171-172)、`widgets/widget-base.ts`(9-10, 18-19)ほか |
| 否定形での責務説明(3.3-2) | 29 | `widgets/button.ts`(3件)、`widgets/value-input.ts`(3件)、`widgets/segmented-control.ts`(2件)、`windows/context-menu.ts`(2件)、`windows/pause-menu.ts`(2件)、`windows/draggable-window.ts`(2件)、`style/map-view-style.ts`(2件)ほか。**「〜だけ」「〜のみ」を使わず、そのモジュールが「なにをするか」を肯定形で書く** |
| コメントの不足(3.2) | 約 110 | 最多は `windows/help-panel.ts`(約 25 件、ほぼ全メソッド)、次いで `windows/save-browser.ts`(14件)、`panels/orbit-guide-tab.ts`(14件)、`orbit/orbit-analysis-window.ts`(11件)、`orbit/orbit-projection-chart.ts`(9件)、`orbit/orbit-chart.ts`(8件)、`windows/resource-transfer-dialog.ts`(8件)。モジュール先頭コメントが無いのは `layout.ts`・`widgets/inject-style.ts`・`windows/menu-actions.ts`・`windows/pause-menu.ts` |
| 中規模関数の文脈コメント不足(3.2) | — | 非コメント行 10 行以上の関数に、数行に 1 行の頻度で文脈コメントを置く。特に `windows/settings-view.ts` のコンストラクタ、`windows/resource-transfer-dialog.ts` の `render`/`bindEvents`、`panels/orbit-guide-tab.ts` の `syncAll`、`panels/vessel-panel.ts` の `sync`(手順 14/17/10/— の分割後の姿に対して行う) |

**この手順では削らないもの**: 規約 3.4 が認める「採らなかった実装の弁明」——`DEVELOP/SPEC/` に明言
された根拠を引用しているもの(`frame/anchor-zone.ts:15-16` の「MAP.md 3節」、
`panels/guide-kind-def.ts:1,16` の「SPEC/MAP.md 5.2/4.1の表」)と、規約 3.2 が認める「安直に単純化
すると起きるバグ」を述べているもの(`widgets/pulldown.ts` の毎フレーム書き込みが選択を戻す説明、
`panels/target-panel.ts:40-41` の毎フレーム反映の理由)は残す。

**達成条件と検証**
- `src/game/hud/` 配下(除外ファイルを除く)に、直前にコメントを持たない関数・メソッドが 0 件
  (1 行の getter/setter と本文が空のものを除く)。
- `grep -rn "は行わない\|には依存しない\|する必要はない\|関与しない" src/game/hud/` が 0 件。
- `npm run typecheck` が通る。

## 見積り

行数ベースの導出。時間ではなく変更量で示す。

| グループ | 手順 | 変更ファイル数 | 変更箇所数 | 導出 |
| --- | --- | --- | --- | --- |
| A | 1 | 4 | 20 | 削除のみ(関数1・CSSルール2・フォールバック12・代入4行+関数8行) |
| B | 2-3 | 6 | 21 | エスケープ10箇所 + アサーション11箇所 |
| C | 4-10 | 約 30 | 約 110 | setText 5+22呼び出し / data-id 1+6 / 折りたたみ 3 / 間引き 6クラス×3行 / 基地 18 / orbit・style 抽出 約20 |
| D | 11-19 | 約 35(うち新規 22) | — | 新規ファイル 22 本。移動する総行数は help 340 + property 257 + save 224 + settings 130 + view-options 100 + orbit-analysis 50 + panel-content 560 ≒ **1,660 行**。移動が主で新規記述は glue のみ |
| E | 20-22 | 約 40 | 約 120 | 修飾子 92 + forEach 13 + import 17 |
| F | 23 | 1 | 13 | 完全一致する余白のみ |
| G | 24-26 | 約 55 | 約 190 | 矛盾 6 + 英語17 + メモ参照5 + 責務外 約42 + 否定形 29 + 不足 約110(重複を整理して約190) |

**最大の作業量はグループ G の約 190 件**(うち「コメントの不足」約 110 件)、次いでグループ D の
1,660 行の移動。グループ A・B・F は小さく、先に片付けて commit を刻める。

**分割後の行数見込み**(500 行基準を全ファイルで満たす):
`help-panel.ts` 765→約420、`save-browser.ts` 606→約300-390、`property-window.ts` 562→約290、
`panel-content-style.ts` 716→200未満、`view-options-panel.ts` 513→約420、
`orbit-analysis-window.ts` 493→約440、`settings-view.ts` 350→約190、
`resource-transfer-dialog.ts` 458→(区画分割で関数を100行未満へ)、`panel-shell.ts` 195→100未満。
`orbit-guide-tab.ts` は 628→約600 で 500 行を超えたまま残る——内部は「1 つの軌道ガイドタブ」という
単一責務に閉じており、各 `build*`/`commit*`/`sync*` が UI 区画と 1:1 対応し `this.current` と専用
`Map` へ強く結合しているため、これ以上の分割は規約 1.2 が禁じる「たらい回しモジュール」を増やす。
**達成目標 3 の例外として扱うかどうかはユーザー判断**(下記参照)。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `panel-shell.ts:152` で足す `data-id` が既存の `data-id` 値と衝突する | `collectDataIdElements` が作る `els` マップで後勝ちが起き、別のパネルの要素が上書きされて sync が無言で効かなくなる | 手順 5 の検証(5 パネルの表示/非表示)。着手時に `grep -rn "data-id=\"hud-orbit\"\|data-id=\"hud-target\"" src/` で衝突が無いことを再確認する |
| 折りたたみ配線を統合したとき、`buildRailToggle` が渡す `defaultCollapsed` を関数形ではなく即値で渡してしまう | レール折りたたみの既定値がビュー切替時に再評価されなくなり、現状より挙動が退行する | 手順 6 の検証(戦闘⇄マップ切替での折りたたみ状態) |
| `PanelShell` のリスナー購読解除を「ついでに」実装してしまう | `dispose()` の新設は機能追加であり、既存の生存期間を変える。無言で挙動が変わる | 手順 6。`wirePanelCollapse` の戻り値は現状どおり捨てる、と明記してある |
| 間引き同期の共通化で、`EnemiesPanel` の hidden 切替がスロットルの内側へ入る | 敵の増減に対するパネルの表示/非表示が最大 250ms 遅れる | 手順 8 の検証。5 クラスは締切チェックの**前**に表示反映、`EnemiesPanel` は**外側・末尾**という構造の違いを保つ |
| `panel-content-style.ts` の分割で `@media` ブロックの結合順が変わる | ブレークポイントごとの上書きが効かなくなり、狭い幅でだけレイアウトが崩れる。通常幅では気づけない | 手順 19 の検証。**medium/compact の各幅で全画面を目視する**ことを検証項目に入れてある |
| 同じ CSS セレクタを複数ファイルが定義しており、結合順に依存している | 分割・並べ替えで後勝ちの相手が変わり、色や寸法が無言で変わる。既知の実例: `#hud-map-scale` が `hud-badge-style.ts:48-54` と `map-view-style.ts:372-380` の両方で定義され、`color` が結合順で決まっている(現状は値が同一なので実害なし) | 手順 19。着手前に `grep -rn "#hud-map-scale\|\.panel-shell-collapse" src/game/hud/style/` で重複定義を洗う |
| `windows/` のバレル経由へ揃えたとき、`hud/` 内部で循環 import が生まれる | ビルドは通るが実行時に `undefined` を参照して起動直後に落ちる。typecheck では検出できない | 手順 22 の検証で `npm run build` を必須にしてある。加えて `npm run dev` で起動確認する |
| `combat-view-style.ts` の余白置換で、トークンと 1px しか違わない値を「だいたい同じ」と丸める | 戦闘パネルの行間が数 px ずれる。単体では気づきにくく、全パネルに波及する | 手順 23。**完全一致する 13 箇所の表を明示**し、それ以外は触らないと決めてある。スクリーンショット比較で確認 |
| コメント整理を分割より先にやってしまう | 移動する 1,660 行に付いたコメントを二度書き直すことになる | グループ G を最後に置いてある |
| 「否定形を消す」を機械的に適用し、規約 3.2 が認める「安直に単純化すると起きるバグ」の説明まで消す | 次に触る人が同じ罠を踏み、選択が戻る/伝播が漏れるといった再発バグを生む | 手順 26。残すべきコメントを明示してある |
| `resource-transfer-dialog.ts` のエスケープ修正で、`innerHTML` から `textContent` へ移すときに要素の構造まで変えてしまう | ダイアログのレイアウトが崩れる | 手順 2 の検証(通常表示が従来どおりであること)を先に確認してから、改名した名前での確認へ進む |
| 除外対象(`panels/physical-object-list-panel.ts`)が `wirePanelCollapse` と `hud-root.ts` の再 export を使っている | 手順 7 の import 書き換えと手順 22 の再 export 削除が、除外対象と競合する | 手順 7 では新モジュールへの import 追加が要る(除外対象の 1 行)。手順 22 の**再 export ブロック削除は、除外対象の対応が済むまで保留する**と明記してある |
| 手順 D 群を 1 コミットにまとめる | 1,660 行の移動が 1 つの差分になり、レビューで移動と改変を見分けられなくなる | グループ D は手順ごとに 1 コミット。移動と改変を同じコミットに混ぜない |

## ユーザー判断を要する項目(この計画の手順には含まない)

いずれも**挙動または見た目が変わる**ため、リファクタリングとしては扱えない。採否が決まったものは
`/modify-feature` を通して別途着手する。

### 1. 折りたたみの既定値が SPEC と食い違っている

`DEVELOP/SPEC/UI-DESIGN.md:250-252` は「折りたたみの選択がまだ保存されていない(初回起動・保存の
消去後)ときの既定値は**展開**とする——利用者が自分で畳むまでは、パネルの中身が見える状態から
始まる」と定めている。一方コードは 4 箇所で未保存時に畳む既定値を渡している:

- `hud-root.ts:204` — Orbit パネル: `(view) => view === 'map' || isCompactViewport()`
- `hud-root.ts:293` — Enemies パネル: `isCompactViewport()`
- `hud-root.ts:94` — 左右レール: `loadPanelCollapsed(railId) ?? isCompactViewport()`
- `panels/view-options-panel.ts:230` — `defaultCollapsed: true`

**選択肢**: (a) コードを SPEC に合わせる(狭い画面で全パネルが開いた状態から始まるため、
初回の使い勝手が変わる)。(b) SPEC を実態に合わせて「compact 幅では畳んで始まる」と書き換える。

### 2. `hud-root.ts:293` が幅判定を起動時にキャッシュしている

規約 1.12 は「幅クラスの判定結果を起動時にキャッシュしない。瞬間の値が要るときは、その場で判定関数を
呼ぶ」と定める。Enemies パネルは `isCompactViewport()` の**評価結果**を `PanelShell` へ渡しており、
以後どれだけ画面が回転・リサイズされても構築時の値のまま。隣の Orbit パネル(204 行)は関数を渡して
いるのでビュー切替のたびに再評価される。**規約違反は明白だが、直すと未保存状態での既定値が変わる**
ため項目 1 と一緒に決める必要がある。

### 3. 操作できる部品が 11 種に閉じていない(SPEC 違反 3 件)

`DEVELOP/SPEC/UI-DESIGN.md` §3 は「押せる/切り替えられる/入力できる DOM を自作しない。定義済みの
11 種の部品**以外**の対話要素を新規に作らない」と定め、§7-3 は「生の対話要素の自作」を禁止事項に
挙げている。次の 3 件が反している。

- **`windows/help-panel.ts` の自前タブ**(396-419, 595-613 行)。表示対象・入力方式・カテゴリの
  3 グループを `role="tab"` の生 `<button>` として `innerHTML` で組み、選択状態を自前の
  `syncToolbar()` で付け外ししている。CSS も `panel-content-style.ts:363-368` に `.help-tab` として
  `widget-style.ts` の `.w-tabs`/`.w-btn` と並行に別定義されている。既存の `widgets/tab-bar.ts` と
  `widgets/segmented-control.ts` がまさにこの契約を提供している。**置き換えると見た目が変わる。**
- **`windows/save-browser.ts` の `prompt()`/`confirm()`**(481,496,505,521,543,574,580,587 行)。
  §3 は値入力を「唯一の実装」と定め、§4 は「モーダル・ポップアップ・ウィンドウは必ず共通の管理下に
  置く」と定めるが、ブラウザネイティブダイアログは ESC 配送・外側クリック・排他グループ・
  タップ最小寸法・トークンのいずれの共通管理にも乗らない。`windows/property-window.ts:258-270` は
  同じ「リネーム」を `ValueInput` のインライン編集で実装しており、同一機能が 2 方式に割れている。
- **メーターの 5 重再実装**。§3 は「メーター | HP/温度/電力などのバー」を 11 種の 1 つとして挙げ、
  `DEVELOP/SPEC/FLIGHT.md:170` は「ステータスウィンドウには装甲・エンジン出力・温度をバーで常時
  表示」と定める。実装は `panels/target-panel.ts:78-90`(装甲)、
  `panels/burn-management-panel.ts:146-154`(ブースター燃料)、`panels/vessel-panel.ts:244-253`
  (RCS 燃料)、同 275-286(スロットル/動圧)、`panels/base-view-parts-tab.ts:116-127`(部品耐久、
  ここだけ `Meter` を使用)の 5 箇所に分かれている。

  `widgets/meter.ts` の現在の公開 API は `setRatio`/`setDanger`/`setLabel` の 3 つだけで、
  再実装側が必要とする **aria 属性(`aria-valuemin`/`valuemax`/`valuenow`/`valuetext`)を扱えず**、
  **既存の静的マークアップへアタッチする手段も無い**(必ず新規 DOM を作る)。さらに `Meter` は
  値ラベルをバーに**重ねて**配置するのに対し、5 箇所のうち 4 箇所は値ラベルをバーの**横**に
  兄弟要素として置いている。**統一すると値ラベルの位置が変わる。**

  加えて danger の閾値と比較演算子が実装ごとに違う(装甲・部品耐久は 30% で `<=`、RCS 燃料は 20% で
  `<`、ブースター燃料は 20% で `<=`、動圧は 50%、スロットルは常に false)。統一するならどれに
  揃えるかを決める必要がある。

  なお SPEC・CODING-RULE のいずれにも「aria」「スクリーンリーダー」「アクセシビリティ」の記述は
  1 件も無い。**aria 対応を `Meter` の契約に含めるかどうかは、まだどこにも決まっていない。**

### 4. 見た目が変わる CSS の統一

- **`combat-view-style.ts` の余白 14 箇所**(10px/7px/5px/3px/1px)。既存 6 段のどれとも一致しない。
  特に `7px` が 7 箇所で反復。トークンへ丸めるか、7px の段を新設するか、現状維持か。
- **寸法 3 箇所**。`.combat-panel .panel-shell-collapse` が 26px(汎用の
  `hud-layout-style.ts:75` は 24px)、`.metric` の min-height が 22px、`.contact-row` が 24px
  (`layout-tokens.ts:15` の `--row-min-h-s` は 28px で、`map-view-style.ts:170` の `.erow` と
  `panel-content-style.ts:330` の `.help-tab` はそれを使っている)。
- **box-shadow の段**。`0 12px 30px`(map/combat)と `0 12px 32px`(汎用 `.panel`)、
  `0 10px 24px`(map-scale)と `0 10px 28px`(戦闘 topbar)が 2〜4px 違う。意図的な階層か書き手の
  ゆれかコードからは判別できない。トークン化の前に、どちらへ統一するかを決める必要がある。
  なお「影を浮遊層(ウィンドウ・ポップアップ・トースト)にだけ使い、常設レール/パネルには使わない」
  という二層設計自体は意図的なものとして既に確認されている。
- **backdrop-filter のぼかし量**。`blur(14px) saturate(82%)` が 4 ファイル 10 箇所、
  ほかに 18px/20px/22px/3px。`theme.ts` にぼかし量のトークンは存在せず、`UI-DESIGN.md` §2 の
  トークン一覧にも含まれていない。規約 1.12 の「寸法のリテラルを直書きしない」には反しているので
  トークン化自体は要請されるが、**何段にしてどう名付けるか**は決まっていない。
  観測された値のクラスタ(14px 系=常設パネル、18〜22px 系=浮遊/注視系、3px=全画面スクリム)が
  そのまま段の候補になる。
  併せて `-webkit-backdrop-filter` の併記がファイルによって割れている(`combat-view-style.ts`・
  `map-view-style.ts`・`base-view.ts` は併記あり、`hud-badge-style.ts`・`hud-layout-style.ts`・
  `panel-content-style.ts`・`windows/` 配下 4 ファイルは無し)。
- **8 段フォントスケールの外側**。生の px/em が 5 箇所(`combat-view-style.ts:83` の `0.9em`、
  `map-view-style.ts:398,408` の `8px`、`panel-content-style.ts:417,665` の `9px`)。
  加えて `calc(var(--font-s) * 0.85)` のようにトークンを係数でスケールしている箇所が 5 箇所
  (`panel-content-style.ts:220,273`、`marker-style.ts:98,100,101`)。
  `panel-content-style.ts:220` は `padding: 10.5px` という半端な余白リテラルも併せ持つ。
  `UI-DESIGN.md` §2 は「マーカーのグリフサイズは文字サイズと独立した専用スケール」を例外として
  明言しているが、`marker-style.ts` の 3 箇所は**グリフ(`.sym`)ではなくラベル文字(`.lbl`/
  `.lbl-sub`)**なので例外に当たらない(グリフ側は `--glyph-base`/`--glyph-poi` を正しく使っている)。

### 5. `skeleton-style.ts` の同一セレクタ二重定義

`src/game/hud/style/skeleton-style.ts` の `MQ_MEDIUM_DOWN` ブロック内で `#hud .hud-rail` が
2 度定義されている(19 行 `{ top: 8px; bottom: 8px; gap: var(--space-3); }`、
25 行 `{ top: 40px; }`)。詳細度は同一で、25 行が `top` だけを上書きするため、**19 行の `top: 8px`
だけが死んでいる**(`bottom` と `gap` は生きている)。両方とも同一コミットで追加されており、
どちらが意図かコードからは判別できない。

**選択肢**: (a) 19 行の `top: 8px` を消す(現在の見た目 `top:40px` は変わらない)。
(b) 25 行を消す(`top` が 8px に戻り、**見た目が変わる**)。

### 6. `bindActivation` が押しっぱなしで連射する

`src/game/hud/widgets/widget-base.ts:28-34` の keydown ハンドラが `KeyboardEvent.repeat` を見て
おらず、Enter/Space を押し続けると OS のキーリピートがそのまま `el.click()` に変換され、ハンドラが
連射される。影響を受けるのは `role="button"`/`role="switch"` を使う部品——`Button`(HUD 内 21
ファイルで使用)、`ToggleSwitch`、およびそれらを内部で生成する `SegmentedControl`/`TabBar`/
`Pulldown`。`HoldButton`(独自の pointer 実装)と `CloseButton`(ネイティブ `<button>`)は対象外。

SPEC・CODING-RULE に押しっぱなしの扱いを定めた記述は無い(「長押し=右クリック相当」という
ジェスチャ変換の規定はあるが別の話)。`if (e.repeat) return;` を足すのが素直だが**挙動が変わる**。

### 7. `TabBar` が `Button` のカプセル化を破っている

`src/game/hud/widgets/tab-bar.ts:21-30` が `btn.setOn(selected)`(内部で `aria-pressed` を設定)を
呼んだ直後に、外部から `aria-pressed` を削除して `aria-selected` を付け直している。45 行でも
`Button` が付けた `role="button"` を外部から `role="tab"` へ上書きしている。規約 1.11 の
「状態変更時に副作用がある場合は、状態を所有するクラスのメソッドに変更を閉じる」に反する。

**直し方の案**: `Button` のコンストラクタに role(`'button' | 'tab'`)を選ぶ第 4 引数を足し、
`setOn` が role に応じて `aria-pressed`/`aria-selected` を書き分ける。既存の
`new Button(label, onClick, icon)` 呼び出し(21 ファイル)は既定値で挙動が変わらない。
**DOM 属性の出方が変わるので、リファクタリングとしては扱わない。**

### 8. `SegmentedControl.setItems` と `TabBar.setItems` の重複

差分更新アルゴリズム(同一判定→全削除→再構築)の骨格が一致する。差分はタプルの要素数
(アイコンの有無)と `role` 属性の後付けだけ。ただし両クラスの冒頭コメントは
「3 択以上の排他選択専用」と「パネルの表示面そのものを切り替える用途専用」と、**意味的に別概念として
意図的に分離している**ことを明言している。規約 1.5 の「個別に調整されうる要素なら一般化しない」に
当たる可能性がある。共通化するなら、ボタン生成をコールバックで注入するジェネリックな差分ヘルパーが
候補。

### 9. `orbit-guide-tab.ts` が 500 行基準を超えたまま残る

手順 10 の重複除去後も約 600 行。内部は単一責務(1 つの軌道ガイドタブ)に閉じており、
各 `build*`/`commit*`/`sync*` が UI 区画と 1:1 対応して `this.current` と専用 `Map` へ強く結合して
いるため、これ以上分けると規約 1.2 が禁じる「たらい回しモジュール」が増える。
**達成目標 3(500 行超が 0 件)の例外として認めるか、責務の切り直しまで踏み込むかを決める必要が
ある。**

### 10. `physical-object-list-order.ts` の並行配列

`src/game/hud/panels/physical-object-list-order.ts:41-52,74-98` が
`prevIds`/`prevNames`/`prevKinds`/`prevParents`/`prevMatches` の 5 本の並行配列を添字で対応付けて
いる。規約 1.6 の「配列に対して外部から対応付けを行う設計を避ける」の変種だが、GC 抑制という
狙いがコメントで明言されている。1 本の配列にまとめると添字ずれの心配が消えるが、フレームごとの
オブジェクト生成が増える。**同 47 行の `prevFilter: PhysicalObjectListFilter | null | undefined`
は、「フィルタ未選択」の `null` と「まだ比較していない」の `undefined` という異なる 2 種の不在が
同じ変数に同居しており、規約 1.6 の「不在は `T | null` で表す」に反する**(こちらは初回強制更新用の
boolean を分離すれば挙動を変えずに直せる)。

このファイルは除外対象(`physical-object-list-panel.ts`)と対になっているため、そちらの作業が
片付いてから扱う。

### 11. `base-view-shared.ts` と `game-entity/ship.ts` の値の二重管理

`src/game/hud/panels/base-view-shared.ts:18-19` の `DEFAULT_TORQUE`/`DEFAULT_THRUST` が
`C.MAX_ANG_ACCEL * Math.max(PITCH,YAW,ROLL)` / `C.PLAYER_MASS * C.THROTTLE_LEVELS[...]` という式を
持ち、同じ式が `src/game/game-entity/ship.ts:86-88` にも書かれている。`SHOP_CATALOG` の
"Gatling Gun"(fireRate/damage/muzzleVelocity)と "Light Armor"(damageReduction 0.2)の値も
`Ship.initDefaultParts()` の既定値と一致しており、`base-view-shared.ts:15-17` のコメントが
「同じ単位・同じ桁で書く」よう**手で揃える運用**を明言している。規約 1.6 の
「整合性保持責務の漏洩は重大な違反」に当たる。

解消には `src/game/game-entity/ship.ts`(HUD の外)を共通定数へ切り出す変更が要るため、
HUD のリファクタリングの範囲を超える。
