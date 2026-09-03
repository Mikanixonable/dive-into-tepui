# launcher / game の境界に残る歪みの整理

**実施済み。** `720ff639` → `3e75009e` の 17 コミットで全手順を通した。
以下は「何を・なぜ・どう決めたか」と、実機で確かめる残りの記録である。
**目的と決めたことの節に出てくる行番号は着手前(`720ff639`)のもので、いまのコードは指さない。**

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

## 達成目標 — 全項目の判定(`68f53bef` 時点で実測)

1. **達成。** `ls src/*.ts` が `main.ts` `theme.ts` の 2 件。
   `ls -d src/*/` が `assets/ audio/ game/ hud/ input/ launcher/ math/ physics/ render/ types/`。
2. **条件付きで達成。** `game/theme` `game/input` は 0 件。残る 4 件はすべて
   `game/hud/hud` の **`Hud` 型**(`launcher.ts` `snapshot-controls.ts` `unlock-manager.ts`
   `main.ts`)で、これは「決めたこと」で残すと決めたもの — `Hud` は `new Game(...)` へ渡す
   構築依存であり、`hint()`/`toast()` はラン中のメッセージ表示。**自分の画面を組むための
   参照は 0 件になった。**
3. **未達。** `src/hud/` `src/input/` は 0 件だが、`src/render/` に **12 件**残る —
   `render/cloud/*` が `game/celestial/solar-system/constants` の `R_EARTH` `SIDEREAL_DAY` を
   引く 4 件と、`render/protein-*` が `game/protein/` の型を引く 8 件。
   **どちらもこの整理の前から在り、launcher/game の境界とは別の軸。** `title-scene.ts` の
   `game/theme` 参照は消えた。→ **残る仕事**(下の節)。
4. **達成。** `grep -rn "launcher/" src/game/ src/hud/ src/input/ src/render/ src/physics/ src/math/ src/audio/`
   が 0 件。
5. **達成。** `grep -rn "location\." src/game/ src/hud/ src/input/` が 0 件。
6. **達成。** `grep -c "private readonly" src/launcher/launcher.ts` が 12(引数 11 +
   `resultScreen`)。素通しだった `pipeline` `worldSfx` `uiSfx` が消え、`shell` が1つ増えた。
7. **達成。** `launcher.ts` に `createCelestialSystem` `earthSpinPhase0` `Math.random` が 0 件。
   星系の構築は `Game.create()` にだけある。
8. **達成。** `snapshot-service.ts` の `game.player.` `game.dynamicSystem.` `game.activeStage.`
   が 0 件。`game.runSummary()` と `game.serialize()` の 2 呼び出しに畳まれた。
9. **達成。** `ProteinMotionLod` の定義は `protein-motion-controller.ts:11` の 1 箇所、
   `EphemerisContext` の定義は `physics/ephemeris/ephemeris-context.ts:7` の 1 箇所。
10. **達成。** `importSlotFromFile` は `save-transfer.ts` の中だけ。
11. **達成。** `?stage=1` の起動でゲージが 0% → 45 → 62 → 72 → 83% と描き変わる(headless 実測)。
    `startProteinAssetPreload` は 0 件で、`?stage=1` の起動時のアセット要求は
    **8 件 → 0 件**(`?stage=creative` では従来どおり 8 件)。
12. **達成。** `CODING-RULE.md` 1.3 が 7 層で書かれ、`ephemeris-context` は
    `physics/ephemeris/` の中だけにある。
13. **達成。** `npm run typecheck` / `npm run test`(674/674)/ `npm run build` が通る。
14. **実機での確認待ち。** 下の「残った目視確認」。

## 残る仕事(この整理では扱わなかった)

- **`render/` → `game/` の import 12 件。** `render/cloud/*` が `R_EARTH` `SIDEREAL_DAY` を、
  `render/protein-*` が `game/protein/` の型を引く。**この整理の前から在り、別の軸。**
  前者は「天体の寸法を誰が持つか」、後者は「タンパク質の表示形式を誰が持つか」の問題。
- **ローディング表示を畳んだあとの最初のフレームで約 2.7 秒止まる**(headless 実測)。
  WGSL のコンパイルとパイプラインの構築で、ローディングの段とは別の区間。
  畳む前に `renderer.compileAsync()` で温めるなどの手当てが要る。
- **`launcher/save/` にテストが 1 本も無い。** `SaveSlots`(365 行、剪定・容量超過リトライ・
  入出力の整合性を持つ)も `checkSlotExportShape` も無検証。`GameSaveData` を型でしか触らず
  `localStorage` も `SaveStore` 越しなので、Node-only のテストビルドに載せられる。

## 実施済み

| 手順 | commit |
| --- | --- |
| 1. HUD ウィンドウからタイトル画面の知識を落とす | `6f5ec302` |
| 2. `theme.ts` を `src/` 直下へ移す | `a1fe33f1` |
| 3. `input/` を `src/` 直下へ、`TouchControls` を `game/hud/` へ | `f0c12eaa` |
| 4. `src/hud/` を作り、共有の画面部品を移す | `50831e04` |
| 5. 画面の器を `HudShell` として切り出す | `9165c170` |
| 6. `src/` 直下の残り 4 モジュールを層へ配る | `dd935999` |
| 7. `RenderPipeline` / `GpuTimings` を `GameScene` の持ち物にする | `af7cbd4d` |
| 8. 星系の構築を `Game.create()` へ、起動の進捗を段で報告する | `a25463f8` |
| 9. ランの直列化と要約を `Game` の仕事にする | `102d2926` |
| 10. 暦packの互換判定を `physics/ephemeris/` へ移す | `f896ca49` |
| 11. 効果音をランの持ち物にする | `d4e5f6a0` |
| 12. タンパク質アセットを要求された時点で読む | `9de275ee` |
| 13. `CODING-RULE.md` 1.3 を 7 層へ書き直す | `68f53bef` |
| — `/refactor` の是正(`runSummaryOf` → `summarizeRun`) | `def6e682` |
| — `serialize` / `runSummary` を `Game` のメソッドへ戻す | `7c70522c` |

**計画どおりに戻した点(手順11 → `7c70522c`)。** `Game.serialize()` / `Game.runSummary()` を
メソッドとして足したとき、境界フックが CODING-RULE 1.2 を指摘したのでいったん
`serializeRun(game)` / `summarizeRun(game)` へ外へ出した。**これは誤り。**
**サブシステムを持っているのは `Game` なので、何を持っているかを知って畳めるのも `Game` だけ**で、
`dispose()` と同じ形である。外へ出すと、畳むために中身を公開し続ける前提が固定されてしまう。
メソッドへ戻し、`run-summary.ts` は要約の形(`RunSummary`)だけを持つ型モジュールにした。

> **境界フックの許可リストは当てにしない。** `.claude/hooks/check-boundaries.mjs` の
> `GAME_ALLOWED_MEMBERS` には `dispose` すら載っておらず、`advanceSimulation`
> `handlePointerInput` `proteinMotionFrameSample` も併せて誤報する。
> **持ち主が自分のサブシステムを畳む/組む/数えるメンバーは、Game に置いてよい。**

**`/refactor` で見つけて直さなかったもの。** `game.ts` が 591 行(着手前 560 行)で 1.2 の
500 行基準を超える。1.2 の診断に従うと「同じ関心の実装が単に多い」— サブシステムの生成・配線と
毎フレームの呼び出し順で、分ける線が無い。手順11 で `serialize`/`runSummary` を外へ出した
ぶんは既に減っている。`launcher/stage-select.ts` の 554 行も同様(大半が CSS のテンプレート)で、
どちらもこの整理の前から在る。

**計画から外れた点(手順8)。** 段は 4 つでなく **3 つ**にした。実測(headless Chrome /
localhost 配信 / `?stage=1`)は 暦packの受信 501ms・展開 357ms・天体運動の構築 122ms・
天体の実体化 156ms・ランの組み立て 233ms。受信と展開の間で描画を明け渡すには
`physics/ephemeris/catalog.ts` の `loadEphemerisPoints` を2つへ割り、フレームの都合を
`physics/` へ持ち込む必要がある。**`physics/` を汚さない方を採り**、受信〜天体運動の構築を
`system` の1段にまとめた。残る無反応の最大区間は 868ms → 479ms。

**手順8 で分かったこと(この計画では扱わない)。** ローディング表示を畳んだ**あと**、
最初のフレームで **約 2.7 秒**メインスレッドが止まる(headless 実測)。WGSL の
コンパイルとパイプラインの構築で、ローディングの段とは別の区間。畳む前に
`renderer.compileAsync()` で温めるなどの手当てが要る。

**計画から外れた点(手順5)。** 2 つ。

- **`Hud` は `root` / `layers` / `overlayManager` を捨てず、`shell` を返す getter として残した。**
  捨てると `game/` の 20 箇所が `hud.shell.layers.popup` になる。器のレイヤはゲームの HUD の
  レイヤでもあるので、ゲーム側の呼び出しは変えない。保持はしないので正本は器の側だけにある。
- **`HudShell` は CSS を注入しない。** 器のぶんだけを切り出すには `skeleton-style.ts`
  (`#hud` の骨格とゲームのレール/バッジが同居)と `layout-tokens.ts` を割る必要があり、
  カスケードの順序を崩す risk に見合わない。スタイルシートはいまどおり `hud-root.ts` が
  1 枚にまとめて注入する。**共有部品だけを載せる画面が現れたときに割る。**

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
4. **(手順4)** CSS の欠落を目で見る。①ゲーム中 HUD の左右レール・上部バー、②ESC メニュー、
   ③設定ビューの 3 タブ(配色・描画・BGM)、④F9 のセーブブラウザ、⑤負荷確認ウィンドウ
   (`?perf=1`)、⑥タイトル画面、⑦**決着後の結果画面**(CSS の注入元が `ResultScreen` へ移った)、
   ⑧ステージ状態表示(画面下中央)。いずれも枠線・余白・配置が従来どおりであること。
5. **(手順5)** 重なり順を目で見る。①ゲーム中に軌道解析ウィンドウを開き、その上へ ESC メニューが
   出る、②ESC メニューを開いている間、背後の HUD がクリックを受けない、③F9 のセーブブラウザが
   ESC メニューと同じ帯に出て、開くと ESC メニューが閉じる、④決着後の結果画面が全ての窓より
   前に出る、⑤トーストが結果画面より手前に出ない、⑥タイトル画面(`?title=1`)で ESC メニューが
   選択画面の上に出る。
6. **(手順7)** ①通常の描画(地球・大気・影・太陽)が従来どおり、②設定ビューの描画タブで
   影の枚数・解像度倍率を変えると即座に反映される、③`?perf=1` の GPU パス行に値が出る、
   ④負荷確認ウィンドウの「デバッグ表示」で G-Buffer などへ切り替わる。
7. **(手順8)** ①`?stage=1` の起動でゲージが 0% → 45 → 62 → 72 → 83% と描き変わる
   (headless では確認済み)、②[R] の再出撃でも同じ、③クリエイティブで開始日時を選ぶと
   **その日時**で始まる、④既存のスナップショットを F9 から読むと天体配置が保存時と一致する。
8. **(手順9・手順10)** ①F5 で手動スナップショットを撮り、F9 の一覧に
   「MET ○○ ・ 地球 高度 ○○」の自動命名で出る、②同じ行の高度・速度・HP・弾倉・資金・敵数が
   HUD の表示と一致する、③自動スナップショットも同じ形で溜まる、
   ④**移行前に撮ったスナップショットが従来どおり読める**(HP・弾倉・資金・敵配置・カメラ・
   計画が保存時と一致する)、⑤スロットの書き出しと取り込みが通る。
9. **(手順11)** 音の漏れを耳で確かめる。①噴射しっぱなし・RCS 回しっぱなしで撃墜され、決着した
   瞬間に両方止まる、②そのまま [R] で再出撃 → 噴射音が正常に鳴る、③**再出撃を 5 回繰り返し、
   無音のはずの場面でノイズが重なっていない**(ループ音の取り残しがあるとここで積み上がる)、
   ④タイトルへ戻ってから別ステージを始めても同じ、⑤UI 音(時間倍率の変更・計画ノードの編集)が鳴る。
10. **(手順12)** ①クリエイティブの形状一覧を開くと取得が始まり、置いた敵が取得完了後に現れる、
    ②**タンパク質の敵を含む既存のクリエイティブのセーブを読むと、待って敵が現れる**
    (永久に出てこないことがない)、③同じ体を 2 回置いても fetch は 1 回。
    ④**LAN の IP で実機から開いたときも同じ**(headless / localhost では確かめられない経路)。

## 実測(見積りの置き換え)

**合計 202 ファイル / +1,444 / −661 行**(`git diff --shortstat 720ff639..HEAD`)。
移動が 44 ファイル、新規が 10 ファイル。

| 手順 | files | +行 | −行 |
| --- | --- | --- | --- |
| 1. タイトル画面の知識を落とす | 4 | 4 | 10 |
| 2. `theme.ts` を `src/` へ | 25 | 24 | 24 |
| 3. `input/` を `src/` へ | 38 | 59 | 59 |
| 4. `src/hud/` を作る | **134** | **1027** | **282** |
| 5. `HudShell` を切り出す | 8 | 77 | 114 |
| 6. `src/` 直下を層へ配る | 29 | 88 | 134 |
| 7. `GameScene` へ畳む | 4 | 26 | 23 |
| 8. `Game.create()` と進捗の段 | 3 | 91 | 39 |
| 9. 直列化と要約を `Game` へ | 10 | 109 | 65 |
| 10. `ephemeris-context` を `physics/` へ | 6 | 15 | 26 |
| 11. 効果音をランの持ち物に | 7 | 92 | 81 |
| 12. タンパク質の要求時読み込み | 7 | 21 | 19 |
| 13. `CODING-RULE.md` 1.3 | 1 | 28 | 2 |

**見積りとの差。** 手順4 は見積り「191 import 行 / 実質 120 行」に対し実測 +1027 −282 —
git のリネーム検出が効かなかった移動が本文ごと計上されているためで、実際の書き換えは
見積りどおり import と 3 件の切り分けに収まった。手順9・11 は見積りを超えた(それぞれ
+110 → +109 だが、`Game` から `serialize`/`runSummary` を外へ出す判断が後から入った)。

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
