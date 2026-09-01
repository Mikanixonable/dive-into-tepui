# 軌道分析パネル 実装計画

対象コミット: 0079b4e2

## 1. 目的

Orbit パネル(戦闘ビュー左レールの常設パネル `#hud-orbit`)から開ける **軌道分析パネル**を新設し、
いま数値でしか読めない未来の軌道を、**時間軸のグラフ**として読めるようにする。

持たせる面(タブ)は2つ。

| タブ | 縦軸 | 横軸 | 出せる条件 |
| --- | --- | --- | --- |
| 高度 | 操作対象の高度(既定 1000 km 幅) | 現在時刻からの経過時間(既定 10 時間) | 常に |
| 接近 | ターゲットを原点とした相対高度(既定 1000 km 幅) | 位相差を「ターゲットと同じ周期の真円軌道」へ換算した水平距離 | ターゲットがあり、かつ操作対象と**同じ天体を周回している**とき |

パネル自身の性質: 右上に閉じるボタン、ヘッダのドラッグで移動、**開いた時点でクリップ済み**
(ESC・外側クリックで閉じない)。

---

## 2. 調査で分かったこと(この計画の前提)

### 2.1 使える既存実装 — 新規に書くものはほとんど無い

| 要るもの | 既存 | 判定 |
| --- | --- | --- |
| 将来時刻の状態 | `DynamicTrajectory.extrapolatedAt(t, centerStateAtT)`(`src/physics/dynamic-trajectory.ts:112`)。艦からは `entity.predicted`(`src/game/dynamic/dynamic-entity/dynamic-entity.ts:134`)で辿る | **そのまま呼ぶ。伝播コードを新規に書かない** |
| 中心天体の将来位置 | `ephemeris.stateOf(id, t)`。`src/game/trajectory-line.ts:54` `extrapolatedTailStates()` が「相対外挿+中心を足し戻す」の見本 | 同じ形を踏襲 |
| 高度の定義 | `orbitInfo()`(`src/game/hud/orbit-info.ts:25`)の `len(rel.r) - attractor.radius` | 時間軸へ拡張して再利用 |
| 主天体の決定 | `strongestAttractor(r, celestialBodies)`(`src/physics/celestial-body.ts:103`) | そのまま |
| 「同じ天体を周回しているか」 | `relativeInfo()`(`orbit-info.ts:50`)が `selfCenter.id === otherCenter.id` で既に判定済み | 同じ式を使う(重複実装にしない) |
| 軌道周期・位相 | `OrbitalElements.period` / `pHat` / `hHat`(`src/physics/elements.ts`) | そのまま |
| 操作対象 | `game.activeControllableEntity`(`orbit-panel.ts:39` で使用中) | そのまま |
| ターゲット | `NavTarget`(`src/game/nav-target.ts`)が正本。`resolveState()` が `{id, state, hasMass, attractor}` を返す | そのまま |
| タブ切替 | `TabBar<T>`(`src/game/hud/widgets/tab-bar.ts`)。`save-browser.ts:234,361` に使用例 | そのまま |
| 閉じるボタン | `CloseButton`(`widgets/close-button.ts`)。唯一の実装 | そのまま(見た目は §7-A) |
| スケール手入力 | `ValueInput`(`widgets/value-input.ts`)。Enter=確定/Esc=破棄/blur=確定 | そのまま |
| ドラッグ+クリップ+ヘッダ | `PropertyWindow`(`src/game/hud/property-window.ts`)に**ベタ書き**。共通ヘルパーは無い | **切り出す**(§3.1) |
| 折れ線・軸・目盛の描画 | **無い。** HUD に2Dグラフの前例はゼロ | 新規(§3.3) |
| 目盛り間隔の選定 | `chooseTickInterval(durationSec, maxTicks)`(`src/game/hud/tick-scale.ts:24`) | 横軸に再利用 |

### 2.2 仕様(SPEC)との衝突が1件ある

`DEVELOP/SPEC/UI-DESIGN.md` §3 は明示的にこう書いている:

> 「クリップ」はこの状態語彙に含まれない、**プロパティウィンドウ(§4)だけが持つ固有の状態**。
> ピン留めが要る対象はプロパティウィンドウだけであり、**他の部品へこの概念を広げない**。

要求「軌道分析パネルは既定でクリップ状態」はこれに真正面から抵触する。
**コードより先に SPEC を直す**(`/modify-feature` の手順)。この計画では §7-B の案を採る前提で書く。

なお実装側には既に「クリップ相当の常設ウィンドウ」の前例がある —
`PropertyWindow` に `tempWindowGroup` を渡さないと ESC・外側クリックのどちらでも閉じない
常設ウィンドウになる(`property-window.ts:280-291`)。負荷確認ウィンドウ(`src/perf-meter.ts:132`)が
その使い方をしている。**仕様文だけが実装より狭い。**

### 2.3 予測の打ち切り(ORBIT.md)

`DEVELOP/SPEC/ORBIT.md`「未来予測の精度と打ち切り」より、この計画に効くもの:

- 艦の未来予測は積分先端より先を二体ケプラーで外挿して答える。
- **離心率 0.98 以上・双曲線/放物線・中心天体が質量を持たない場合は外挿できない。** その場合
  `extrapolatedAt` は `null` を返す。
- 予測は地表到達で打ち切られる。

→ **グラフは最初に `null` が返った時刻で線を止める。** 外挿できない区間を 0 や NaN で埋めない。

---

## 3. 設計

### 3.1 `PropertyWindow` からドラッグ可能ウィンドウの外枠を切り出す

`/modify-feature` の2軸判定: ドラッグ・クリップ・ヘッダ・ビューポート再クランプ・
`OverlayManager` 登録は「再利用可能な形になっていない ✗ / 置き場は適切 ○」→ **同モジュール群の中で
関数(クラス)として切り出し、既存の処理をその呼び出しに置き換える。**

`src/game/hud/draggable-window.ts` を新設し、`PropertyWindow` から次だけを移す。

```ts
// ヘッダ(タイトル・サブタイトル・追加ボタン枠・📌・✕)+ ドラッグ移動 + クリップ状態 +
// OverlayManager への登録/宣言更新 + ビューポート変化への再クランプ。
// 本文に何を置くかは呼び出し側の責務 — このクラスは body 要素を貸すだけ。
export class DraggableWindow {
  readonly body: HTMLElement;
  get clipped(): boolean;
  setClipped(v: boolean): void;
  moveTo(x: number, y: number): void;
  bringToFront(): void;
  dispose(): void;
  onClose: (() => void) | null;
  onClipChange: ((clipped: boolean) => void) | null;
}
```

- 移す実体: `property-window.ts` の `168-171`(ドラッグ状態)、`524-551`(pointer ハンドラ)、
  `223-234`(📌/✕ の組み立て)、`280-291`(`currentSpec`)、`485-490`(`setClipped`)、
  `onResize`/`onViewportChange` の購読。
- **`PropertyWindow` は行(rows)と操作項目(items)の担当に痩せ、外枠は `DraggableWindow` を持つ。**
  外から見た `PropertyWindow` の API は変えない — `map-context-actions.ts:152` と
  `perf-meter.ts:132` の呼び出しは無改造で通る。
- CSS も `prop-window-*` のうち外枠ぶん(`.prop-window` / `-header` / `-title*` / `-btn`)を
  `draggable-window.ts` の `STYLE` へ移し、クラス名を `dg-window-*` へ改める。
  コンパクト幅のボトムシート化(`property-window.ts:26-34`)もここへ移る — 軌道分析パネルも
  同じ扱いにする(タッチ第一級、UI-DESIGN §6)。
- 新しい状態語彙を作らない。クリップの表現は既存の `.clipped` クラスをそのまま使う。

**この切り出しを先にやる理由**: やらないとドラッグ実装が2箇所になる。CODING-RULE の重複実装禁止に
反するうえ、ビューポート再クランプのような後から効く修正が片方だけに入る。

### 3.2 `OrbitAnalysisWindow` — パネル本体

`src/game/hud/orbit-analysis-window.ts` を新設。

```
DraggableWindow(title: '軌道分析', clipped: true, tempWindowGroup: 未指定)
└ body
  ├ TabBar<AnalysisTab>            'altitude' | 'approach'
  ├ <canvas class="orbit-chart">   §3.3
  └ スケール操作行
     ├ ValueInput(number, 縦軸 [km])   既定 1000
     └ ValueInput(number, 横軸)        高度タブ: [h] 既定 10 / 接近タブ: [km] 既定は §3.5
```

- **開閉の管理は `OverlayManager` 経由**(UI-DESIGN §4・§7-2)。`document`/`window` に自前で
  `keydown`/`pointerdown` を張らない。
- 同時に1枚。既に開いている状態でボタンを押したら**最前面へ持ち上げるだけ**にする
  (もう1枚開かない — 一責務一 UI)。
- **開いた時点でクリップ済み**。📌 を外すと一時ウィンドウの排他枠(`'prop'` と同じグループ)に
  入り、ESC・外側クリックで閉じるようになる。
- `sync(game, celestialBodies)` を持ち、`CombatHudController.sync()`
  (`src/game/hud/view-hud-controller.ts:10`)から呼ばれる。**間引きは既存踏襲**で、ただし
  `OrbitPanel` の 100 ms より粗い `SYNC_INTERVAL_MS = 250`(理由は §6 の見積り)。
- タブの出し入れ: 毎 sync で接近タブの可否を判定し `TabBar.setItems()` を呼ぶ
  (同じ内容なら組み直さない実装済み)。**接近タブを選んでいる最中に条件が崩れたら高度タブへ落とす** —
  「選べてから拒否されない」既定に合わせる。
- 操作対象が居ないとき(`activeControllableEntity === null`)は本文を空表示にする。
  **窓は閉じない** — 表示/非表示とプレイヤーの選択は別軸(UI-DESIGN §5)。

### 3.3 グラフ描画 — canvas 2D

前例が無いので方式を決める。**canvas 2D を採る。**

- 点数は 150〜300、再描画は 250 ms ごと。SVG だと毎回 `<path>` の `d` を組み直すことになり
  文字列生成が支配的になる。canvas なら軸・目盛・折れ線を1パスで描ける。
- 解像度は `devicePixelRatio` を掛けたバッキングストアで持ち、CSS 側は幅 100 % ×
  固定アスペクト。`onViewportChange` でサイズを取り直す。
- **色は `src/game/theme.ts` の TypeScript 側トークン定数を直接読む**(`TEXT_DIM`, `ACCENT`,
  `EDGE` など)。canvas にカスタムプロパティは届かないので、これは CODING-RULE 1.13 が
  認めている経路そのもの。**リテラルの色を書かない。**
- 描くもの: 枠と軸、横軸目盛(`chooseTickInterval` の間隔+`fmtDuration`)、縦軸目盛
  (指定幅を等分)、折れ線1本、現在位置(t=0)の点。
- 描画そのものは `src/game/hud/orbit-chart.ts` に、**データを持たない純粋な描き手**として置く
  (`draw(ctx, {points, xRange, yRange, xTickLabel, yTickLabel})`)。2つのタブは同じ描き手へ
  違う点列と違う軸ラベルを渡すだけにする。

### 3.4 高度タブのデータ

```
center      = orbitReference.resolve(...) の attractor  ← Orbit パネルの基準選択に追従させる
t_i         = now + i * span / N            (i = 0..N)
state_i     = entity.predicted.extrapolatedAt(t_i, ephemeris.stateOf(center.id, t_i))
alt_i       = len(state_i.r - centerState_i.r) - center.radius
```

- `state_i` が `null` になった時点で打ち切る(§2.3)。
- `center` は **Orbit パネルの基準セグメントコントロール(auto/地球/月/航法ターゲット)に従う** —
  同じ画面に基準の異なる高度が2つ出ると読み違える。基準が重力中心でない(`attractor === null`)
  ときは高度が定義できないので、その旨を本文に出して線を描かない。
- 縦軸の中心: 既定は**現在高度を中心に指定幅**。線が幅から外れたぶんはクリップする
  (自動スケールにしない — 目盛の意味が毎フレーム変わると読めない)。

### 3.5 接近タブのデータ

ターゲットと操作対象が同じ主天体 `C` を周回しているときだけ有効。

```
T_tgt   = ターゲットの軌道要素の period
r_circ  = (mu_C * T_tgt^2 / (4*pi^2))^(1/3)        ← T_tgt を持つ真円軌道の半径
theta_i = ship_i と target_i の、C まわりの符号付き位相差 [rad]
          (符号はターゲットの hHat まわり、範囲 (-pi, pi])
x_i     = r_circ * theta_i                          ← 水平距離 [m]。正 = 前方
y_i     = alt_ship_i - alt_target_i                 ← 相対高度 [m]
```

- ターゲット側も**同じ経路で伝播する**。ターゲットが艦・基地なら `predicted` を持つのでそれを、
  天体なら `ephemeris.stateOf` を使う。
- ターゲットが質量を持たない対象(ラグランジュ点など)や、`period` が求まらない
  (双曲線・要素が解けない)ときは接近タブを**出さない**。
- 面外成分は捨てる(位相差は C まわりの角度だけを見る)。**相対傾斜角が大きいと
  「水平距離 0」でも実際には離れている** — これは接近タブが答える問いの外なので、
  相対傾斜角は既存の `relativeInfo().relIncDeg` を数値としてパネル内に1行で併記する。
- 横軸の既定幅は 1000 km(縦軸と同じ)。時間軸ではないので `chooseTickInterval` は使わず、
  距離用の目盛りラダーを `orbit-chart.ts` 側に持つ。

### 3.6 Orbit パネルへのボタン追加

- `src/game/hud/hud-root.ts:199-215` の `orbit.body.innerHTML` の末尾へ
  `<div class="orbit-actions" data-id="orbit-actions" role="group" aria-label="軌道の操作"></div>` を足す。
- ボタンの生成とクリックは `OrbitPanel` のコンストラクタ(`orbit-panel.ts:28-33`)側へ。
  `VesselPanel.buildActionButtons()`(`vessel-panel.ts:37-48`)と同じ形にする。
- ラベル「軌道分析」。**キー割り当ては付けない**(§7-C)。

---

## 4. 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `DEVELOP/SPEC/UI-DESIGN.md` | §3 クリップの帰属を書き換え / §8 に軌道分析パネルを追加 / §8 軌道情報パネルへ操作ボタンの記述を追加 |
| `DEVELOP/SPEC/ORBIT.md` | 高度・接近の両プロットが何を描き、どこで打ち切るかを追加 |
| `src/game/hud/draggable-window.ts` | **新設。** `PropertyWindow` から外枠を切り出す |
| `src/game/hud/property-window.ts` | 外枠を `DraggableWindow` へ委譲。外部 API は不変 |
| `src/game/hud/orbit-analysis-window.ts` | **新設。** タブ・スケール入力・sync |
| `src/game/hud/orbit-chart.ts` | **新設。** canvas への描き手(状態を持たない) |
| `src/game/hud/orbit-analysis-data.ts` | **新設。** 高度・接近の点列を作る。伝播は既存関数を呼ぶだけ |
| `src/game/hud/hud-root.ts` | Orbit パネル本文に操作行を追加 |
| `src/game/hud/orbit-panel.ts` | 「軌道分析」ボタンの生成と開閉 |
| `src/game/hud/hud.ts` | `OrbitAnalysisWindow` の保持 |
| `src/game/hud/view-hud-controller.ts` | `sync` の配線 |

**触らない**: `src/game/display-window-manager.ts`(マップの未来表示時間窓。名前が似ているだけの別概念)、
`src/physics/` 一式(伝播は既存で足りる → `npm run test:physics` は不要)。

---

## 5. 達成目標

1. 戦闘ビューの Orbit パネルに「軌道分析」ボタンが出て、押すと軌道分析パネルが開く。
2. 開いた直後から 📌 が点灯しており、ESC でも外側クリックでも閉じない。📌 を外すと ESC で閉じる。
3. ヘッダをドラッグして動かせる。画面回転・リサイズで画面外へ出ない。
4. コンパクト幅(700 px 未満)ではボトムシートとして開き、タッチだけで開閉・タブ切替・
   スケール入力ができる。
5. 高度タブ: 地球低軌道の円軌道で、高度の線が周期に応じて波打つ。既定の目盛は縦 1000 km /
   横 10 時間。
6. 縦軸に `500`、横軸に `2` を入力して Enter を押すと、そのスケールで描き直される。
   Escape なら元に戻る。入力欄に `w` と打っても機体が噴射しない。
7. ターゲットが無い / 別の天体を周回している間は、接近タブが**出ない**。接近タブを見ている
   最中にターゲットを外すと、高度タブへ落ちる。
8. 接近タブ: 同じ円軌道上でターゲットのわずかに後方を飛ぶとき、線が原点付近を通り、
   水平距離の符号が前後で反転する。
9. 予測が外挿できない軌道(離心率 0.98 以上・双曲線)では、線が途中で止まる。
   0 へ落ちたり NaN で消えたりしない。
10. `npm run typecheck` が通る。既存のプロパティウィンドウ(右クリック)と負荷ウィンドウ(F3)の
    ドラッグ・クリップ・✕ が切り出し前と同じに動く。
11. `grep -rn 'prop-window' src/` の結果が、行・操作項目まわりだけになっている。

---

## 6. 手順

各ステップは独立に commit できる。**Step 0 の合意が取れるまでコードを書かない。**

0. **§7 の要判断を確定し、`DEVELOP/SPEC/` を更新する。** ここでユーザーと合意する。
   完了条件: UI-DESIGN.md §3 の「クリップはプロパティウィンドウ固有」の矛盾が残っていない。
1. **`DraggableWindow` を切り出す。** 機能追加はしない、純粋なリファクタリング。
   完了条件: typecheck が通り、達成目標 10・11。着手前に `/ui-design` を通す。
2. **`orbit-chart.ts` を書く。** 軸・目盛・折れ線だけ。ダミーの点列で見た目を確認する。
   完了条件: canvas がテーマ色で描かれ、DPR を掛けても滲まない。
3. **`orbit-analysis-data.ts` を書く。** 高度タブの点列のみ。打ち切り判定込み。
   完了条件: 外挿不能な軌道で列が途中で終わる。
4. **`OrbitAnalysisWindow` を組み、Orbit パネルへボタンを足す。** タブは高度のみ。
   完了条件: 達成目標 1〜6。
5. **接近タブを足す。** 位相差→水平距離の換算と、タブの出し入れ。
   完了条件: 達成目標 7・8。
6. **仕上げ。** `/comment-cleanup` を新規・改変箇所へ通し、`/refactor` で CODING-RULE を当て、
   `npm run typecheck`。実行時確認が要るなら `/verify`。

サブエージェントへ配れるのは **Step 2 と Step 3**(互いに独立で、触るファイルが重ならない)。
Step 1 は `PropertyWindow` の全域に触るので配らない。

## 7. 要判断 — ユーザーに問うこと

**A. 「丸い閉じるボタン」の扱い。** 既存の `CloseButton` は 20 px の**角丸矩形**で、
プロパティウィンドウ・格納庫・セーブブラウザ・設定の4窓が同じ見た目を共有している
(`property-window.ts:228` に「他の3窓と同じ見た目に統一する」と明記)。要求どおり真円にするなら:

- (A-1) **軌道分析パネルだけ真円にする** → 4窓と見た目が割れる。UI-DESIGN §3「閉じるボタンは
  専用の1実装だけを持つ」の趣旨に反する。
- (A-2) **`CloseButton` 全体を真円にする** → 全窓の見た目が変わる。一貫性は保たれる。
- (A-3) **既存のまま(角丸矩形)にする** ← 推奨。「右上の閉じるボタン」という要求の本体は
  位置と役割であり、既存が既にそれを満たしている。

**B. クリップ概念をどこまで広げるか。** UI-DESIGN §3 の書き換え方:

- (B-1) 「クリップは**ドラッグ可能ウィンドウ**が持つ固有の状態」へ一般化する ← 推奨。
  実装(`tempWindowGroup` 省略で常設化)は既にこの形になっており、仕様文だけが狭い。
- (B-2) 軌道分析パネルをプロパティウィンドウの一種として位置づける → 「対象を右クリックして開く」
  という §4 の役割定義と食い違う(これはボタンから開く分析画面で、対象のプロパティではない)。

**C. キー割り当て。** 「軌道分析」ボタンにキーを与えるか。UI-DESIGN §8 は艦ステータスパネルの
操作ボタンを「いずれもキー割り当て済み」と書いており、既存に倣うならキーが要る。
現状の推奨は**割り当てない**(空きキーの消費に見合う頻度の操作ではない)。

**D. 接近タブの縦軸。** 「ターゲットの座標を原点として、縦軸が高度」を
**相対高度(自機高度 − ターゲット高度)** と読んだ。ターゲットの高度によらず線が原点付近を通る
読み方。**絶対高度**を描いて原点線だけターゲット高度に置く読み方もありうる。

**E. 高度タブの基準。** Orbit パネルの基準選択(自動/地球/月/航法ターゲット)に追従させる前提で
書いた。分析パネル側に独立した基準選択を持たせる案もあるが、一責務一 UI から追従を推す。

## 8. 見積り

**サンプリング負荷**(1回の再描画あたり):

- `extrapolatedRelativeState` は毎回ケプラー方程式を解く(反復 ≒ 10 回、三角関数を数回)。
  ≒ 1 µs/点。
- `CelestialMotion.stateAt` は天体1体の評価。≒ 1 µs/点(登録天体1つぶん)。
- 高度タブ = 200 点 × 2 µs ≒ **0.4 ms**。接近タブ = 双方ぶんで **0.8 ms**。
- canvas の描画は 200 セグメントの `lineTo` + 目盛 20 本 ≒ 0.1 ms。

250 ms 間引きなら 1 フレームあたり平均 **0.004 ms 未満**、瞬間値でも 0.9 ms(16.7 ms の 5 %)。
許容範囲。ただし**瞬間値がフレーム落ちとして見えるようなら**、点数を CSS px 幅の 1/3 まで
落とすか、積分済み区間は `samplesOldestFirst()` の内挿(`at(t)`、ケプラー解を解かない)で
済ませる — 先端より手前は外挿ではなく内挿で足りる。

**リファクタリングの規模**: `property-window.ts` 569 行のうち、外枠として移るのは
概算 150 行。行(rows)・操作項目(items)・改名・グループ開閉は残る。

## 9. リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `DraggableWindow` の切り出しで、`OverlayManager` への `open`/`spec` 更新の順序が変わる | クリップの付け外しで排他が効かなくなり、プロパティウィンドウが2枚以上残る。見た目は正常なので気付きにくい | `property-window.ts:280-291` `currentSpec`。達成目標 10。マップで別の艦を続けて右クリックして1枚に保たれるか |
| ドラッグ判定の `CLICK_MOVE_THRESHOLD` を切り出しで落とす | わずかな指の揺れでクリックがドラッグ扱いになり、タッチで項目が押せなくなる | `property-window.ts:539`。コンパクト幅の実機確認 |
| canvas の色を `ACTIVE_THEME`(モジュール読み込み時に固定)から読む | 配色を切り替えてもグラフだけ前の色のまま残る | `theme.ts:81`。既存の TS 側トークン利用も同じ性質なので**新しい違反ではない**が、切替後に再読み込みが要ることを承知して採る |
| 予測先端を超えた時刻を毎回外挿する | ワープ直後など先端が現在時刻の近くにある間、200 点すべてがケプラー解になる。見積りの上限側 | §8 の代替(内挿への切り替え)を用意しておく |
| 位相差の符号をターゲットの `hHat` でなく自機の `hHat` で取る | 相対傾斜角が 90 度を超える軌道で前後が反転する。同一面ではまったく正常に見える | `orbit-analysis-data.ts`。逆行軌道のターゲットで確認 |
| 位相差を `(-pi, pi]` へ折り返し忘れる | ターゲットを半周以上追い越したとき、線が横軸を突き抜けて画面外へ飛ぶ | 同上。達成目標 8 |
| ターゲットの `period` を自機の要素から取る | `r_circ` が自機周期基準になり、換算の意味が壊れる。同高度では差が出ないので気付けない | 高度差の大きいターゲットで確認 |
| `TabBar.setItems` を毎 sync で新しい配列リテラルで呼ぶ | 実装は内容比較しているので作り直しは起きない。ただし比較は `[値, ラベル]` の浅い比較 — ラベルに距離などの変動値を入れると毎回組み直しになり、押しかけのタブが消える | `tab-bar.ts:29-38`。**タブのラベルに変動値を入れない** |
| 接近タブが消える瞬間に選択が宙に浮く | 空白のグラフが残る。エラーは出ない | 達成目標 7。高度タブへ落とす処理を必ず入れる |
| `ValueInput` の `keydown` 伝播を止め忘れる | 入力欄に打った文字がそのまま機体操作になる | `value-input.ts:45-47` が既に止めているので、**生の `<input>` を自作しない限り**問題にならない |
| 軌道分析パネルを Orbit パネル(戦闘ビュー専用)から開くのに、マップビューへ切り替えても残る | 意図どおりか未定。Orbit パネル自体はマップで畳まれる | Step 4 で挙動を決める。**推奨は残す**(クリップ済みの窓はビューをまたいで残るのが `PropertyWindow` の既定) |
