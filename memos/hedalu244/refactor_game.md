# game.ts のリファクタリング

目標は3つ。**モジュール疎結合・`game.ts` からのロジック排除・可読性。**

`for` 文と違い `if` はゼロにはならないし、するべきでもない —
**残った `if` が「なぜ `Game` にあるのか」を全部言えることがゴール。**

---

## 判断の原則

**下位が自決できるようにフラグを持たせ、呼び出しガード不要で呼べるようにする。**
ただし**下位が責務外のことまで気にしてガードするのは責務分割の失敗**なので、それが避けがたい
ときだけ `Game` に残す。残すなら理由を言えること。

`if`(三項・`??`・`&&` を含む)は3種類に分けて扱う。

### (a) 判断の合成 — 無条件で移す

複数モジュールの値を組み合わせて**新しい判断を作っている**もの、および**他モジュールが読む値を
組み立てている**もの。`/refactor-fixed` 1節に真正面から反する。

### (b) 単純な呼び出し可否 — 受け手へ寄せる

フラグを1つ読んで呼ぶ/呼ばないを決めるだけのもの。**受け手が判定に要る値を毎フレーム引数で
受け取れるなら、受け手の先頭で早期 return させる**(`/refactor-fixed` 21bis)。
受け手が参照ごと持つのは、**フレームの流れの外**(DOM イベント)で使う場合だけ
(`/refactor-fixed` 7節) — 保持させると層の逆転(simulation → camera など)を招く。

### (c) 決着(`isPlaying`)による分岐は、まず存在意義を疑う

`/refactor-fixed` 21節のとおり、**一般形は「自機0..n隻・勝敗なし」で、攻略ステージのほうが
その特殊化**。決着後という極めて特殊な場面のためだけに立っている分岐は、移す前に消せないか見る。

---

## 残っている論点

### 1. `_isPaused || overlayManager.isInputGated()`

`Game.handlePointerInput` の冒頭で、`Game` 所有の `_isPaused` と `Hud` 所有の入力ゲートを
跨ぐ OR がポインタ入力を配るかどうかを決めている。**入力を塞ぐオーバーレイが自分でポインタを
消費すれば、この判定自体が要らなくなる。** ポーズ経路は「設定パネル/スナップショット一覧を
開いた(=オーバーレイ)」か「ドック」しかないので、両者の実効差を確認する価値はある。
ドックビューがキャンバスを覆ってポインタイベント自体を奪っているなら、`_isPaused` の側も
不要になりうる — 同じ調査で片が付く。

### 2. `if (player) touchControls?.syncModeButtons(...)`

`TouchControls` は `Player` 型から疎結合に保たれている(プリミティブ3つを受ける)ので自決できず、
艦がいないときに前の艦のモード表示が凍結して残る。**本来は仮想パッドごと畳むべきで、それは
`ViewManager.applyChrome` の側の話。**

### 3. `Game` の責務境界(CODING-RULE 1.2 / 1.10)

`game/game.ts` にオーケストレーション以外のメンバー(`setControlledBase` / `advanceSimulation` /
`handlePointerInput` / `objectName` / `viewBadgeContext` / `proteinMotionFrameSample` 等)があり、
`sync()` の中で `displayWindowManager` の解決など update 相当を呼ぶ箇所がある。横断を責務とする
モジュールへ寄せる再編が要る。

**`dispose` はここにあってよい。** 構築の逆順で配線を解くのはオーケストレーションそのもので、
1.2 の言う「実装」ではない。hook が毎回警告するのは hook 側の粒度の問題なので、直すなら hook。

### 4. `game/celestial/` の置き場

`src/celestial/` へ出す条件「`game/` を import しない」が不成立。残っている import は
`game/camera/floating-origin`・`game/camera/camera-system`・`game/camera/focus-target`・
`game/marker/marker-manager`・`game/lines/orbit-line`・`game/map/visibility-policy` の6種
(この一覧は `HEAD` 時点のスナップショット。食い違ったらコードを信じる)。
`game/const` への依存は消えた一方、マップ表示ポリシーを `game/map/` へ出したぶん
`game/map/visibility-policy` への依存が増えた(`CelestialSystem.sync` の引数型なので
`import type` 1件のみで、実行時の依存は無い)。
カメラ・マーカー・線の抽象を切るか、置き場は現状維持かの判断が要る。
