# ブラックアウト調査・解決プラン

作成日: 2026-07-26 / 対象ブランチ: `refactor` / 対象コミット: `88b68df` 時点
**この文書は単体で読めるように書いてある。** 前提知識なしに、何が起きていて・何が分かっていて・
次に何をすべきかが把握できることを目的とする。

---

## 0. プロジェクトの前提（この文書を読むのに必要な最小限）

`dive-into-tepui` は TypeScript + Three.js(`WebGPURenderer`) 製の、地球低軌道を舞台にした
実寸・実時間のシューティングゲーム。

この文書を読むうえで押さえるべき構造は次の4点だけ。

1. **シミュレーションと描画が分離している。** 物理状態は ECI 座標系（地球中心慣性系、Y軸=北極、
   単位 m / m/s）の素のデータ（`Vec3` / `OrbitState`）で保持し、毎フレーム
   `Game.update()` → `Game.sync()` → `Game.render()` の3フェーズで進む。
   `update` が論理値を更新し、`sync` がそれを Three.js のメッシュへ反映し、`render` が描画する。
2. **描画はフローティングオリジン方式。** 低軌道の絶対座標（6.8×10⁶ m オーダー）を GPU の
   float32 に渡すと精度が破綻するため、毎フレーム自機位置を原点とする変換
   （`game/floating-origin.ts` の `FloatingOrigin`）を作り直し、**全メッシュの座標はこれを通して**
   Three.js の座標へ変換する。つまり `FloatingOrigin` が壊れると**画面上の全オブジェクトが一斉に壊れる**。
3. **HUD は DOM である。** 各種情報ウィンドウ・マーカーは canvas ではなく HTML 要素として
   canvas の上に重ねてある。したがって **3D 描画が全滅しても HUD だけは正常に表示され続ける**。
4. **ステージ00** は無限耐久サバイバル。弾薬を確保すると敵の波（ウェーブ）が次々に襲来し、
   自機が破壊されるまで続く。

---

## 1. 報告されている症状

### 1-1. 今回の主報告

> ステージ00において、敵を射撃すると「W3-9 再突入により喪失」などと表示され、
> 各種情報表示ウィンドウを除く画面の 3D 背景が真っ暗になる。

「W3-9」は敵の個体名で、`W<ウェーブ番号>-<機体番号>` という命名。つまり第3波の9番機。

### 1-2. `memos/dev.md` に記録されている関連報告（人間が記入したもの）

> 時間加速後、2秒に一回 wave が大気圏に突入し、その状態で弾を打つと画面がブラックアウトする。
> **リロードしても読み込めなくなる**

> 時間加速後、wave50 程度まで過ごし、浮いていると、**画面背景が白くなり固まる**

このうち「2秒に一回 wave が大気圏に突入」の部分は**別バグとして原因特定・修正済み**
（`memos/BUG_REPORT_STAGE00.md` の A1〜A3、コミット `2e8ee5c`）。
残る「ブラックアウト」「リロード不能」「白くなって固まる」は未解決。

### 1-3. 過去に同種の症状が出て修正されたケース（再発ではないことの確認用）

`memos/BUG_REPORT.md` に記録がある。いずれも**共有 GPU リソースの誤破棄**が原因だった。

- **B1**: 弾の `dispose()` 未実装 → GPU リソースリーク → 数分でブラックアウト（修正済み）
- **B13**: `DebrisPiece.dispose()` が、テンプレートと共有しているジオメトリを破棄していた。
  1個破棄した瞬間に、画面上の同種デブリ全部と以後生成される全部が死んだバッファを参照し、
  WebGPU がデバイスロストしてブラックアウト（修正済み）

**今回の症状はこの2件と見た目が同じだが、後述の実験により同じ原因ではないことが確認できている。**

---

## 2. 確定していること

### 2-1. 「再突入により喪失」を出せる場所はコード中に1箇所しかない

`src/game/orbit-entity/enemy.ts` の `Enemy.checkLoss`:

```ts
checkLoss(_dt: number, simTime: number, activeStage: Stage): void {
  if (!this.alive) return;
  if (altitudeOf(this.state.r) >= C.REENTRY_ALT) return;   // REENTRY_ALT = 80km
  this.alive = false;
  this.destroyEffect();
  activeStage.recordEnemyDeath(this, simTime, 'reentry');  // → 「(名前) 再突入により喪失」
}
```

`Stage.recordEnemyDeath` は `cause` によって文言を出し分ける（`'reentry'` → 「再突入により喪失」、
`'despawn'` → 「交戦圏を離脱」、`'killed'` → 「撃破」）。つまりあのメッセージは
**「敵の高度が 80km を下回った」以外の経路では絶対に出ない**。

### 2-2. しかし「本当に高度が下がった」ことはありえない

コミット `2e8ee5c` で、ステージ00のウェーブ敵は**生成時に近地点高度 120km 以上を保証**するよう
修正済み（`stage00.ts` の `limitFlybyDv`）。第3波の敵が数十秒で高度 80km まで落ちる軌道には
そもそもならない。

### 2-3. したがって `altitudeOf()` が `NaN` を返している

```ts
if (altitudeOf(this.state.r) >= C.REENTRY_ALT) return;
```

**`NaN >= 80e3` は false** なので、`altitudeOf` が `NaN` を返すとこの early return を通り抜け、
「再突入により喪失」として処理される。**「再突入」表示は NaN の誤表示である**と考えるのが妥当。

### 2-4. 同じ NaN が 3D 画面の暗転も説明する

前提 2 のとおり、描画座標は全て `FloatingOrigin` を通る。`FloatingOrigin` は毎フレーム
`Game.sync` で**自機の積分後の状態から作り直される**ので、自機の位置が NaN になると
変換結果が NaN になり、地球・星・太陽・月・敵機・自機・弾・デブリの**全メッシュが一斉に
描画されなくなる**。HUD は DOM なので無傷（前提 3）。

これは報告された「情報表示ウィンドウを除く 3D 背景だけが真っ暗」と完全に一致する。

### 2-5. 1つの原因で両方の症状が同時に出る筋道

`Simulator.simTime` あるいは1フレームの積分幅 `simDt` が NaN になると、その1フレームで
**全エンティティの状態が同時に NaN になる**（全てが同じ `stepOrbitRK4(state, dt, ...)` を通るため）。
すると:

- 生存中の敵が**全員**「再突入により喪失」と表示される（2-3）
- 自機も NaN になり `FloatingOrigin` が壊れて**画面が真っ暗になる**（2-4）

報告されている症状の組み合わせがちょうどこれになる。**「NaN 汚染が単一の根本原因である」
というのが現時点の最有力仮説。**

---

## 3. 実験により除外できたこと

すべてヘッドレス Chrome（WebGPU 有効）+ Chrome DevTools Protocol で実機駆動して確認した。
手順は §7 に書いてある。

| 実験 | 内容 | 結果 |
|---|---|---|
| 撃破経路の連続実行 | `?autokill=1` で 1.5 秒ごとに敵を撃破。2分間で **57機撃破**。破片は上限 160 に張り付き、`Simulator.addCapped` の `dispose()` を数百回通過 | 例外0件・デバイスロスト0件・暗転なし |
| 撃破 + 連射の同時実行 | 上記に加えて `Space` 押しっぱなし（弾・薬莢・マズルフラッシュ・PIP 描画パスを同時に走らせる） | 例外0件・デバイスロスト0件・暗転なし |
| 連射のみ長時間 | ×1 のまま 7 分間、12秒射撃/3秒休止を繰り返す | 例外0件・暗転なし |
| 高倍率ワープ長時間 | ×4096 で3分（sim 205時間、敵 2591体スポーン） | 例外0件・暗転なし |
| NaN スキャン | 自機・敵・薬莢・ベルトの位置/速度/姿勢を毎フレーム全走査（上記のうちワープ+連射の回で実施） | **一度も発火せず** |
| `device.lost` 監視 | WebGPU デバイスの `lost` Promise にハンドラを仕込む（フック成功はログで確認済み） | **発火せず** |

**結論**: 撃破経路・デブリ破棄経路での共有 GPU リソース誤破棄（B1/B13 の再発）**ではない**。
コード側も、`Enemy` / `OrbitLine` / `DebrisPiece` の破棄経路を全て読み直したが、
ジオメトリは所有権フラグ（`userData.ownsGeometry` / `ownsMaterial`）で守られ、
マテリアルは `cloneIndependent` による個体別クローンで、共有テンプレートを壊す経路は残っていない。

**同時に、ヘッドレスでは症状を再現できなかった。** 実機（実 GPU）か、人間特有の操作
（時間加速の使い方、機体の操縦、フレームレートの揺れ）が引き金に絡んでいる可能性が高い。

---

## 4. 未検証の仮説（優先度順）

### H1. `simDt` / `simTime` の NaN 汚染 【最有力】

§2-5 のとおり、症状の組み合わせを単一原因で説明できる唯一の仮説。
`simDt = dt * simSpeed` で、`dt` は `main.ts` の rAF ループが `(now - lastTime) / 1000` で作る。
どこかで `NaN`（あるいは `Infinity`）が混入すれば全エンティティが一撃で汚染される。

- **未解明の点**: 何が最初に NaN を作るのか。rAF の `dt` 自体か、タイムワープ倍率か、
  自機の推力・姿勢積分か、剛体接触の解決か。
- **検証方法**: §5 フェーズ1 の NaN トリップワイヤ。**これが決定打になる。**

### H2. 自機の状態だけが NaN になる（`FloatingOrigin` 経由の暗転のみ）

自機の推力・姿勢・剛体接触のいずれかが自機の状態だけを壊すケース。
この場合、暗転は説明できるが「敵の再突入表示」は別原因（偶然の同時発生）になる。
H1 より説明力が低いが、可能性は残る。

### H3. WebGPU デバイスロスト（GPU リソースの生成/破棄チャーン）

ヘッドレスでは再現しなかったが、実 GPU/実ドライバでは挙動が異なりうる。
とくにマズルフラッシュは**1発ごとに**`PlaneGeometry` と `MeshBasicMaterial` を新規生成し、
0.07 秒後に破棄する（`src/render/billboard.ts` のコンストラクタと
`src/game/vfx/flash-effect-manager.ts` の `syncFlashEffects`）。連射中は毎秒十数個の
GPU リソース生成/破棄が走る。

- **この仮説を支持する材料**: dev.md の「**リロードしても読み込めなくなる**」。
  ページ再読み込みで復帰しないのは、JS 側の状態ではなく GPU アダプタ側が壊れている兆候。
- **現状の問題**: デバイスロストしても**何のログも出ない**（`device.lost` ハンドラは
  過去に一度入ったが、コミット `c496ddc` で削除されている）。
- **検証方法**: §5 フェーズ1 で `device.lost` ログを常設する。

### H4. 「白くなって固まる」は別現象

撃破エフェクトの閃光は `spawnShipDestroyEffect(state, ENEMY_SCALE=20, ...)` で
サイズが 20 倍される。`DESTROY_FLASH1_SIZE1 = 110` なので最大 **2,200 m** の加算合成ビルボードが、
数百 m〜数 km の距離に出る。近距離で撃破すると画面全体が白く覆われうる。
ただし「固まる」（ハングアップ）までは説明できないので、描画負荷や別の停止要因と複合している可能性がある。
優先度は低い（まず H1/H3 を潰す）。

---

## 5. 修正・調査プラン

### フェーズ1 — 原因を「捕まえる」計装を入れる 【最優先・次にやること】

再現がユーザーの実機でしか起きない以上、**発生した瞬間に証拠が残る**ようにするのが最短経路。
以下は恒久的に入れてよい低コストの仕組みとして設計する。

1. **NaN トリップワイヤ**（H1/H2 を確定させる）
   - `Game.update` の各フェーズ境界（`player.behave` の後 / `activeStage.update` の後 /
     `simulator.stepSimulation` の後 / 剛体接触解決の後）で、自機の位置・速度・姿勢と
     `simulator.simTime` の有限性を検査する。実行コストは1フレームあたり数回の `Number.isFinite` で無視できる。
   - 最初に崩れた瞬間だけ、**どのフェーズで壊れたか**と**直前フレームの値**をコンソールと HUD に出す。
     以後は検査を止める（ログの洪水を防ぐ）。
   - 併せて、その時点の `dt` / `simDt` / タイムワープ倍率も出す。
2. **`device.lost` の常設ログ**（H3 を確定させる）
   - `src/render/scene.ts` の `createGameScene` で WebGPU デバイスの `lost` を購読し、
     発火したら**ユーザーに見える形**（エラーオーバーレイ）で通知する。
   - 原因が何であれ「黒い画面になったが何も分からない」状態を終わらせるのが目的。
3. この計装を入れた状態でユーザーに一度再現してもらう。
   - **どちらのログが出るかで H1/H2 と H3 が排他的に切り分けられる。** ここが分岐点。

### フェーズ2 — 分岐: NaN が出た場合

トリップワイヤが指したフェーズの中を二分して発生源を特定し、原因箇所を直す。
値が壊れる典型的な場所は以下（調査の当たり所として）:

- `game/orbit-entity/collision.ts` の `resolveCollisionPair`（ゼロ距離・ゼロ質量での除算）
- `game/player/belt-physics.ts` の Verlet 積分（`dt` の逆数を使う箇所がある）
- `physics/attitude.ts` の `stepAttitude`（クォータニオンの正規化）
- `sim-speed-manager.ts` の自動ワープ（目標時刻からワープ倍率を算出する箇所）

### フェーズ2' — 分岐: デバイスロストが出た場合

GPU リソースのチャーンを止める。

1. `src/render/billboard.ts` の `PlaneGeometry` は全ビルボードで同一形状（1×1 の板）なので、
   **モジュールスコープの共有ジオメトリにする**（`glow-texture.ts` が既にテクスチャで同じことをしている）。
2. マテリアルは色と不透明度を個体ごとに書き換えるため共有できないが、`FlashEffectManager` 側で
   `Billboard` インスタンス自体をプールして再利用すれば、毎発の生成/破棄がなくなる。
3. これは仮説が外れていても純粋な高速化になるので、無駄にはならない。

### フェーズ3 — 併せて直すべき、調査中に見つかった実バグ

いずれも今回の症状の主因ではないが、確定した不具合。

1. **編隊の機体間隔が接触直径より狭い**
   `STAGE00_FORMATION_SPACING` = 200 m に対し、敵の `collideRadius` は `ENEMY_RADIUS` = 180 m。
   接触判定の直径は 360 m なので、**隣り合う僚機は生成時点で必ずめり込んでいる**。
   `CollisionPhysics` が毎フレーム位置補正で押し離すため、生成直後の編隊が不自然に散り、
   速度を変えずに位置だけ動かす補正の性質上、軌道要素も乱れる。
   → 間隔を接触直径より広げるか、同一ウェーブの僚機同士を接触判定から除外する。
2. **決着後に `cleanup` もカメラ更新も走らない**
   `src/game/game.ts` の `update()` は `!activeStage.isPlaying` のとき早期 return するが、
   その経路が `simulator.cleanup()` と `cameraSystem.update()` を飛ばしている。
   結果、死亡後は弾・薬莢・破片が寿命でもデスポーン高度でも消えず（実測で `bullets 1180` に張り付く）、
   カメラは絶対 ECI 座標に取り残されたまま自機だけが遠ざかっていく。
   → 早期 return 経路にも `cleanup()` を入れる。カメラ更新の要否は演出の意図次第なので要判断。
3. **マーカー DOM のリーク**
   `src/game/marker/marker-manager.ts` の `markerDictionary` はキーごとに DOM 要素を作るが、
   **削除する経路が存在しない**。ステージ00の敵名は無限に増えるため、2,591体スポーンした時点で
   同数のマーカー要素が `display:none` のまま残り、`resolveCollisions()` が毎フレーム全件を走査する。
   実測で `render` フェーズは 14ms → 25ms → 53ms と単調に増加した。
   → `resolveCollisions()`（全マーカーを見る唯一の呼び出し）で世代管理し、一定フレーム
   更新されなかったキーを DOM ごと解放する。マーカーを出す側に解放を依頼させないこと。

---

## 6. 関連するコードの地図

| ファイル | この件での役割 |
|---|---|
| `src/game/orbit-entity/enemy.ts` | `checkLoss` が「再突入により喪失」を出す唯一の場所 |
| `src/game/stages/stage.ts` | `recordEnemyDeath` が原因別の文言を出し分ける |
| `src/game/floating-origin.ts` | 論理座標 → Three.js 座標の唯一の変換。壊れると全メッシュが消える |
| `src/game/game.ts` | `update`/`sync`/`render` の三相。決着後・ポーズ中の早期 return もここ |
| `src/game/orbit-entity/simulator.ts` | `simTime` の保持、サブステップ積分、寿命管理（`cleanup`/`prune`） |
| `src/game/orbit-entity/collision.ts` | 剛体接触の解決。NaN の発生源候補 |
| `src/game/player/belt-physics.ts` | 弾薬ベルトの Verlet 積分。NaN の発生源候補 |
| `src/render/billboard.ts` | 閃光1個ごとにジオメトリ+マテリアルを生成/破棄。デバイスロストの候補 |
| `src/game/vfx/flash-effect-manager.ts` | 閃光の寿命管理と破棄 |
| `src/render/scene.ts` | `WebGPURenderer` を作る唯一の場所。`device.lost` を仕込むならここ |
| `src/game/marker/marker-manager.ts` | マーカー DOM のプール（解放経路なし） |
| `src/main.ts` | rAF ループ。`dt` の生成と例外ハンドリング |

---

## 7. 実機再現の手順（ヘッドレス Chrome + CDP）

`.claude/skills/verify/SKILL.md` の手順を本件向けに具体化したもの。**ハマりどころも含めて記載する。**

1. `npm run dev` をバックグラウンド起動する。
   **ポート番号を必ず出力から確認すること** — 8080 が他プロセスに使われていると
   webpack-dev-server は 8081/8082… へ自動的にずれる（今回の調査で実際にずれた）。
2. ヘッドレス Chrome を CDP 付きで起動する:
   `--remote-debugging-port=<port> --headless=new --enable-gpu --enable-unsafe-webgpu --disable-gpu-sandbox --no-sandbox --user-data-dir=<tmp> --mute-audio --window-size=1280,720`
3. Node から WebSocket で接続する。**Node 20 では `node --experimental-websocket` が必要**
   （グローバル `WebSocket` が既定で無効）。
4. `Runtime.enable` して `Runtime.consoleAPICalled(type=error)` と `Runtime.exceptionThrown` を収集し、
   `Page.navigate` で `http://localhost:<port>/?stage=00&perf=1` を開いて WebGPU 初期化を ~15 秒待つ。
5. `Input.dispatchKeyEvent`（`rawKeyDown`/`keyUp`、`code` 必須）で駆動する:
   `Space` = 射撃、`Period` = ワープ加速（6回で ×4096）、`Comma` = 減速。
6. 状態の読み取りは `Runtime.evaluate` で `document.body.innerText` を取るのが手っ取り早い
   （HUD パネルと `?perf=1` のエンティティ数がまとめて読める）。
   **canvas のピクセルを `drawImage` 経由で読んで明るさを測る方法は使えない**
   （WebGPU canvas から 2D コンテキストへのコピーは常に真っ黒が返る）。
   暗転の判定は `Page.captureScreenshot` の目視で行うこと。
7. 内部状態を覗くには、`Game` がグローバルに露出していないため `src/game/game.ts` に一時的な
   計装を入れて `console.error` へ吐く。**調査後に必ず revert する。**
8. `npm run dev` は `docs/` 配下のバンドルを書き換える。調査後に `git status` を確認し、
   `docs/` に差分が出ていたら戻すこと（`docs/` は GitHub Pages の公開物）。

### 調査を効率化するために作った一時計装（再利用する場合の参考）

- `?autokill=1` で 1.5 秒ごとに最も近い敵を `Enemy.attacked()` で強制撃破する。
  ヘッドレスでは狙って命中させられないため、撃破経路を確実に踏ませるのに使った。
- `Stage.recordEnemyDeath` の入口で、`cause !== 'killed'` のときに敵の高度・位置・速度をログする。
- 自機・敵・薬莢・ベルトの位置/速度/姿勢を毎フレーム走査する NaN スキャン。

---

## 8. 未解決の疑問（次に answer が必要なもの）

- NaN の**最初の発生源**はどこか（フェーズ1 で確定する）。
- デバイスロストが実機で起きているのか（フェーズ1 で確定する）。
- 「白くなって固まる」は撃破閃光のサイズ問題（H4）か、別の停止要因か。
- 「リロードしても読み込めなくなる」は本当にリロード後も再発するのか、
  それともタブを閉じるまで戻らないのか。**H3 の裏取りとしてユーザーへの確認が必要。**
