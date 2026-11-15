# バグ調査レポート — ステージ00 波状攻撃の即時消滅 / 長時間プレイ後のブラックアウト

調査日: 2026-07-26 / 対象ブランチ: `refactor` / 対象コミット: `25aea20`（change: 波状攻撃のコードをステージ00に移動）
調査方法: 静的コード調査 + **ヘッドレス実機再現**（Chrome + CDP でゲームを駆動し、一時的な計測コードで内部状態を観測）。
計測コードは調査後に revert 済み。**このレポートの時点でリポジトリに変更は入っていない。**

対象は下記2件の報告バグ。

- **報告①**: ステージ00で、敵の波状攻撃が2秒おきに出現し、出現と同時に大気圏に突入する。
- **報告②**: ステージ00で、時間が十分経過した後、弾を発射すると画面がブラックアウトする。

| # | バグ | 状態 | 深刻度 | 修正難度 |
|---|---|---|---|---|
| **A1** | 波の飛来速度ランプが無制限 → 高波数で敵の近地点が地中に落ちる | **修正済み**（下記フェーズ1） | 致命 | 小 |
| **A2** | `randPerp(player.r)` の引数誤用 → 波が必ず自機の真上/真下に出る | **修正済み**（下記フェーズ1） | 高 | 極小 |
| **A3** | 「近地点90km以上」の安全装置が実際には**出現高度**しかクランプしていない | **修正済み**（下記フェーズ1） | 高 | 小 |
| **B1** | `MarkerManager` のマーカー DOM が永久に解放されない | **確定（リーク）** | 中 | 小 |
| **B2** | ゲームオーバー後 `Simulator.cleanup` が呼ばれず弾・破片が寿命消滅しない | **確定** | 低 | 極小 |
| **B3** | ブラックアウトそのもの（報告②）の直接原因 | **未確定**（再現せず） | 致命 | 未定 |

---

## 前提: 関係するコードの構造

ステージ00（無限耐久サバイバル）は `src/game/stages/stage00.ts` に閉じている。1波分の敵の生成は同ファイル
末尾のモジュール関数群が担当する。

```
Stage00.update()
  └ updateActiveCombatPhase()          … 圏外デスポーン → 同時展開数の判定 → 次の波の生成
       └ spawnWave() → generateWave()
            ├ pickWaveCenter()         … 波の中心位置を決める
            ├ makeFlybyVelocity()      … 波全体の初速（自機に対するフライパス速度）を決める
            └ waveShipPosition()       … 隊列内の各機の位置を決める（安全装置つき）
```

生成された敵は `Simulator` が RK4 で積分し、毎フレーム `Enemy.checkLoss()`（`src/game/orbit-entity/enemy.ts`）
が高度を見る。高度が `C.REENTRY_ALT`（80 km）を割ると `alive = false` にして
`Stage.recordEnemyDeath(..., 'reentry')` を呼ぶ。これが HUD に「再突入により喪失」と出る経路。

---

## A1.【致命】波の飛来速度ランプが無制限 → 高波数で敵の近地点が地中に落ちる

### 症状
報告①そのもの。ある程度波が進んだ後、生成された敵が出現直後に大気圏へ落ちて全滅する。

### 根本原因

`src/game/const.ts`:

```ts
export const STAGE00_FLYBY_SPEED = 200.0;      // フライパスの相対速度 [m/s]
export const STAGE00_FLYBY_SPEED_RAMP = 10;    // 波が進むごとのフライパス速度増加 [m/s]
```

`src/game/stages/stage00.ts`（`makeFlybyVelocity` 内）:

```ts
const flybySpeed = C.STAGE00_FLYBY_SPEED + (wave - 1) * C.STAGE00_FLYBY_SPEED_RAMP;
...
return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
```

この `flybySpeed` は**そのまま敵の初速の Δv として自機の速度に加算される**。
ステージ00は無限に続き `waveCount` に上限がないため、`flybySpeed` は際限なく増え続ける。

- 第 10 波 … 290 m/s
- 第 50 波 … 690 m/s
- 第 91 波 … **1110 m/s**

高度 420 km の円軌道（軌道速度 7.66 km/s）に対して数百 m/s〜1 km/s の Δv を打つということは、
**その場で近地点を数百 km 引き下げる**のと同じ意味になる。とくに Δv が逆行成分を持つ場合、

> 近地点高度の低下量 ≈ 3550 × Δv[m/s] （高度420km・円軌道からの逆行バーンの1次近似）

なので、**逆行方向なら 200 m/s（＝第1波の基準値）ですでに近地点が地表下**に落ちる。ランプはそれをさらに悪化させる。

`STAGE00_WAVE_MAX_SHIPS`（1波あたり30機）のような上限がこの速度には無い、というのが本質。

### 実測（ヘッドレス再現）

ステージ00を `?stage=00&perf=1` で起動し、最大ワープ（×4096）で約3分（sim 205時間）放置した時点:

```
MET T+ 205:21:14 / CONTACTS 2591/2591 / サバイバル 第92波
敵 W92-23 : 距離 4.16 km / 相対速度 956.2 m/s
            遠地点 AP  1.51 Mm
            近地点 PE  -465.86 km   ← 地中
```

同時に、生成された波が一斉に喪失していることも観測（1波30機が同一 simTime で全滅）。

### 「2秒おきに出現」の正体

これは**別のバグではなく A1 の症状**。`Stage00.updateActiveCombatPhase()`:

```ts
if (activeGroups === 0) {
  // 全滅または画面外へ離脱した場合でも、瞬時に次が湧き続ける無限ループを防ぐため最低2秒は待つ
  this.spawnTimer = Math.min(this.spawnTimer, 2.0);
}
```

`STAGE00_SPAWN_INTERVAL` は 30 秒だが、生成した波が即座に全滅すると `activeGroups === 0` になり、
このクランプが**毎フレーム** `spawnTimer` を 2.0 へ引き下げる。つまり 2 秒は「即湧き防止の下限」であり、
波が即死する限り**必ず2秒周期の無限ループ**になる。この 2.0 という値をいじってもバグは直らない。

---

## A2. `randPerp(player.r)` の引数誤用 → 波が必ず自機の真上/真下に出る

### 根本原因

`src/physics/vec3.ts`:

```ts
// fwd に直交するランダム単位ベクトル(散布界用)
export function randPerp(fwd: Vec3): Vec3 {
  for (;;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));   // ← fwd が単位ベクトルである前提の射影
    if (lenSq(p) > 1e-6) return norm(p);
  }
}
```

`src/game/stages/stage00.ts`（`pickWaveCenter` 内）:

```ts
// ウェーブ出現位置: 自機と同じ高度の水平方向(全方位)にランダムな距離で配置
...
dir = randPerp(player.r);   // ← 位置ベクトル（長さ 6.8e6 m）をそのまま渡している
```

`randPerp` は `fwd` が**単位ベクトル**であることを前提に `r - fwd·(r·fwd)` で射影している。
ここに長さ 6.8e6 m の位置ベクトルを渡すと、第2項が `|r|² ≈ 4.6e13` オーダーになって第1項を完全に飲み込み、
結果は `norm(-r × (r·rand))` すなわち **±r̂（真上か真下）** に収束する。直交どころか平行になる。

コード全体で `randPerp` に非単位ベクトルを渡している箇所は**ここ1箇所だけ**（他の呼び出しは
`randPerp(fwd)` / `randPerp(directDir)` / `randPerp(approachDir)` などすべて正規化済み）。

### 実測

生成した波の中心オフセットを自機の (径方向 R / 進行方向 V / 軌道面法線 H) 成分に分解した結果:

```
wave 2: center offset R=13.64km V=-0.00km H=0.00km     ← 完全に径方向
wave 3: center offset R=-11.89km V=-0.00km H=-0.00km
wave 4: center offset R=-13.02km V=-0.00km H=-0.00km
  dv: prograde=1.6  radial=199.6  normal=16.2          ← Δv もまるごと径方向
```

コメントは「水平方向(全方位)にランダムな距離で配置」と書いてあるが、実際には**必ず自機の直上か直下 10〜14 km**
に出ている。さらに `makeFlybyVelocity` の `approachDir` は「波の中心 → 自機のすぐ横」の向きなので、
中心が径方向にあるとフライパス Δv もまるごと径方向に入る。

### 注意: **A2 を単独で直すと A1 が悪化する**

現状は Δv が径方向に固定されているおかげで、近地点の低下がある程度抑えられている（径方向 200 m/s なら
近地点 ≈ 230 km で生き残る）。A2 だけ直して水平全方位にすると Δv に逆行成分が入り、**基準値 200 m/s でも
近地点が地表下**になる。A1・A2・A3 はセットで直す必要がある。

---

## A3.「敵の近地点は90km以上とする」安全装置が、実際には出現高度しかクランプしていない

コミット `a1c3832`（fix: 敵の近地点は90km以上とする）で入った安全装置は `waveShipPosition` の末尾にある:

```ts
// 安全装置: どんなに低くても高度90km未満(大気圏+10km)には出現させない
const safeAlt = C.REENTRY_ALT + 10e3;
const currentAlt = len(droppedPos) - C.R_EARTH;
if (currentAlt < safeAlt) {
  return scale(norm(droppedPos), C.R_EARTH + safeAlt);
}
```

これがクランプしているのは**出現した瞬間の高度**であって、**軌道の近地点ではない**。
コミットのタイトルが意図した保証（近地点 ≥ 90 km）は実装されていないので、速度側から近地点を掘り下げる
A1/A2 に対して何の防御にもなっていない。実際、出現高度は 406〜433 km と正常な一方で近地点は −465 km だった。

---

## 報告②（ブラックアウト）について

### 再現できなかった

以下の2セッションをヘッドレスで実行したが、**JavaScript 例外 0 件、ブラックアウトなし**:

1. ステージ00 → 初期射撃 → 最大ワープ（×4096）で 3 分放置（sim 205 時間、敵 2591 体スポーン）→ ワープを戻して連射
2. ステージ00 → ワープなし（×1）で 7 分間、12 秒射撃 / 3 秒休止をひたすら繰り返す

### NaN 説は否定的

過去コミット `86c12fd`（fix: 戦闘中にブラックアウトする(途中)）で
`Number.isNaN(this.player.state.r.x)` の throw が仕込まれていたことから NaN 汚染が疑われていたが、
今回は自機・敵・薬莢・マガジンベルトの位置/速度/姿勢すべてを毎フレーム走査する計測を入れて上記2セッションを
回し、**一度も発火しなかった**。少なくともこの再現範囲では NaN は起きていない。

### 判明した事実

- **描画コストが単調増加する**: `render` フェーズの所要時間が
  14 ms（開始直後）→ 25 ms（sim 205 時間経過後）→ 53 ms（7分連射後）、fps は 30 → 17。
- **B1: マーカー DOM のリーク（確定）** — `src/game/marker/marker-manager.ts` の `markerDictionary` は
  キーごとに DOM 要素を作るが、**一度作った要素を削除する経路が存在しない**。ステージ00の敵名は
  `W{波番号}-{機体番号}` で無限に増えるため、2591 体スポーンした時点で同数のマーカー要素が
  `display:none` のまま残り、`MarkerManager.resolveCollisions()` が毎フレーム全件を走査する。
- **B2: ゲームオーバー後に `cleanup` が呼ばれない（確定）** — `src/game/game.ts` の `update()` は
  `!this.activeStage.isPlaying` のとき `stepSimulation` だけ呼んで早期 return するため、
  `this.simulator.cleanup(dt, this.activeStage)` を通らない。結果、決着後は弾・薬莢・破片が
  寿命でもデスポーン高度でも消えなくなり、配列上限まで溜まり続ける。

### B3: ブラックアウトの最有力仮説（未検証）

**WebGPU のデバイスロスト**。マズルフラッシュは1発ごとに `PlaneGeometry` と `MeshBasicMaterial` を新規生成し、
0.07 秒後に dispose する構造になっている:

- `src/render/billboard.ts` — `Billboard` のコンストラクタが毎回 `new THREE.PlaneGeometry(1, 1)` と
  `new THREE.MeshBasicMaterial({...})` を生成する。
- `src/game/vfx/flash-effect-manager.ts` — `syncFlashEffects` が寿命切れで `billboard.dispose()` する。

連射中は毎秒十数個の GPU リソース生成/破棄が走ることになり、これは過去に修正済みの `BUG_REPORT.md` B1
（弾の dispose 未実装による GPU リソースリーク → 数分でブラックアウト）と**同種の症状を出しうる**位置にある。

なお、デバイスロストを検出する `device.lost` ハンドラはコミット `86c12fd` で一度追加されたあと
`c496ddc` で削除されており、**現状はデバイスが失われても何のログも出ずに黒画面になるだけ**。

---

## 修正プラン

### フェーズ1 — 報告①の修正（A1 + A2 + A3 はセットで直す）【実施済み】

実装済み。変更ファイル: `src/game/const.ts` / `src/game/stages/stage00.ts` / `src/physics/vec3.ts`
（設計文書は `DEVELOP/SPEC.md` §13 と `DEVELOP/CALLSTACK.md` を同期済み）。
以下は実装した内容そのもの。

対象: `src/game/stages/stage00.ts`, `src/game/const.ts`

1. **A2: `randPerp` の引数を正規化する。**
   `pickWaveCenter` の `randPerp(player.r)` を `randPerp(norm(player.r))` にする。
   併せて `randPerp` の JSDoc に「引数は単位ベクトルであること」を明記する
   （`src/physics/vec3.ts`。関数側で `norm()` を掛けて防御する案もあるが、他の全呼び出しが
   正規化済みで無駄なコストになるため、契約をコメントで明示する方を推奨）。

2. **A1: フライパス速度に上限を設ける。**
   `src/game/const.ts` に `STAGE00_FLYBY_SPEED_MAX`（推奨 400 m/s 程度）を追加し、
   `makeFlybyVelocity` で `Math.min(base + (wave - 1) * ramp, MAX)` とクランプする。
   *理由*: 「波が進むほど速くなる」という演出意図は残しつつ、Δv が軌道を壊す領域に入らないようにする。
   400 m/s は自機の 30 km 交戦圏を約 75 秒で通過する速度で、フライパスとしては十分速い。

3. **A3: 出現高度ではなく「軌道の近地点」をクランプする。**
   `generateWave` で `state` を確定させた直後（`orbitState(...)` の後）に、
   `elementsFromState(state.r, state.v)` から近地点 `a * (1 - e)` を求め、
   `C.REENTRY_ALT + 余裕`（推奨 40 km ＝ 高度 120 km）を下回るなら Δv を縮めて再構成する。
   実装方針は2案:
   - **(推奨) Δv 全体をスケールダウンする**: 近地点が安全高度になるまで `flybySpeed` を二分探索、
     または閉形式で許容 Δv を解いてスケールする。方向（演出）を保ったまま安全になる。
   - **径方向・逆行成分だけを削る**: 水平・順行成分は残すので速度感は保てるが、
     「自機に向かって飛んでくる」という演出が崩れやすい。
   どちらにせよ `waveShipPosition` 内の**出現高度クランプは残す**（別の保険として有効）。
   A3 を入れておけば、将来 A1/A2 の周辺を触っても近地点が地中に落ちることは構造的に起きなくなる。

4. **後始末**: `waveShipPosition` のコメント「安全装置: どんなに低くても高度90km未満には出現させない」は
   実装どおり「出現高度のクランプ」であることが分かる文言に直す（近地点の保証は 3. が担う旨も書く）。
   `pickWaveCenter` のコメント「自機と同じ高度の水平方向(全方位)」は 1. の修正後に初めて事実になる。

**実装の詳細**: 3. は `stage00.ts` のモジュール関数 `limitFlybyDv(playerV, centerR, centerV)` として実装した。
近地点高度は `elementsFromState(centerR, v).peAlt` で評価し、Δv の**方向を保ったまま倍率だけを 24 回の二分探索で
縮める**（`lo` は常に「安全と判定済み（または Δv = 0）」側なので、返す値は必ず安全側になる）。
隊列の各機は波の中心から数 km の範囲に散るだけなので、中心で近地点を保証すれば全機が余裕 40 km の内側に入る。

**検証結果**（`npm run typecheck` / `npm run test:physics` 41/41 pass に加え、ヘッドレス実機）:

| | 修正前 | 修正後 |
|---|---|---|
| 第90波あたりの敵の相対速度 | 956 m/s | 105〜118 m/s |
| 同・敵の近地点高度 | **−465.86 km**（地中） | 380 km 台〜（安全高度以上） |
| 自機の軌道（最大ワープ3分後） | **8.25 km/s / 遠地点 3.05 Mm**（高速の敵に弾かれて破綻） | 7.66 km/s / 419 km（正常） |
| ×1 で3分放置したときの波 | 2 秒おきに湧いては全滅 | 12 機が生存し続け、波数も増えない |

**副作用として意図している挙動**: 近地点保証が効くぶん、逆行方向のフライパスは上限 400 m/s まで出せず
100 m/s 前後に抑えられる（順行・法線・動径方向は速いまま）。これは物理的に正しい帰結
——低軌道の機体に逆行 400 m/s を撃てば自分の近地点が大気圏に落ちる——であり、`DEVELOP/SPEC.md` §13 に明記した。

### フェーズ2 — 確定しているリーク2件の修正（報告②とは独立に有効）

5. **B1: `MarkerManager` にマーカーの解放経路を作る。**
   対象: `src/game/marker/marker-manager.ts`。
   現状 `set()` はキーが無ければ要素を作るだけで、消す手段が無い。
   `resolveCollisions()` は「全マーカーを見る唯一の呼び出し」であり `Game.sync` の最後に呼ばれるので、
   ここを利用して「このフレームで一度も `set()` されなかったキー」を N フレーム連続で検出したら
   DOM から remove して辞書から消す、という世代管理を入れるのが素直。
   *責務の注意*: マーカーを出す側（`Enemy` / `Logistics` / `PlanGuide` …）に解放を依頼させないこと。
   「各オブジェクトが自分のマーカーを sync する」という既存ルール（CLAUDE.md `src/game/marker/` の節）を
   保つなら、寿命管理は `MarkerManager` 側に閉じるのが正しい。

6. **B2: 決着後も `Simulator.cleanup` を呼ぶ。**
   対象: `src/game/game.ts` の `update()` 早期 return 枝。
   `stepSimulation` の直後に `this.simulator.cleanup(dt, this.activeStage)` を追加する。
   `cleanup` は `checkLoss` → `prune` を回すだけで勝敗判定には触れないため、決着後に呼んでも副作用はない
   （敵の `checkLoss` は `recordEnemyDeath` 経由で `checkWin` を起動しうるが、`Stage` 側は
   `cause !== 'killed'` の枝で早期 return するので勝敗は動かない）。

**検証**: `npm run typecheck` +（可能なら）ヘッドレスで数分連射し `perf=1` のエンティティ数と
`render` 時間が単調増加しないことを確認する。

### フェーズ3 — 報告②の原因特定（フェーズ1・2の後にやる）

7. **デバイスロストのログを常設する。**
   `src/render/scene.ts` の `createGameScene` に、`c496ddc` で消された `device.lost` ハンドラを戻す。
   デバッグ専用の握り潰しではなく、**ユーザーに見える形**（`Hud` のトースト or エラーオーバーレイ）に
   出すのが望ましい。原因が何であれ「黒画面になったが何も分からない」状態を終わらせるのが先。

8. **フラッシュ用ビルボードをプール化する。**
   `src/render/billboard.ts` の `PlaneGeometry` は全ビルボードで同一形状（1×1 の板）なので、
   **モジュールスコープの共有ジオメトリ**にできる（`glow-texture.ts` が既にテクスチャで同じことをしている）。
   マテリアルは色と opacity を個体ごとに書き換えるため共有できないが、`FlashEffectManager` 側で
   `Billboard` インスタンス自体をプールして再利用すれば毎発の生成/破棄が消える。
   これは B3 の仮説が当たっていれば直接の修正、外れていても純粋な高速化になる。

9. **7. と 8. を入れた状態で長時間再現を試す。**
   フェーズ1 の修正後は敵が即死しなくなり同時エンティティ数が増えるので、
   フェーズ1 前の再現条件（ワープ放置）とは負荷特性が変わる点に注意。

---

## 付録: 実機再現の手順（`/verify` スキルの手順を本件向けに具体化したもの）

1. `npm run dev` をバックグラウンド起動する。
   **ポート番号を必ず出力から確認すること** — 8080 が他プロセスに使われていると
   webpack-dev-server は 8081/8082… へ自動的にずれる（今回の調査では 8082 になり、
   最初の1回は他人のサイトを掴んで無駄になった）。
2. ヘッドレス Chrome を CDP 付きで起動する:
   `--remote-debugging-port=<port> --headless=new --enable-gpu --enable-unsafe-webgpu --disable-gpu-sandbox --no-sandbox --user-data-dir=<tmp> --mute-audio --window-size=1280,720`
3. Node から WebSocket で接続する。Node 20 では **`node --experimental-websocket` が必要**
   （グローバル `WebSocket` が既定で無効）。
4. `Runtime.enable` して `Runtime.consoleAPICalled(type=error)` と `Runtime.exceptionThrown` を収集し、
   `Page.navigate` で `http://localhost:<port>/?stage=00&perf=1` を開いて WebGPU 初期化を ~15 秒待つ。
5. `Input.dispatchKeyEvent`（`rawKeyDown`/`keyUp`、`code` 必須）で駆動する:
   `Space` = 射撃、`Period` = ワープ加速（6回で ×4096）、`Comma` = 減速。
6. 状態の読み取りは `Runtime.evaluate` で `document.body.innerText` を取るのが手っ取り早い
   （HUD パネル・`?perf=1` のエンティティ数がまとめて読める）。
   **canvas のピクセルを `drawImage` 経由で読んで明るさを測る方法は使えない**
   （WebGPU canvas からの 2D コンテキストへのコピーは常に真っ黒が返る）。ブラックアウトの判定は
   `Page.captureScreenshot` の目視で行うこと。
7. 内部状態（NaN 検査など）が要る場合は `Game` がグローバルに露出していないため、
   `src/game/game.ts` に一時的な計測コードを入れて `console.error` へ吐く。
   **調査後に必ず revert する。**
8. `npm run dev` は `docs/` 配下のバンドルを書き換える。調査後に `git status` を確認し、
   `docs/` に差分が出ていたら戻すこと（`docs/` は GitHub Pages の公開物）。
