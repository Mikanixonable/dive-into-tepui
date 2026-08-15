# Game のライフサイクル(生成し直し)リファクタリング調査

`Game`(`src/game/game.ts`)を破棄し、同一ページ内で新しい `Game` を作り直せるようにするための
調査。`Game.dispose()`(`game.ts:224-247`)は既にあり、構築の逆順にサブシステムの `dispose()` を
呼ぶことで、`THREE.Scene`・`Hud.layers` の各層・`window`/`document`/canvas のリスナーのいずれにも
`Game` 由来の残留物を残さない。何を片付け何を共有資源として残すかの判断境界は
`DEVELOP/OWNERSHIP.md` §1-2「破棄(dispose)の連鎖」が正本であり、本文書はそれを繰り返さない。

残っているのは、この `dispose()` を実際に**使う側**の配線である。`main.ts` は `PerfMeter`/
`SaveBrowser` に構築時の `Game` インスタンスをフィールドとして持たせており、`startAnimationLoop`
の rAF ループ自身も特定の `Game` を閉じ込めたクロージャで動いている(§2)。これらを崩さない限り、
`Game` を作り直すこと自体はできても、作り直した `Game` を実際に動かす経路が無い。この状態を
解いた上で、`Launcher`(`src/launcher.ts`)の `restart`/`returnToTitle`/`loadSnapshot`/
`switchSlot` の4メソッド(`launcher.ts:113-130`)を、現状の `location.replace`/`location.assign`
(=ページ再読込)から「`game.dispose()` → `new Game(...)`」呼び出しへ置き換えるのが最終的な
目標になる(§1)。

---

## 1. 目指している仕様(未達成分)

`Launcher` の `restart`/`returnToTitle`/`loadSnapshot`/`switchSlot`(`launcher.ts:113-130`)は
いずれも `location.replace`/`location.assign` でページを再読込し、その結果として新しい
`main()` の実行が新しい `Game` を作る——という形で「`Game` を捨てて次の周回へ移る」を代行して
いる。`game/` 配下・`Game` 自身は `location.*` を一切呼ばない(`main.ts` に残る `location.*` は
致命的エラー画面の再読込ボタン(`location.reload()`、`main.ts:101`)だけ)。

目指す最終形は、この4メソッドをページ再読込から「現在の `Game` を `dispose()` し、同じ
`Hud`/`Sfx`/`PauseMenu`/`SettingsView`/`GameScene`(scene/renderer)を使い回して
`new Game(...)` を呼び直す」処理へ置き換えることである。`restart()`(現在のステージへの
再出撃)と `loadSnapshot()`(スナップショットの復元)は「同じ(または既に確定した)ステージ
クラスで `Game` を作り直す」形に素直に収まるが、`returnToTitle()` はタイトル(ステージ選択)
画面への遷移を伴うため、`stage-select.ts` を同一ページ内で出し直す設計が別途要る。
`switchSlot()`(アクティブなセーブスロットの切替)も同様に、切替後どのステージへ遷移するか
という `resolveStage()` 相当の判断を伴う(いずれも§6で扱う)。

---

## 2. main.ts が Game インスタンスを直接抱えているもの

`main()`(`main.ts:214-281`)は `let game: Game | null = null;`(`main.ts:233`)という
ミュータブルな入れ物を持ち、`pauseMenu.onPauseMenuOpenChange`(`main.ts:234-238`)と
`settingsView.onOpenChange`(`main.ts:239-243`)はこの変数を経由して `game.pause()`/
`game.resume()` を呼ぶ——`if (!game) return` で `null` を弾いた上で読むだけなので、`game` を
後から再代入しても**この2つのコールバックは配線し直さずに新しい `Game` を拾える**。
`pauseMenu.onQuitToTitle`/`onOpenSettings`、`saveBrowser.onSlotSwitched`/`onLoadSnapshot`、
`pauseMenu.onOpenSnapshots`/`onOpenPerfWindow` の残り6つのコールバックはいずれも `game` を
直接読まない(`Launcher`/`settingsView`/`saveBrowser`/`perf` という main.ts 所有の別
オブジェクトへ委譲するだけ)。

これに対し、以下は `Game` インスタンスをコンストラクタ引数で受けて**フィールドへ保存**して
おり、`game` を再代入しても追随しない:

| クラス | 保持方法 | 用途 |
|---|---|---|
| `PerfMeter`(`main.ts:273: new PerfMeter(game, hud.layers.window, gs.renderer, sections, gpu, hud.overlayManager)`) | `private readonly counts: PerfCountSource`(`perf-meter.ts:85`)としてフィールドに保存(型は狭い `PerfCountSource` インターフェースだが、渡されるのは `game` 自身) | `flush()`(`perf-meter.ts:189-205`)が `this.counts.perfCounts()` を呼ぶ |
| `SaveBrowser`(`main.ts:264: new SaveBrowser(hud.layers.system, slots, snapshotService, game, hud.overlayManager)`) | `private readonly game: Game`(`save-browser.ts:158`)としてフィールドに保存 | `open()`/`close()` が `game.pause()`/`game.resume()`(`save-browser.ts:177,186`)、`canCaptureNow()` が `game.activeStage.isPlaying`(`save-browser.ts:201`)、`handleCaptureNow()` が `service.capture(this.game, ...)`(`save-browser.ts:540`) |

加えて `startAnimationLoop`(`main.ts:134-184`)自体が、呼び出し時点の `game`(関数引数、
`main.ts:135`、呼び出しは `main.ts:280`)を閉じ込めた単一の rAF ループである。`animate` 関数
(`main.ts:141-183`)はこの引数を毎フレーム `game.update(dt)`(`main.ts:147`)等で読み、
`launcher.handleInput(game.input, game)`/`launcher.update(game)`(`main.ts:151,154`)もこれを
引数として渡すだけだが、`animate` 自身が特定の `Game` を閉じ込めているという問題は変わらない
——`const game` の再代入も、ループを張り直さず参照先だけ差し替える口も、今は存在しない。

`AutoSave`/`SnapshotControls`(`main.ts:280` で構築)は `Game` を保持せず、`update(game)`/
`handleInput(input, game)` が毎フレーム引数で受け取るだけなので、この問題と無縁である——
`PerfMeter`/`SaveBrowser` が倣うべき形。

---

## 3. 所有関係そのものを変えないと解けないもの

`Game` より**長生きする**オブジェクトが `Game` への参照を保持している場合、`Game.dispose()` を
呼ぶだけでは解決しない——参照の持ち方自体を変える必要がある。

| 対象 | 何が問題か | 解法の方向 |
|---|---|---|
| `PerfMeter.counts`(`perf-meter.ts:85`) | `Game` をコンストラクタで受けフィールドに保存。`Game` を作り直しても古い方を握り続ける | `AutoSave`/`SnapshotControls` に倣い、`counts: PerfCountSource` をフィールドから外し、`record()`/`flush()` に**引数**として渡す。`PerfMeter` 自体は main.ts 所有のまま生かせる |
| `SaveBrowser.game`(`save-browser.ts:158`) | 同上。`open()`/`close()`/`canCaptureNow()`/`handleCaptureNow()` が全部 `this.game` を読む | 同上、`game: Game` をフィールドから外し `open(game)`/`canCaptureNow(game)` 等の引数へ倒す。`open()`/`close()` は main.ts 側の各コールバックから叩かれるため、**呼び出し元(main.ts)側が常に最新の `game` を渡せる状態を保つ**必要がある(§2 の `let game` と同じ入れ物を経由させればよい) |
| `startAnimationLoop` の `animate` クロージャ(`main.ts:134-184`) | rAF ループ自体が特定の `Game` インスタンスを閉じ込めている。作り直しに対応する口が無い | §2 の `let game` と同じ入れ物を経由して `game.update(dt)` 等を呼ぶよう書き換える。ループ自体は張り直さない(二重 rAF を防ぐ) |
| `Launcher`(`launcher.ts:39-40`: `launchedStage`/`resultShown`) | `Game` への参照は持たない——`update(game)`/`handleInput(input, game)`(`launcher.ts:96-104,107-110`)は毎フレーム**引数**で受け取るだけで、フィールドには保存しない。ただし `Game` より長生きする main.ts 側オブジェクトとして、**周回をまたいで保持する状態**(どのステージを起動したか・今回の決着をもう結果画面に出したか)を持つ。`resultShown` は一度 `true` になったあとリセットする経路が無く(今はページ全体の再読込で消えるため問題にならない)、`Game` を作り直す設計になると次の周回の決着を検知できなくなる | `Game` への参照の持ち方は変える必要が無い(表の他行とは性質が異なる)。かわりに `Game` を作り直す側(main.ts)から「新しい周回が始まった」と `Launcher` へ伝える口(例: `beginRun(stageClass)` が `resultShown` をリセットしつつ `launchedStage` を更新する)を新設する必要がある——参照の持ち方ではなく、**周回境界の通知**という別種の欠落 |
| `Hud`/`Sfx`/`PauseMenu`/`SettingsView`(main.ts 所有、`Game` へ参照として渡すだけ) | これ自体は**問題ではない**(意図的な設計——タイトル画面が `Game` 構築前から `Hud`/`Sfx` を要るため)。`PauseMenu`/`SettingsView` はどちらも `Game` への参照を保持しない(コールバック経由でのみ関わる) | 対処不要 |
| `THREE.Scene`/`WebGPURenderer`(`GameScene`、main.ts 所有) | 同上、`Game` より長生きするのは意図通り。`Game.dispose()` が自分の追加物を全部 `scene.remove` すれば scene 自体は使い回せる(§1-2 の破棄の連鎖で既に成立) | 対処不要 |

---

## 4. 採らない案

- **`PerfMeter`/`SaveBrowser` を `Game` 再生成のたびに作り直す。**
  `PerfMeter` は開閉状態・累計統計・`PropertyWindow` の画面位置を、`SaveBrowser` は
  「今どのスロットを見ているか」(`viewedSlotId`)をそれぞれ保持しており、これらは
  **`Game` の生死と無関係にプレイヤーが選んだ UI 状態**である。作り直すとこれらが毎回
  初期状態に戻ってしまい、UX が悪化する。§3 の「`Game` フィールドを外して引数化する」方が、
  既存の UI 状態を保ったまま解決できる。
- **`Hud`/`Sfx`/`PauseMenu`/`SettingsView` も含めて `Game` の子として作り直す
  (main.ts 側を薄くする)。**
  タイトル(ステージ選択)画面が `Game` 構築前に `Hud`/`Sfx`/`PauseMenu`/`SettingsView` を
  要求する(`initHud`、`main.ts:193-196`)という既存の制約と正面から矛盾する。`Game` より
  前に存在すべきものを `Game` の子にはできない。

---

## 5. 残っている作業

各段で `npm run typecheck` が通り、各段が単独で意味を持つことを条件にする。

| Step | 内容 |
|---|---|
| 1 | `PerfMeter`/`SaveBrowser` から `Game` フィールドを外し、必要なメソッドへ引数として渡す形に直す(`AutoSave`/`SnapshotControls` と同型)。`main.ts` の `let game: Game \| null` を、`pauseMenu.onPauseMenuOpenChange`/`settingsView.onOpenChange` が既に経由している入れ物と同じものとして、`PerfMeter`/`SaveBrowser` の呼び出し元・`startAnimationLoop` の双方からも経由するよう書き換える |
| 2(最終) | `Launcher` の `restart`/`returnToTitle`/`loadSnapshot`/`switchSlot` の4メソッドを `location.replace`/`assign` から「`game.dispose()` → `new Game(...)`」呼び出しへ置き換える。`resultShown` をリセットしつつ `launchedStage` を更新する「周回開始の通知」を `Launcher` に新設する(§3)。`location.*` を呼ぶのは既にこの4メソッドだけに集約されているため(§1)、置き換え対象はこの4箇所のみで、`stage.ts`/`result-screen.ts` には触れない。`returnToTitle()`/`switchSlot()` は `stage-select.ts` の再利用(タイトルへ戻る経路)を伴うため、別途設計が要る(§6) |

Step 1 は挙動を変えない(main.ts 側の参照の持ち方を直すだけ)。Step 2 で初めて `location.*`
呼び出しそのものが置き換わる。

---

## 6. 判断を仰ぎたいこと

- **Step 2(reload 呼び出し箇所の置き換え)まで見据えて計画するか、Step 1 で一旦止めて様子を
  見るか。** Step 2 は `stage-select.ts` の再利用(タイトル復帰時に選択画面を同一ページ内で
  出し直す必要がある)という、今回の調査で洗っていない追加の設計判断を伴う。`switchSlot()`
  も同様に、切替後どのステージへ遷移するかという `resolveStage()` 相当の判断を伴う。
