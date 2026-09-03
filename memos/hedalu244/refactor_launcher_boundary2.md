# launcher / game の境界に残る歪みの整理

行番号・件数は **`720ff639`** 時点。着手時にずれていたら周辺を読み直す。

## 目的

`launcher/`(ランの外側)と `game/`(1ランの中身)の二層はできた。`game/` から `launcher/` を
指す import は 0 件で、層の向きは守られている。**残っているのは「両者が共有して見ているもの」の
置き場所である。**

- **共有物が `game/` の中に置かれている。** `launcher/` + `main.ts` + `perf-meter.ts` は
  `game/hud/` を **29 本**直接 import しており、参照先は 9 モジュールだけ — `widgets/`
  `overlay-manager` `breakpoints` `utils` `property-window` と `Hud` 本体。
  `game/theme` は 25 ファイル(`launcher/` 4・`render/title-scene.ts` 1 を含む)、
  `game/input/` は 35 ファイル(`launcher/` 4・`perf-meter.ts` 1 を含む)が引く。
  **これは launcher がゲームの内部を覗いているのではなく、両者の土台が `game/` に居る**という
  ことで、置き場所を直せば消える。
- **`launcher/` が「起動のため」ではなく「自分の画面のため」に `game/` を見ている。**
  `stage-select` は `game/hud/widgets` と `game/theme` でタイトル画面を組み、`save-browser` の
  4 ファイルは `game/hud/widgets` `game/hud/utils` `game/hud/breakpoints` で一覧を組む。
  `perf-meter.ts` に至っては `src/` 直下に居ながら `game/hud/windows/property-window` で窓を
  組み、`location.search` を読む(`perf-meter.ts:123`。`location.*` を知ってよいのは
  `launcher/` だけ)。
- **`game/` が自決できるものを `launcher/` が組んで注入している。** 星系(`CelestialSystem`)は
  `launcher.ts:49-60` が `stageClass.createCelestialSystem()` を呼んで組み、`new Game(...)` へ
  渡すだけで launcher 自身は一度も触らない。`RenderPipeline` `GameScene` `FrameSections`
  `WorldSfx` `UiSfx` も同じく **Launcher のフィールドとして持ちながら `new Game(...)` の引数に
  しか現れない**(`launcher.ts:150-151`)。Launcher のコンストラクタ 13 引数のうち 5 つが
  素通しである。
- **ランの直列化を `launcher/` が組んでいる。** `GameSaveData` を組み立てる唯一の入口は
  `launcher/save/snapshot-service.ts:91` の `buildSaveData(game)` で、`Game` に `serialize()` は
  無い。索引メタを作るために `game.player.maxHp` `game.dynamicSystem.bases[].baseState.money`
  `game.dynamicSystem.enemies.filter(...)` を直接掘り(`snapshot-service.ts:23-46`)、その
  ついでに `game/hud/orbit/orbit-info` と `game/hud/utils` まで引いている。

是正後は `src/` が次の形になる。

```
src/
  main.ts        組み立てと rAF ループ
  theme.ts       見た目の定数            (game/ launcher/ render/ が読む)
  input/         入力の受け口            (game/ launcher/ が読む)
  hud/           画面の器と共通部品      (game/ launcher/ が読む)
  math/ physics/ render/ audio/
  game/          1ランの中身
  launcher/      ランの外側
  assets/ types/
```

`launcher/ → game/` に残る import は「どのステージがあるか」「ランをどう起動し・畳み・
記録するか」だけになる。

## 決めたこと

以下はこの計画の中で決めた。**覆せる。** 覆したときにどの手順が変わるかを併記する。

- **`src/save/` は作らない。** `DEVELOP/CODING-RULE.md:81-93` が 5 層を定義し、`launcher/` の
  担当として「セーブスロット・スナップショット」を名指ししている。実測でも `launcher/save/` の
  7 ファイル中 5 ファイル(`slot-data` `save-store` `save-slots` `save-transfer` `legacy-save`、
  776 行 = 84%)は `GameSaveData` を**不透明な JSON として運ぶだけで中身を一度も読まない**一方、
  `game/save/save-data.ts` の 24 export は `game/` の 27 ファイルからしか参照されない。
  **この 2 群は実際に混ざっていない。** 歪みは置き場所ではなく「誰が直列化を組むか」にあるので、
  手順9 でそちらを直す。→ 覆す(`src/save/` へ統合する)なら CODING-RULE 1.3 の改訂とセットに
  なり、手順9・手順10 が別物になる。
- **`Hud` の寿命は変えない。** `Hud` はいまどおり `main.ts` が1つ作り、ランより長生きする。
  ランごとに作り直せば `Game.dispose()`(`game.ts:289-292`)の後始末4行は消せるが、ウィンドウ
  位置・折り畳み状態などランを跨いで保たれている状態が毎回消える。**挙動が変わるので採らない。**
  代わりに手順5 で「画面の器」だけを `HudShell` として切り出す。→ 覆すなら手順5 が
  「`Hud` を `Game` が作る」に変わり、手順8 の `Game.create()` へ吸収される。
- **`Hud.hint()` / `Hud.toast()` は `Hud` に残す。** 呼び出しは 87 箇所・25 ファイルあり、
  `HudShell` へ移すと全部書き換えになる。しかも launcher 側の呼び手
  (`unlock-manager.ts:51` `snapshot-controls.ts:42,46`)は**どちらもラン中に走る** — 動いている
  ランの HUD へメッセージを出すのは筋が通っており、この 2 ファイルが `Hud` を持つのは歪みでは
  ない。→ 覆す(トーストを `HudShell` へ移す)なら手順5 に 87 箇所の書き換えが加わる。
- **`RenderPipeline` は `Game` には作らせない。** GPU 資源(シャドウマップ・レンダーターゲット・
  各パス)を確保するので起動時に1つでなければならず、`main.ts:153` が `graphics.bind(pipeline)`
  で設定の押し出し先に登録し、`PerfMeter` がデバッグ表示の書き込み先として保持し続ける。
  代わりに手順7 で **`GameScene` の持ち物にする** — Launcher が既に素通ししている `gs` に
  相乗りさせ、引数を1つ減らす。→ 覆す(いまのまま素通しする)なら手順7 を落とす。
- **星系の構築は `Game` の静的非同期ファクトリへ移す。** `Game.create()` が
  `await stageClass.createCelestialSystem(...)` を済ませてから `new Game(...)` を返すので、
  **半端に組み上がった `Game` を誰も観測しない** — 二段階初期化ではない。ローディング画面の
  開閉は launcher が握ったまま、進捗コールバックだけを渡す。→ 覆すなら手順8 を落とす。
- **ローディングの進捗は「段 + 実測の重み」で出す。** いまゲージが動くのは暦パックの受信中だけで、
  そのあとの構築は全部同期なので止まって見える。段ごとに描画機会を明け渡して報告する
  (手順8)。**残り時間の予測はしない** — 実測の重みで段を割るだけにする。
  → 覆す(段を増やさない)なら手順8 が `create()` の移設だけになる。
- **起動時のタンパク質アセット先読みはやめる。** 起動のたびに **93.6 MB** を fetch し、
  `response.json()` の構文解析と索引配列の全走査を**メインスレッドで**行っている
  (`protein-asset-loader.ts:39-43`、`protein-display-asset.ts:53,60`)。これが
  `Game.create()` の外で並行に走っているので、**手順8 で段を細かくしてもゲージは固まったまま。**
  使うのはクリエイティブステージだけなので、要求された体を要求された時点で読む形にする
  (手順12)。→ 覆す(先読みを残す)なら、解析を Worker へ出す別の手順に置き換わる。
  取得量そのものは減らないので、ゲージが固まる時間は短くなるだけになる。
- **元期・地球自転初期位相の決定も `Game.create()` へ入れる。** `launcher.ts:143-145` が
  `initialSave` から読んでいるが、`initialSave` はランの直列化形であり、launcher が渡すべきは
  「開始日時を選ばせるステージで選ばれた値」(`startEpoch`)だけである。→ 覆すなら手順8 で
  `epoch` と `earthSpinPhase0` を引数のまま残す。
- **`ProteinMotionLod` の重複は解消する。** `src/protein-motion-metrics.ts:6` と
  `src/game/protein/protein-motion-controller.ts:11` が同じ 4 値を独立に定義している。
  後者を正本にする(`protein-runtime.ts` `protein-enemy.ts` が既に後者を使っている)。
- **`EphemerisContext` の重複も解消する。** `game/save/save-data.ts:216-223` と
  `game/save/ephemeris-context.ts:8-15` が同じ 4 フィールドを独立に持っている。
  手順10 で `physics/` 側を正本にする。

## 達成目標

全手順の実施後、次がすべて満たされること。

1. `ls src/*.ts` が **`main.ts` と `theme.ts` の 2 件だけ**になる。
   `ls -d src/*/` が `assets/ audio/ game/ hud/ input/ launcher/ math/ physics/ render/ types/`。
2. **`launcher/` が `game/` から取るものが「ステージ・ラン・セーブの形」だけになる。**
   `grep -rn "game/hud\|game/theme\|game/input" src/launcher/ src/main.ts` が **0 件**。
3. `grep -rn "from '.*game/" src/hud/ src/input/ src/render/ src/physics/ src/math/ src/audio/`
   が **0 件**(共有層と下位層が `game/` を引かない)。`src/render/title-scene.ts:6` の
   `game/theme` 参照も消える。
4. `grep -rn "launcher/" src/game/ src/hud/ src/input/ src/render/ src/physics/ src/math/ src/audio/`
   が **0 件**(いまも 0 件。維持されていること)。
5. `grep -rn "location\." src/game/ src/hud/ src/input/` が **0 件**。
6. **Launcher のコンストラクタ引数が 13 → 8 以下になる。** `grep -c "private readonly"
   src/launcher/launcher.ts` で数える。`gs` 以外の描画・音声・計測の素通し
   (`pipeline` `sections` `worldSfx` `uiSfx`)が消えている。
7. `grep -n "createCelestialSystem\|earthSpinPhase0\|Math.random" src/launcher/launcher.ts` が
   **0 件**。星系の構築は `src/game/game.ts` の `Game.create()` にだけある。
8. `grep -n "game\.player\.\|game\.dynamicSystem\.\|game\.activeStage\." src/launcher/save/snapshot-service.ts`
   が **0 件**。`Game.serialize()` と `Game.runSummary()` の 2 呼び出しに畳まれている。
9. `grep -rn "ProteinMotionLod" src/ | grep -c "= \['near'\|= 'near'"` が **1** (定義が1箇所)。
   `EphemerisContext` の形の定義も 1 箇所。
10. `grep -rn "importSlotFromFile" src/` が `save-transfer.ts` の中だけになる
    (使われていない export が落ちている)。
11. **起動のローディングゲージが、暦パックの受信が終わったあとも進む。** `?stage=1` の起動で
    0% から 100% まで段階的に描き変わり、途中で 1 秒以上止まる区間がない。
    `grep -rn "startProteinAssetPreload" src/` が 0 件で、起動時に
    `*Structure.json` `*Motion.json` を取りに行かない。
12. `DEVELOP/CODING-RULE.md` 1.3 が `math/` `physics/` `render/` `input/` `hud/` `game/`
    `launcher/` の 7 層で書かれ、どれがどれを import してよいかが書かれている。
    `ephemeris-context` は `physics/ephemeris/` の中だけに入り、`physics/` の他の場所に
    新しい export が生えていない。
13. `npm run typecheck` `npm run test` `npm run build` が通る。
14. **見た目と操作が変わっていない。** タイトル画面・ゲーム中 HUD・結果画面・セーブブラウザ・
    負荷確認ウィンドウ・設定ビュー・タッチ操作パッドのいずれも、移行前と同じに描かれる。
    **意図して変える挙動は 3 点だけ** — ①ローディングゲージが段階的に進むようになる(手順8)、
    ②クリエイティブでタンパク質の敵を置くとき、初回だけ取得を待つ(手順12)、
    ③ラン終了時に噴射音・RCS 音のループが破棄される(手順11)。

## 実施済み

| 手順 | commit |
| --- | --- |
| 1. HUD ウィンドウからタイトル画面の知識を落とす | `6f5ec302` |
| 2. `theme.ts` を `src/` 直下へ移す | `a1fe33f1` |
| 3. `input/` を `src/` 直下へ、`TouchControls` を `game/hud/` へ | `f0c12eaa` |

## 残った目視確認

**実施した手順の型検査と回帰テストは通っている。実機で確かめるのはここ。**

1. **(手順1)** `?title=1` を開き、タイトル画面で ESC → 一時停止メニューが選択画面の**上**に
   出る。「⚙ 設定」から設定ビューを開いても同じ。閉じると選択画面が前面へ戻る。
   ステージ開始後に ESC → メニューが従来どおり HUD の中に出る(`#hud` の z-index が上がらない)。
   タイトル中に ESC →「セーブデータの管理」を開くと、**一覧が選択画面の上に出る**
   (従来は選択画面の裏に隠れていた)。
2. **(手順2)** HUD の配色・フォント、タイトル画面の配色が変わっていない。
3. **(手順3)** WASD・マウスドラッグ・ホイールズーム・ESC・[R] が従来どおり効く。
   DevTools のデバイスエミュレーションでタッチ端末にし、画面下部の操作パッドが出て、
   戦闘/マップ切替でボタン構成が切り替わる。

## 手順

### 手順4. `src/hud/` を作り、共有の部品を移す

**目的.** `game/hud/` の 101 ファイルのうち **30 ファイル(約 1,750 行)は、ゲーム内部への依存を
1 本も持たず、`launcher/` 側から直接使われている。** これらが `game/` に居るせいで、launcher が
自分の画面を組むために `game/` を引いている。共有部品として `src/hud/` へ出す。
**この時点で挙動は変えない。**

**変更が必要な箇所**

移すもの(`git mv`。中身は下記 3 件の切り分けを除き変更しない):

| 移動元 | 移動先 | 根拠 |
| --- | --- | --- |
| `game/hud/widgets/` 16 ファイル(860 行) | `src/hud/widgets/` | `widgets/index.ts` を launcher 5 ファイル + `perf-meter.ts:5` が引く。16 ファイルすべて hud 内部で閉じている |
| `game/hud/overlay-manager.ts`(155) | `src/hud/overlay-manager.ts` | import 0 本。`result-screen.ts:5` `save-browser.ts:10` `perf-meter.ts:11` が引く |
| `game/hud/overlay-layer.ts`(34) | `src/hud/overlay-layer.ts` | import 0 本。手順5 で `HudShell` が使う |
| `game/hud/layout.ts`(19) | `src/hud/layout.ts` | import 0 本。`draggable-window` `pause-menu` 等の土台 |
| `game/hud/viewport.ts`(60) | `src/hud/viewport.ts` | 依存は theme のみ |
| `game/hud/breakpoints.ts`(26) | `src/hud/breakpoints.ts` | import 0 本。launcher 3 ファイルが引く |
| `game/hud/windows/property-window*.ts` 5 ファイル(683) | `src/hud/windows/` | `perf-meter.ts:4` が引く。ゲーム内部依存なし |
| `game/hud/windows/draggable-window.ts`(324) | `src/hud/windows/` | property-window の外枠。唯一の game 依存 `:14` の `CLICK_MOVE_THRESHOLD` は手順3 で `src/input/` へ移っている |
| `game/hud/windows/shortcut-hint.ts`(7) | `src/hud/windows/` | import 0 本 |
| `game/hud/windows/pause-menu.ts`(264) | `src/hud/windows/` | 所有者は `main.ts:123`。`game.ts:445` は注入された参照を toggle するだけ |
| `game/hud/windows/settings-view.ts`(195) | `src/hud/windows/` | 所有者は `main.ts:124`。`game/` からの参照 0 |
| `game/hud/panels/bgm-settings-panel.ts`(178) `graphics-panel.ts`(92) `theme-panel.ts`(42) | `src/hud/panels/` | SettingsView 専用タブ。依存は `audio/bgm` `render/graphics-settings` `theme` のみ |
| `game/hud/style/settings-view-style.ts`(167) | `src/hud/style/` | SettingsView の CSS。依存は breakpoints のみ |

切り分けが要るもの(3 件):

| ファイル | 何をするか |
| --- | --- |
| `game/hud/utils.ts`(101) | `fmtAmmoStatus`(:87-91)だけが `:3` の `MAG_ROUNDS`(`player/player-fire`)に依存する。**この 1 関数を `src/game/hud/ammo-status.ts` へ切り出し**、呼び手 2 箇所(`panels/vessel-panel.ts:255`・`player/player.ts:775`)を書き換える。残りを `src/hud/utils.ts` へ移す |
| `game/hud/windows/index.ts`(14) | バレルが `HelpPanel`(view/input 依存)・`ResourceTransferDialog`(player 依存)・`MenuCommon`(pickable 依存)まで再 export しており、**このバレル 1 本で launcher → game 内部の依存が生えている**。`src/hud/windows/index.ts`(PauseMenu / SettingsView / DraggableWindow / PropertyWindow / ShortcutHint)と `src/game/hud/windows/index.ts`(残り)へ割る |
| `game/hud/style/screen-style.ts`(85) | `:6-23` が `#hud-result`(launcher の画面)、`:51-84` が `#hud-pause-menu`(共有)、`:25-49` が `#hud-stagestatus`(ゲーム)。3 つへ割り、順に `src/launcher/result-screen.ts` の注入・`src/hud/style/`・`src/game/hud/style/` へ置く |

呼び出し元の書き換え: 上記モジュールを指す import は **191 行 / 102 ファイル**
(内訳: widgets 66・utils 33・overlay-manager 22・property-window 21・breakpoints 19・
overlay-layer 7・draggable-window 6・layout 4・viewport 4・その他 9)。
**判断の余地がない一括編集なので、ディレクトリ単位でサブエージェントへ配る**(`/delegate`)。

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -rn "from '.*game/" src/hud/` が 0 件。
- `grep -rn "game/hud/widgets\|game/hud/utils\|game/hud/breakpoints\|game/hud/overlay-manager\|game/hud/windows/property-window" src/launcher/ src/main.ts src/perf-meter.ts` が 0 件。
- `find src/hud -name '*.ts' | wc -l` が 31(移した 30 + 切り出した utils の分割先)。
- `npm run test:game` `npm run test:render` が通る。
- `npm run dev` で **CSS の欠落を目で確かめる**: ①ゲーム中 HUD の左右レール・上部バー、
  ②ESC メニュー、③設定ビューの 3 タブ(BGM・描画・テーマ)、④F9 のセーブブラウザ、
  ⑤負荷確認ウィンドウ(`?perf=1`)、⑥タイトル画面。いずれもボタン・タブ・スライダの
  枠線と余白が従来どおりであること。

---

### 手順5. `HudShell` を切り出し、ランの外側の画面が `Hud` を持たなくなるようにする

**目的.** `game/hud/hud.ts` の `Hud` は `:15` で `import type { Game }` しているので、
`launcher/` がこれを持つと launcher → game 内部の依存になる。しかし launcher が実際に使うのは
`layers.system` `layers.window` `overlayManager` の 3 つだけ(`main.ts:123,124,182,193`、
`result-screen.ts:34,53`、`launcher.ts:121`)。**`#hud` ルート・レイヤ台帳・OverlayManager を
`HudShell` として切り出し、`main.ts` がこれを作って `Hud` と launcher 側の双方へ渡す。**
`Hud` の寿命も、`Hud.hint()/toast()` の 87 箇所の呼び出しも変えない。
**この時点で挙動は変えない。**

**新しい API**

```ts
// src/hud/hud-shell.ts (新規)
// #hud ルートと重なり順のレイヤ、モーダルの排他制御を持つ画面の器。
// ゲームの HUD もランの外側の画面も、この上に載る。
export class HudShell {
  readonly root: HTMLElement;
  readonly layers: OverlayLayers;
  readonly overlayManager: OverlayManager;
  constructor(renderStyle: RenderStyleSetting);
}

// src/hud/hud-element.ts (新規) — hud-root.ts:43 の createHudElement を共有へ出す
export function createHudElement(
  tag: string, id: string, parent: HTMLElement, className?: string,
): HTMLElement;
```

```ts
// src/game/hud/hud.ts
export class Hud {
  constructor(shell: HudShell, renderStyle: RenderStyleSetting);
  readonly shell: HudShell;
  // root / layers / overlayManager は shell 経由で読む。Hud からは公開しない。
}

// src/game/hud/hud-root.ts
export function buildHudDom(shell: HudShell, renderStyle: RenderStyleSetting): HudDomRefs;
```

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/hud/hud-shell.ts`(新規) | `hud-root.ts:409-416` の `injectThemeVariables` / `injectStyle` / `startViewportTracking` / `#hud` 生成 / `renderStyle.subscribe` / `buildOverlayLayers` と、`:426-427` の `#hud-overlay-shield` + `OverlayManager` 生成をここへ移す。注入するスタイルは `LAYOUT_TOKENS_STYLE` `SKELETON_STYLE` `OVERLAY_LAYER_STYLE` `WIDGET_STYLE` と手順4 で割った共有ぶんの `SCREEN_STYLE` `SETTINGS_VIEW_STYLE` |
| `src/hud/hud-element.ts`(新規) | `hud-root.ts:43` の `createHudElement` を移し、`hud-root.ts` と `HudShell` の双方から使う |
| `src/game/hud/hud-root.ts` | `buildHudDom(shell, renderStyle)` に変え、上記を削る。残るゲーム側のスタイル(`MARKER_STYLE` `COMBAT_PANEL_ROWS_STYLE` `MAP_PANEL_STYLE` `HELP_PANEL_STYLE` `COMBAT_VIEW_STYLE` `MAP_VIEW_STYLE` + 割った `SCREEN_STYLE` のゲームぶん)は**シェルの注入より後**に注入する。`:434` の `#hud-result` 生成は削る |
| `src/game/hud/hud.ts` | コンストラクタで `shell` を受け、`root`/`layers`/`overlayManager` の再公開をやめる。`game/` 内でこれらを読んでいる箇所(`game.ts:128,161,256,445`・`plan-editor.ts:96,97`・`pickable/object-windows.ts:86,115`・`pickable/orbit-line-windows.ts:41`・`pickable/part-windows.ts:57`・`docking/docking.ts:91`・`stages/creative-stage.ts:103`)を `hud.shell.*` へ |
| `src/launcher/result-screen.ts` | `Hud` を受けるのをやめて `HudShell` を受ける。`#hud-result` を自分で `shell.layers.system` へ生成し、手順4 で割った CSS を自分で注入する(`:24,29,39` の `getElementById` はそのまま使えるが、生成元が移る) |
| `src/launcher/launcher.ts:7,88,121` | `resultScreen` へ渡すのを `shell` にする。`:121` の `this.hud.overlayManager` を `this.shell.overlayManager` へ。`hud` は `new Game(...)` へ渡すためだけに残る |
| `src/launcher/save-browser/save-browser.ts` | `OverlayManager` の import 元は手順4 で `src/hud/` へ移っている。受け取る引数は変えない |
| `src/main.ts:120-127,182,193` | `const shell = new HudShell(renderStyle);` を先に作り、`new Hud(shell, renderStyle)`、`PauseMenu` / `SettingsView` / `SaveBrowser` / `PerfMeter` へは `shell.layers.*` `shell.overlayManager` を渡す |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -rn "game/hud/hud'" src/launcher/ src/main.ts` が **`launcher.ts` と `main.ts` の
  `new Game(...)` 経路だけ**になる(`result-screen.ts` から消える)。
- `grep -rn "hud-result" src/game/` が 0 件。
- `npm run test:game` が通る。
- `npm run dev` で**重なり順を目で確かめる**: ①ゲーム中に軌道解析ウィンドウを開き、その上へ
  ESC メニューが出る、②ESC メニューを開いている間、背後の HUD がクリックを受けない
  (遮蔽幕が効いている)、③F9 のセーブブラウザが ESC メニューと同じ帯に出て、開くと
  ESC メニューが閉じる、④決着後の結果画面が全ての窓より前に出る、⑤トーストが結果画面より
  手前に出ない。⑥タイトル画面(`?title=1`)で ESC メニューが選択画面の上に出る。

---

### 手順6. `src/` 直下の残りを、それぞれの層へ配る

**目的.** `src/` 直下に残る 4 ファイルは、どれも `src/` 直下に居る理由がない。
`perf-meter.ts` は `location.search` を読む(`:123`)ランの外側の窓、`gpu-timings.ts` は
`render/pipeline/` の 11 ファイルが使う描画の計測、`protein-motion-metrics.ts` は
`game/protein/` の話、`frame-sections.ts` の区間名(`SECTION`)は `game/` の update の位相
そのものである。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/perf-meter.ts` → `src/launcher/perf-meter.ts` | `git mv`。import は手順3・手順4 で既に `src/input/` `src/hud/` を指している |
| `src/game/perf-counts.ts`(新規) | `perf-meter.ts:17-29` の `PerfCounts` 型と `:30-33` の `PerfCountSource`(`perfCounts()` と `proteinMotionFrameSample()` を持つ口)をここへ切り出す。`game/` 8 ファイル(`game.ts:3` `dynamic-system.ts:36` `predictor.ts:21` `simulator.ts:29` `plan-display.ts:27` `combat-view.ts:25` `map-view.ts:25` `view.ts:8`)の import 先をここへ。`launcher/perf-meter.ts` はここから読む |
| `src/gpu-timings.ts` → `src/render/gpu-timings.ts` | `git mv`。`render/pipeline/` 10 ファイル + `main.ts:10` + `launcher/perf-meter.ts:10` の import を書き換え |
| `src/protein-motion-metrics.ts` → `src/game/protein/protein-motion-metrics.ts` | `git mv`。`:5-6` の `PROTEIN_MOTION_LODS` / `ProteinMotionLod` の定義を落とし、`./protein-motion-controller` の `ProteinMotionLod`(`:11`)を import する。`PROTEIN_MOTION_LODS` が要るなら `protein-motion-controller.ts:29` の `LODS_FINE_TO_COARSE` を export して使う |
| `src/frame-sections.ts` → `src/game/frame-sections.ts` | `git mv`。`game.ts:5` `simulator.ts:28` `launcher.ts:21` `main.ts:11` `launcher/perf-meter.ts:9` の import を書き換え。**インスタンスは `main.ts` が持ったまま** — `PerfMeter` が参照を握り続けるので、ランごとに作り直すと再出撃後に静かに計測が止まる |
| `src/main.ts:9,10,11,14` | 上記の import 先を書き換え |

**達成条件と検証**

- `npm run typecheck` が通る。
- `ls src/*.ts` が `main.ts` `theme.ts` の 2 件。
- `grep -rn "ProteinMotionLod" src/ | grep "'near'"` が定義 1 箇所だけになる。
- `grep -rn "location\." src/game/ src/hud/ src/input/ src/render/` が 0 件。
- `npm run test` が通る。
- `npm run dev` で `?perf=1` を開き、負荷確認ウィンドウの全行(区間・GPU パス・エンティティ数・
  タンパク質モーションの LOD 内訳)に値が出ることを見る。ESC メニューの「負荷」からも開く。

---

### 手順7. `RenderPipeline` と `GpuTimings` を `GameScene` の持ち物にする

**目的.** `main.ts:152-155` が `GpuTimings` → `RenderPipeline` の順に作り、`graphics` へ 2 回
`bind` し、Launcher がそれを素通しして `Game` へ渡している。どれも `gs.renderer` から作られる
描画基盤で、`gs` と寿命が完全に一致する。`GameScene` に持たせれば **Launcher と Game の引数が
1 つずつ、`main.ts` の bind が 1 つ減る。**

**新しい API**

```ts
// src/render/scene.ts
export interface GameScene {
  scene: THREE.Scene;
  renderer: WebGPURenderer;
  gpu: GpuTimings;
  pipeline: RenderPipeline;
  applyGraphics: (graphics: GraphicsSettingsData) => void;  // pipeline へも押し出す
}
```

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/scene.ts:6-12,19-52` | `GpuTimings` と `RenderPipeline` を `createGameScene` の中で作って返す。`applyGraphics`(:35-38)から `pipeline.applyGraphics(next)` も呼ぶ。**使われていない `resize` の公開を落とす**(`window.addEventListener` は中で張っており、外からの呼び出しは 0 件) |
| `src/main.ts:152-155` | `new GpuTimings(...)` `new RenderPipeline(...)` `graphics.bind(pipeline)` の 3 行を削除。`graphics.bind(gs)` だけ残す |
| `src/main.ts:193` | `PerfMeter` へ `gs.renderer` `gs.gpu` `gs.pipeline` を渡す |
| `src/launcher/launcher.ts:20,85,151` | `pipeline` のフィールドと引数を削除 |
| `src/game/game.ts:31,54,117,122,166-168` | `pipeline` 引数を削除し、`gs.pipeline` を読む |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -n "RenderPipeline" src/launcher/` が 0 件。
- `grep -c "private readonly" src/launcher/launcher.ts` が 1 減る。
- `npm run test:render` が通る。
- `npm run dev` で ①通常の描画(地球・大気・影・太陽)が従来どおり出る、②設定ビューの描画タブで
  影の枚数・解像度倍率を変えると即座に反映される、③`?perf=1` の GPU パス行に値が出る、
  ④負荷確認ウィンドウの「デバッグ表示」で G-Buffer などへ切り替わる。
- `npm run render-lab:shot` で撮り直し、移行前と見比べる。**半影を含む絵は撮り直しで
  ±4 LSB 揺れるので、差分を根拠にする前にもう一度撮る。**

---

### 手順8. 星系の構築を `Game.create()` へ移す

**目的.** `launcher.ts:49-60,142-152` が元期・地球自転初期位相・位相オフセットを決めて
`stageClass.createCelestialSystem()` を呼び、できた `CelestialSystem` を `new Game(...)` へ
渡している。**launcher はこれを一度も触らない。** どれも `initialSave`(ランの直列化形)から
決まる値で、launcher が持つべき情報は「開始日時を選ばせるステージで選ばれた値」だけである。
静的非同期ファクトリを入口にすれば、**半端に組み上がった `Game` を誰も観測しないまま**構築を
`game/` へ寄せられ、ローディング画面の開閉は launcher が握ったままにできる。

**あわせて、進捗を段で報告する。** いまゲージが動くのは暦パックの受信バイト数の間だけで
(`physics/ephemeris/catalog.ts:14-29`)、その後の `PackEphemeris.fromBytes` → `ephemerisPoints()`
→ `solarSystem()` → `new Game(...)` → `celestialSystem.build()` は**全部同期**なので、ゲージは
止まったまま数える対象を失う。**同期のまま進捗だけ書いてもゲージは動かない** — ブラウザは実行中の
タスクが終わるまで再描画しないので、段の切り替えで必ず一度描画機会を明け渡す。
`Game.create()` の中はまだ `launcher.current` が `null`(`main.ts` の `animate()` が
`game === null` で素通りする)なので、途中で `await` しても組み立て中の `Game` は誰にも触られない。

**新しい API**

```ts
// src/game/loading-progress.ts (新規)
// 起動の段と、実測から決めた所要時間の重み。合計は 1。
export type LoadingPhase = 'ephemeris' | 'system' | 'celestial' | 'assemble';
export const LOADING_PHASE_WEIGHTS: Readonly<Record<LoadingPhase, number>>;

// 段の中の 0..1 を全体の 0..1 へ写して報告する。
export class LoadingProgress {
  constructor(report: (ratio: number) => void);
  // 直前の段までを完了として報告し、ブラウザへ描画を1回明け渡してから phase へ入る。
  enter(phase: LoadingPhase): Promise<void>;
  // いまの段の中の進捗 [0,1]。同期処理の途中で呼んでも再描画はされない。
  within(ratio: number): void;
}

// src/game/game.ts
export class Game {
  // 星系の構築を含む、このランの組み立て。
  static async create(
    gs: GameScene,
    stageClass: StageClass,
    hud: Hud,
    worldSfx: WorldSfx,
    uiSfx: UiSfx,
    pauseMenu: PauseMenu,
    sections: FrameSections,
    initialSave: GameSaveData | undefined,
    startEpoch: TdbJulianDate | undefined,
    progress: LoadingProgress,
  ): Promise<Game>;

  private constructor(/* 上記 + celestialSystem: CelestialSystem */);
}
```

**重みは実測で決める。** 着手時に `?stage=1` の起動へ一時的に `performance.now()` を挟み、
4 段それぞれの所要時間を取る。**得た値を `LOADING_PHASE_WEIGHTS` に直書きし、いつ・どの機械で
測ったかをそのファイルの先頭コメントに書く。** 測った share が 5% を切る段は隣へ畳んで段を減らす。
**この実測は手順12 の判断材料でもある。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/loading-progress.ts`(新規) | 上記。`enter()` の描画明け渡しは `await new Promise(requestAnimationFrame)` |
| `src/game/game.ts:108-119` | `constructor` を `private` にし、`celestialSystem` を引数の末尾へ。`static async create()` を足し、`launcher.ts:44-46`(`savedEpoch`)・`:143`(元期の解決)・`:145`(`earthSpinPhase0`)・`:147`(`phaseOffsets`)・`:49-60`(`createCelestialSystem` 呼び出し)の中身をここへ移す。**元期解決の順序(セーブ → 指定日時 → ステージ宣言)のコメントも一緒に移す** |
| `src/game/game.ts:166-168` | `celestialSystem.build(...)` をコンストラクタから `Game.create()` へ移し、`'celestial'` の段にする。**`:169-174`(`setOrbitGuideSettings` と `setOnLineCountChange`)は build 済みであることが前提なので、コンストラクタに残したままでよい** |
| `src/game/stages/stage.ts:117-123` | `createCelestialSystem` の `onProgress` へ渡すのは `'ephemeris'` 段の中の比率(`progress.within`)。署名は変えない |
| `src/launcher/launcher.ts:22,25,42-60,140-152` | `initCelestialSystem` と `savedEpoch` を削除。`CelestialSystem` の import を落とす。`startRun()` は `showLoading()` → `await Game.create(..., new LoadingProgress(setLoadingProgress))` → `finally { hideLoading() }` の形にする |
| `src/launcher/launcher.ts:25` | `createJulianDate` の import を落とす(`TdbJulianDate` は `startEpoch` の型として残る) |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -n "createCelestialSystem\|earthSpinPhase0\|phaseOffsets\|Math.random" src/launcher/launcher.ts` が 0 件。
- `grep -n "new Game(" src/` が 0 件(`Game.create()` だけになる)。
- `npm run test:game` が通る。
- `npm run dev` で ①`?stage=1` の起動で**ゲージが 0% から 100% まで段階的に進む**(途中で止まって
  跳ぶのでなく、4 段の境目で必ず一度描き変わる)、②[R] の再出撃でも同じ、③タイトルへ戻って
  別ステージを選び直せる、④クリエイティブステージで開始日時を選ぶと**その日時**で始まる
  (直前セッションのスナップショットの元期に上書きされない)、⑤既存のスナップショットを F9 から
  読むと、天体配置が保存時と一致する。
- 暦パックを読まない元期(解析暦だけで組む時代)でも、`'system'` 以降の段でゲージが進む。

---

### 手順9. `Game.serialize()` と `Game.runSummary()` を作り、SnapshotService の掘り出しを畳む

**目的.** ランの直列化形を組み立てる唯一の入口が `launcher/save/snapshot-service.ts:91` の
`buildSaveData(game)` にあり、`Game` に `serialize()` が無い。そのうえ索引メタを作るために
`snapshot-service.ts:23-46` が `game.player.maxHp` `game.dynamicSystem.bases[].baseState.money`
`game.dynamicSystem.enemies.filter(...)` `game.activeStage.phase` を直接掘り、ついでに
`game/hud/orbit/orbit-info` と `game/orbit-reference` まで引いている。**ランの中身の直列化と
要約はランの仕事**にし、launcher は受け取った値を索引の形へ写すだけにする。

**新しい API**

```ts
// src/game/run-summary.ts (新規)
// ランの外側が一覧に描くための、いまのランの要約。索引の形(SnapshotMeta)は
// 知らない — 素の値だけを返し、並べ替えるのは受け取った側の仕事。
export interface RunSummary {
  readonly simTime: number;
  readonly phase: GamePhase;
  readonly centerBodyId: string;
  readonly centerBodyName: string;
  readonly altitude: number;
  readonly speed: number;
  readonly hpRatio: number;
  readonly maxHp: number;
  readonly magazines: number;
  readonly money: number;
  readonly playerCount: number;
  readonly enemyAliveCount: number;
}

// src/game/game.ts
export class Game {
  serialize(): GameSaveData;
  runSummary(): RunSummary;
}
```

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/run-summary.ts`(新規) | `RunSummary` 型。`snapshot-service.ts:30-46` の導出のうち、素の値になる 12 項目 |
| `src/game/game.ts` | `serialize()` を足し、`snapshot-service.ts:91-111` の `buildSaveData` をそのまま移す(各サブシステムの `serialize()` を集めるだけ)。`runSummary()` を足し、`:23-29,36-46` の導出を移す |
| `src/game/hud/orbit/orbit-info.ts` → `src/game/orbit-info.ts` | `git mv`。冒頭コメントが自ら「純粋関数群」と宣言しており、import は `physics/*` と `math/vec3` と型 2 つだけで DOM にも THREE にも触れない。**HUD ではないので `hud/` から出す。** `hud/orbit/` 側の呼び手 7 ファイルの import を書き換え |
| `src/launcher/save/snapshot-service.ts:1-11,19-49,91-118` | `capture()` を `game.runSummary()` + `game.serialize()` の 2 呼び出しへ畳む。`autoName()` は `RunSummary` を受ける形に直す(`fmtDist` `fmtTime` は手順4 で `src/hud/utils` へ移っている)。`orbitInfo` `autoOrbitReference` `OrbitInfo` の import を落とす |
| `src/launcher/save/save-transfer.ts:52` | 外部利用者が 0 の `importSlotFromFile` の `export` を落とす(同ファイル `:104` からのみ呼ばれる) |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -n "game\.player\|game\.dynamicSystem\|game\.activeStage\|game\.celestialSystem" src/launcher/save/snapshot-service.ts` が 0 件。
- `grep -rn "game/hud" src/launcher/save/` が 0 件。
- `grep -rn "importSlotFromFile" src/ | wc -l` が 2(定義と自ファイル内の呼び出し)。
- `npm run test:game` が通る。
- `npm run dev` で ①F5 で手動スナップショットを撮り、F9 の一覧に
  「MET ○○ ・ 地球 高度 ○○」の自動命名で出る、②同じ行の高度・速度・HP・弾倉・資金・敵数が
  HUD の表示と一致する、③自動スナップショットも同じ形で溜まる、④**移行前に撮った
  スナップショットが従来どおり読める**、⑤スロットの書き出しと取り込みが通る。

---

### 手順10. `ephemeris-context` を `physics/` へ移し、`EphemerisContext` の重複を消す

**目的.** `game/save/ephemeris-context.ts` は `src/game/` からの利用者が **0 件**
(`grep -rn "ephemeris-context" src/game/` が該当なし)で、実行時の呼び手は
`launcher/save/snapshot-service.ts` だけ。中身は `physics/ephemeris/*` と `physics/time` にしか
依存しない暦パックの互換判定で、「ランの直列化形」でも「1ランの中身」でもない。
そのうえ同じ 4 フィールドの型が `save-data.ts:216-223` と `ephemeris-context.ts:8-15` に
独立して書かれ、型システム上の紐付けがない。

**`physics/ephemeris/` の中に閉じ込める。** `physics/` は物理・軌道力学そのものの層で、
セーブの互換判定を持ち込む場所ではない。**入るのは `physics/ephemeris/` の下だけ**とし、
`physics/` の他のどこにも新しい export を生やさない。判定の対象は「その元期が選ぶ暦パックが
いま手元にあるものと同じか」であって、暦パックのカタログを持っているのは
`physics/ephemeris/catalog.ts` `profile.ts` `pack-format.ts` — **この 3 つと同じ棚に置くのが
いちばん近い。** 名前も `ephemeris-context.ts` のままにして、暦の話であることを外から見えるようにする。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/save/ephemeris-context.ts` → `src/physics/ephemeris/ephemeris-context.ts` | `git mv`。import が `'./pack-format'` `'./profile'` `'../time'` になる。**冒頭コメント `:5-7` の「physics のテストビルドから DOM/Three を引かずに触れる」という制約は、移動先で自明になるので書き換える** |
| `src/physics/ephemeris/ephemeris-context.ts:8-15` | `EphemerisContextValue` を `EphemerisContext` として **export** する |
| `src/game/save/save-data.ts:216-223,289` | 重複定義を削除し、`physics/ephemeris/ephemeris-context` から `EphemerisContext` を type import する |
| `src/launcher/save/snapshot-service.ts:8` | import 元を書き換え |
| `tests/game/save-ephemeris-context.test.ts:7` → `tests/physics/` | テストを physics 層へ移す。`tests/run.ts` の層分けに従って登録し直す |
| `tsconfig.test.json` | physics のテストビルドへ含める。個別ファイル列挙方式なので `src/physics/ephemeris/ephemeris-context.ts` を足す |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -rn "epochJdTdb" src/ | grep "interface\|type "` が 1 件だけ。
- `ls src/game/save/` が `save-data.ts` の 1 件。
- `npm run test:physics` と `npm run test:game` が通る。
- `npm run dev` で、移行前に作ったスナップショットが F9 から読めることを再確認する。

---

### 手順11. `WorldSfx` / `UiSfx` を `Game` の持ち物にする

**目的.** `WorldSfx` と `UiSfx` は `game/` の 26 ファイルからしか使われず、タイトル画面では
一度も鳴らない(タイトルで要るのは `AudioEngine.unlock()` と `Bgm` だけ)。にもかかわらず
`main.ts:121-122` が作り、Launcher が 2 つのフィールドとして素通ししている。**ランの世界が出す
音はランと同じ寿命であるべき**で、そうすれば `Game.dispose()`(`game.ts:287-294`)の
「効果音はこのゲームより長生きするので継続音を元へ戻す」という後始末も要らなくなる。

**この手順は他と独立している。落としてもよい。**

**新しい API**

```ts
// src/audio/sfx/world-sfx.ts
export class WorldSfx {
  // ループ音チャンネル(噴射・RCS)を停止し、ノードを切り離す。
  dispose(): void;
}
```

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/audio/sfx/world-sfx.ts:11-12` | `thrustGain` / `rcsGain` が握る `BufferSource` を止めて切り離す `dispose()` を足す。**`loopChannel()`(:17-33)が `src.start()` した `AudioBufferSourceNode` を保持していないので、保持する形に直す** |
| `src/game/game.ts` | `worldSfx` / `uiSfx` の引数を `audioEngine: AudioEngine` 1 つに変え、`Game.create()` の中で `new WorldSfx(audioEngine)` `new UiSfx(audioEngine)` を作る。`dispose()`(:293-294)の `setThrust(false)` `setRcs(false)` を `this._worldSfx.dispose()` へ置き換える |
| `src/launcher/launcher.ts:17,18,79,80,150` | `worldSfx` / `uiSfx` のフィールドと引数を削除。`audioEngine` は既にある |
| `src/main.ts:114-127,161` | `WorldSfx` / `UiSfx` の生成と受け渡しを削除。`initHud` の戻り値からも外す |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -n "WorldSfx\|UiSfx" src/main.ts src/launcher/` が 0 件。
- `grep -c "private readonly" src/launcher/launcher.ts` が 2 減る。
- `npm run test:game` が通る。
- `npm run dev` で **音の漏れを耳で確かめる**: ①噴射しっぱなし・RCS 回しっぱなしで撃墜され、
  決着した瞬間に両方止まる、②そのまま [R] で再出撃 → 噴射音が正常に鳴る、
  ③**再出撃を 5 回繰り返し、無音のはずの場面でノイズが重なっていない**(ループチャンネルの
  取り残しがあるとここで積み上がる)、④タイトルへ戻ってから別ステージを始めても同じ、
  ⑤UI 音(時間倍率の変更・計画ノードの編集)が鳴る。

---

### 手順12. 起動時のタンパク質アセット先読みをやめ、要求された体だけを読む

**目的.** `main.ts:144` の `startProteinAssetPreload()` が、**起動のたびに 4 体ぶんの
structure/motion を 8 本の fetch で取りに行く。合計 93.6 MB。**

| アセット | サイズ |
| --- | --- |
| `atpSynthase6n2yStructure.json` | 37.2 MB |
| `atpSynthase6n2yMotion.json` | 17.6 MB |
| `rubisco8rucStructure.json` | 16.4 MB |
| `rubisco8rucMotion.json` | 8.6 MB |
| `pdb5i4rStructure.json` | 8.0 MB |
| `pdb5i4rMotion.json` | 4.1 MB |
| `myoglobin1mbnStructure.json` / `Motion.json` | 1.2 / 0.6 MB |

`fetchJson`(`protein-asset-loader.ts:39-43`)は `response.json()` なので **JSON の構文解析は
メインスレッドで走る。** そのあと `assertProteinDisplayAsset`
(`protein-display-asset.ts:53,60`)が表面とリボンの索引配列を `some()` で全走査し、
`validateProteinMotionAsset` も続く。**ローディングのゲージが固まるのはここである** — これは
`Game.create()` の経路の外で並行して走っているので、**手順8 で段を細かく報告しても直らない。**
メインスレッドが解析で止まっている間、ブラウザは何も描き直せない。

しかも**この 4 体を使うのはクリエイティブステージだけ**である
(`grep -rn "ProteinEnemy" src/game/stages/` が `creative-stage.ts` と
`spawner/enemy-generator.ts` のみ)。そこでもプレイヤーが配置したときにしか要らない。
`DynamicSystem.spawnEnemyWhenReady`(`dynamic-system.ts:155-162`)は既に「準備が整うまで
実体化を遅らせる」仕組みを持っているが、**キューに積むだけで読み込みを始めない** — 唯一の
読み込み口が起動時の先読みなので、いまはそれで成立している。**要求された体を、要求された時点で
読む形にする。**

**着手前に `DEVELOP/SPEC/PROTEIN.md`「出現」節を読み、待ち時間の見せ方が仕様に収まっているかを
確かめる。収まっていなければ `/modify-feature` を通してから書く。**

**新しい API**

```ts
// src/game/protein/protein-asset-loader.ts
// この体の取得を始める。始まっている・終わっているなら何もしない。
// 完了は isProteinAssetReady() が答える — 待ちたい側はそれを見る。
export function requestProteinAsset(id: ProteinAssetId): void;
```

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/protein/protein-asset-loader.ts:90-95` | `startProteinAssetPreload` を削除し、`requestProteinAsset` を export する(中身は既存の `loadProteinAssetBundlePromise` を投げっぱなしで呼ぶだけ) |
| `src/game/protein/protein-asset-loader.ts:88` | 「待たずに投げっぱなしにしてよい」のコメントを、要求時読み込みの説明へ書き直す |
| `src/game/dynamic/dynamic-system.ts:155-162` | `spawnEnemyWhenReady` が、まだ準備できていない `assetId` をキューへ積むときに `requestProteinAsset(assetId)` を呼ぶ。**ここを落とすと、セーブ復元経路で積まれた敵が永久に現れない** |
| `src/game/stages/creative-stage.ts:172,196` | 形状一覧を開いた時点で、並んでいる体の `requestProteinAsset` を呼ぶ。置く操作を待たずに取得を始める |
| `src/game/protein/protein-enemy-registry.ts:44` | コメント中の `startProteinAssetPreload` への言及を直す |
| `src/main.ts:17,144` | 呼び出しと import を削除 |

**達成条件と検証**

- `npm run typecheck` が通る。
- `grep -rn "startProteinAssetPreload" src/` が 0 件。
- `npm run test:game` が通る。
- `npm run dev` + DevTools の Network で ①`?stage=1` の起動時に `*Structure.json`
  `*Motion.json` の要求が **0 件**、②起動のゲージが止まらずに進む(手順8 の検証①が、
  先読みの解析に邪魔されずに通る)、③クリエイティブで形状一覧を開くと取得が始まり、
  置いた敵が取得完了後に現れる、④**タンパク質の敵を含む既存のクリエイティブのセーブを読むと、
  取得を待って敵が現れる**(永久に出てこないことがない)、⑤同じ体を 2 回置いても fetch は 1 回。

---

### 手順13. `CODING-RULE.md` 1.3 を新しい層構成へ書き直す

**目的.** `DEVELOP/CODING-RULE.md:81-93` は `math/ physics/ render/ game/ launcher/` の 5 層で
書かれている。手順2〜4 で `input/` と `hud/` が層として立つので、**どれがどれを import して
よいかを規則の側へ書く。** 書かなければ、次の変更でまた `game/` へ流れ込む。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md:81` | 見出しを `math/` / `physics/` / `render/` / `input/` / `hud/` / `game/` / `launcher/` へ |
| `DEVELOP/CODING-RULE.md:82-93` | `input/`(キーの割り当てと生の入力。`game/` `launcher/` `hud/` を import しない)と `hud/`(画面の器と共通部品。`theme` `input/` `render/` までを import してよく、`game/` `launcher/` を import しない)の 2 項を足す。`game/` `launcher/` の項へ「自分の画面のために `game/` を引かない」を書き足す |
| `DEVELOP/CODING-RULE.md` 1.3 の末尾 | 「**下位が自決できるものは下位が決める**」を小節として足す。素通しの引数(受け取って別の誰かへ渡すだけのもの)は、置き場所が間違っているサインである、と書く |

**達成条件と検証**

- 1.3 の層の並びが `src/` の実際のディレクトリと一致する(`ls -d src/*/`)。
- 手順2〜12 の達成目標 2〜5(grep が 0 件)が、規則の文面から読み取れる。

## 見積り

**手掛かり: 先行する 5 手順の実測は 27 ファイル / +227 / −217 行**
(`git diff --stat f7048b91~1..720ff639`)。移動 18 ファイルで、実質の書き換えは import と
数十行の配線に収まった。今回も**大半が import パスの機械的な書き換え**なので、同じ比で見積もる。

| 手順 | 移動/新規 | 書き換える import 行 | 実質の書き換え | 備考 |
| --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 約 11 行 | 4 ファイルの削除と CSS セレクタ |
| 2 | 1 | 25 | 0 | 純粋な移動 |
| 3 | 4 | 58 | 約 10 行 | touch.ts の import 直し |
| 4 | 30 + 3 分割 | **191**(102 ファイル) | 約 120 行 | 最大。3 件の切り分けが実質。サブエージェントへ配る |
| 5 | 2 新規 | 約 15 | 約 90 行 | `hud-root.ts` から約 20 行を `HudShell` へ、`#hud-result` の生成を `result-screen.ts` へ |
| 6 | 4 + 1 新規 | 約 35 | 約 30 行 | `PerfCounts` の切り出しと LOD 重複の解消 |
| 7 | 0 | 約 8 | 約 25 行 | `scene.ts` へ 2 生成を移し、4 ファイルから引数を削る |
| 8 | 1 新規 | 約 5 | 約 120 行 | `launcher.ts` から約 35 行が `game.ts` へ、`create()` の殻、`LoadingProgress`(約 40 行)、実測 |
| 9 | 1 移動 + 1 新規 | 約 12 | 約 110 行 | `buildSaveData`(21 行)+ メタ導出(24 行)が `game.ts` へ、`RunSummary` 型が新規 |
| 10 | 1 移動 + テスト 1 移動 | 約 4 | 約 15 行 | 重複型の削除 |
| 11 | 0 | 約 6 | 約 40 行 | `WorldSfx.dispose()` の新規実装が主 |
| 12 | 0 | 約 3 | 約 25 行 | `startProteinAssetPreload` を `requestProteinAsset` へ、呼び出し口 3 箇所 |
| 13 | 0 | 0 | 約 30 行 | 文書のみ |
| **計** | **43 移動 / 7 新規** | **約 362 行** | **約 615 行** | |

**導出**: import 行数はすべて grep の実測(手順4 は widgets 66 + utils 33 + overlay-manager 22 +
property-window 21 + breakpoints 19 + overlay-layer 7 + draggable-window 6 + layout 4 +
viewport 4 + その他 9 = 191)。実質の書き換えは、移動しないコードのうち**引数の増減・型の
切り出し・関数の移設**にあたる行を数えたもの。

**手順4 が全体の 3 分の 1 を占める。** ここだけは `game/hud/` 内部の相対 import(`'./widgets'`
`'../utils'` など)が大量に絡むので、ディレクトリ単位で分けてサブエージェントへ配る。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 手順4 で CSS の注入順が変わる。`SKELETON_STYLE` `LAYOUT_TOKENS_STYLE` はカスケードで後続のパネル CSS に上書きされる前提で書かれている | 枠線・余白・重なり順が微妙に崩れる。型検査もテストも通り、**目で見るまで分からない** | 手順4・手順5 — シェルのスタイルを先に注入し、ゲーム側を後に注入する順序を守る。手順4 の検証①〜⑥を全部見る |
| 手順4 で `windows/index.ts` を割るとき、`game/` 側の呼び手が共通バレルの方を引き続ける | 型検査は通るが、`launcher/ → game/` の依存が残ったままになり、達成目標 2 が満たされない | 手順4 — `grep -rn "game/hud/windows" src/launcher/ src/main.ts` で確認する |
| 手順5 で `#hud-result` の生成元を移したとき、CSS も一緒に移し忘れる | 結果画面が素の DOM で出る(枠も背景も無い)。決着するまで見えない | 手順5 — 検証④。`?stage=1` で自機を落として敗北させる |
| 手順6 で `FrameSections` をランごとに作り直す形にしてしまう | `PerfMeter` が握った参照が古いままになり、**再出撃後に静かに計測が止まる**(0.000 が並ぶだけで例外は出ない) | 手順6 — インスタンスは `main.ts` が持つ。`?perf=1` で [R] 再出撃してから値が出続けることを見る |
| 手順7 で `applyGraphics` から `pipeline` への押し出しを書き忘れる | 設定ビューで影の枚数・解像度を変えても効かなくなる。既定値では正しく動くので気づきにくい | 手順7 — 検証②。影の枚数を 0 と最大で切り替える |
| 手順8 で元期の解決順序(セーブ → 指定日時 → ステージ宣言)を崩す | スナップショットを読んだときに全天体がずれる。`simTime` は元期からの経過秒なので、**別の元期で組むと絵は出るが位置だけが違う** | 手順8 — 検証④⑤。クリエイティブで日時を選んだ直後と、既存スナップショットの読み込みを両方見る |
| 手順8 で `Math.random()` を呼ぶ位置が変わり、乱数の消費順が変わる | 地球の自転初期位相が起動ごとに変わるのは元からの仕様だが、**他の乱数と順序を共有していると下位の決定性が崩れる** | 手順8 — `earthSpinPhase0` の乱数は `Game.create()` の中で 1 回だけ引く。`grep -n "Math.random" src/game/game.ts` が 1 件 |
| 手順9 で `Game.serialize()` へ移すとき、`buildSaveData` が集めている `serialize()` を 1 つ落とす | そのサブシステムだけ復元されない。**保存も読み込みも例外を出さず、値が既定へ戻るだけ** | 手順9 — 検証④。移行前に撮ったスナップショットを読み、HP・弾倉・資金・敵配置・カメラ・計画が保存時と一致することを見る |
| 手順9 で `RunSummary` に `centerBodyName` を入れ忘れる | 自動命名が「MET ○○」だけになり、天体名と高度が消える。一覧の見た目が静かに劣化する | 手順9 — 検証① |
| 手順10 で `SAVE_VERSION` を動かしてしまう | `GameSaveData.version` の照合先がずれ、**既存スナップショットが全部読めなくなる。読み込みは黙って `null` を返すので「記録が消えた」ようにしか見えない** | 手順10 — `SAVE_VERSION` は `game/save/save-data.ts:227` に残す。移す型は `EphemerisContext` だけ |
| 手順11 で `WorldSfx.dispose()` がループチャンネルを止め損ねる | ランを重ねるたびに `AudioBufferSource` が残り、**無音のはずの場面でノイズが積み上がる**。1 回では気づかない | 手順11 — 検証③。再出撃を 5 回繰り返す |
| 手順8 で `LoadingProgress.enter()` の描画明け渡しを省き、`within()` だけで済ませる | ゲージの見た目は何も変わらない。**同期処理の途中で `style` を書いてもブラウザは再描画しない**ので、「進捗を細かくしたのに効かない」という結論だけが残る | 手順8 — 検証①。段の境目でゲージが実際に描き変わることを見る |
| 手順8 で `celestialSystem.build()` をコンストラクタから出したとき、`game.ts:169-174` の `setOrbitGuideSettings` / `setOnLineCountChange` より前に来る順序を崩す | 軌道ガイドの初期設定が反映されず、線が出ない・本数警告が出ない | 手順8 — `?stage=1` でマップへ入り、軌道ガイドの線と本数表示が従来どおり出ることを見る |
| 手順12 で `spawnEnemyWhenReady` の `requestProteinAsset` を書き忘れる | 唯一の読み込み口が消えるので、**タンパク質の敵を含むセーブを読むと敵が永久に現れない。**例外は出ず、静かに空のまま | 手順12 — 検証④。既存のクリエイティブのセーブを読む |
| 手順12 で先読みをやめた結果、クリエイティブで体を置いてから現れるまでが長くなる | 37 MB の体は待ちが数秒に達しうる。仕様上は「準備中は保有しない」だが、無反応に見える | 手順12 — 着手前に `SPEC/PROTEIN.md`「出現」節で待ちの見せ方を確かめる。形状一覧を開いた時点で取得を始めることで、置く操作までの時間を稼ぐ |
| ファイル移動のついでに import の並び(外部 → value → type)を崩す | 規約違反が 100 ファイル規模で増える | 手順2・3・4・6 — サブエージェントへ配るときの指示に並びの規則を明記する(`/delegate`) |
| ローカルの `npm run typecheck` が OOM で落ちる | 検証が通らず、コードの誤りと区別が付かない | 全手順 — `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck` で回す |
| `npm run render-lab:shot` が追跡ファイルを書き換える | 手順7 の確認で撮った絵が commit に混ざる | 手順7 — 撮ったあと `git status` を見て戻す |
