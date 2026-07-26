# バグ調査レポート

調査日: 2026-07-26 / 対象: HEAD `dda9caa`（リファクタリング PR #1 マージ後）
調査方法: 4系統の並列コード調査（リソースリーク / 配線漏れ / リグレッション網羅 / 状態不整合レビュー）。
**すべて読み取り専用の静的調査。コードは変更していない。**

前提として `npm run typecheck` はエラーなし、`npm run test:physics` は **41/41 pass**。
今回のバグはいずれも型・物理計算ではなく、**リファクタ時の呼び出し移植漏れとリソース解放漏れ**に集中している。

---

## 優先度サマリ

| # | バグ | 深刻度 | 修正の重要度 | 確信度 | 難易度 |
|---|---|---|---|---|---|
| **B1** | 弾の `dispose()` 未実装による GPU リソースリーク → 数分でブラックアウト | **致命** | **最優先** | 高 | 小 |
| **B2** | Stage0 で `updateLogistics()` が呼ばれず弾薬補給不能 | 高 | **最優先** | 高 | 極小 |
| **B3** | `sfx.setRcs()` の呼び出しが移植漏れ → RCS 音が鳴らない | 中 | 高 | 高 | 小 |
| **B4** | `Enemy.dispose()` が `OrbitLine` を破棄しない（`OrbitLine.dispose` 自体が無い） | 中 | 高 | 中 | 小 |
| **B5** | `WaveManager` と `Simulator.prune` による敵の二重 dispose | 中 | 中 | 高 | 小 |
| **B6** | `consumeFirstNode()` が `PlanEditor.selectedNodeIdx` を追随させない | 中 | 中 | 中 | 小 |
| **B7** | `Ammo` の `dispose()` 未実装（量的に軽微） | 低 | 低 | 高 | 極小 |
| **B8** | ポーズ中でも `[M]` マップモード切替が効く（コメントの意図と不一致） | 低 | 低 | 中 | 極小 |
| **B9** | `CollisionPhysics` の O(n²) 総当たり衝突判定 | 低 | 低（B1修正後に再評価） | 中 | 中 |
| **B10** | `stepSimulation` のサブステップ数計算（作者自身が「謎実装」とコメント） | 低 | 低 | 低 | 中 |
| **B11** | `timeSincePeriapsis` が双曲線軌道で NaN を返しうる | 低 | 低 | 低 | 極小 |
| **B12** | `sfx.debrisImpact()` がデッドコード（リファクタ前から未使用） | 情報 | — | 高 | — |

---

## B1. 【致命】弾の `dispose()` 未実装による GPU リソースリーク

**症状**: プレイ開始 2 分ほどで徐々に重くなり、画面がブラックアウトする（報告バグ①）。

**根本原因**:
`Bullet`（`src/game/orbit-entity/bullet.ts`）が `dispose()` をオーバーライドしていない。
基底の実装（`src/game/orbit-entity/entities.ts:81-83`）は scene からの除去のみ:

```ts
dispose(): void {
  this.scene?.remove(this.obj);
}
```

`DebrisPiece.dispose()`（entities.ts:175-184）と `Enemy.dispose()`（enemy.ts:70-73）は自前で
traverse して geometry/material を破棄しているのに、**`Bullet` だけこれが抜けている**。

一方、弾メッシュの生成（`src/render/ships.ts:160-220`）は呼び出しごとに固有リソースを作る:

```ts
const haloMat  = new THREE.MeshBasicMaterial({ ... });
const haloGeom = new THREE.CylinderGeometry(0.5, 0.5, 7, 8);
```

加えて `cloneIndependent()`（ships.ts:50-61）が本体マテリアルもインスタンスごとに `.clone()` する。
→ **弾 1 発につき最低 3 つの GPU リソース（本体マテリアル + ハローのジオメトリ + ハローのマテリアル）が
生成され、一度も解放されない。**

**時間的整合**:
`FIRE_INTERVAL = 0.06`（const.ts:87）= 毎秒約 16.7 発。
上限は `addCapped(this.bullets, bullet, C.MAX_BULLETS * 3)`（simulator.ts:56-58）= 1200 発。
**1200 / 16.7 ≒ 72 秒**で上限到達、以後は毎秒 16〜17 組がリークし続ける。
WebGPURenderer はマテリアル/ジオメトリ単位でパイプラインとバインドグループをキャッシュし、
`dispose()` イベントで解放する設計のため、蓄積が GPU メモリを圧迫し
最終的に **device lost（ブラックアウト）** に至る。報告の「2 分ごろ」と量的・時間的によく符合する。

**設計意図との矛盾**（simulator.ts:69-73）:
```ts
// 上限超過時は最古の個体をシーンから外す(弾・薬莢のジオメトリは共有なので破棄しない)
if (arr.length > cap) arr.shift()!.dispose();
```
コメントは「弾のジオメトリは共有」を前提にしているが、実際には ships.ts が
弾ごとに新規ジオメトリ/マテリアルを作っており、**前提が崩れている**。

**修正方針（2 段構え。両方やるのが望ましい）**:
1. `src/render/ships.ts` の `buildBulletMesh` / `buildPlasmaMesh` で、ハロー用の
   `CylinderGeometry` と `MeshBasicMaterial` を**モジュールスコープに引き上げて共有**する。
   `cloneIndependent()` のマテリアル `.clone()` も、弾ごとに色を変える必要がないなら共有化を検討。
   → これで simulator.ts のコメントどおり「共有なので破棄不要」が本当になる。
2. 保険として `Bullet` に `dispose()` を実装（`DebrisPiece.dispose()` と同じ traverse パターン）。
   ただし 1 で共有化した場合、共有リソースを破棄しないよう注意すること。

**検証手順**: `?perf=1` を付けて起動し、`bullets` が 72 秒前後で 1200 に張り付いた後
`render ms` が右肩上がりに悪化しないことを確認する。`heap` は JS ヒープのみで GPU 側は映らないため、
GPU 側は Chrome DevTools の Memory / GPU process か `chrome://gpu` を併用。

---

## B2. 【高】Stage0（訓練ステージ）で弾薬補給ができない

**症状**: T ステージ（訓練 = Stage 0）で AMMO に接触しても補給されない（報告バグ③）。

**根本原因**:
`Stage0.update()`（`src/game/stages/stage0.ts:39-47`）が
**`this.logistics.updateLogistics(...)` を一度も呼んでいない**。
`init()` では `logistics.spawnForPlayer(...)`（stage0.ts:33）で補給を軌道上に出しているが、
実際の回収処理 `absorbNearbyAmmo` と遠方デスポーン `despawnFarAmmo` は
`updateLogistics()` の中でしか呼ばれない（logistics.ts:59-61）:

```ts
updateLogistics(simTime: number, player: Player, respawnOnDespawn = false): void {
  if (player.alive) this.absorbNearbyAmmo(player);
  this.despawnFarAmmo(player, respawnOnDespawn);
```

他ステージには呼び出しが存在する:
- `stage1.ts:49` → `this.logistics.updateLogistics(simTime, player);`
- `stage2.ts:54` → 同上
- `stage00.ts:73` → `wave-manager.ts:56` 経由で間接呼び出し
- **`stage0.ts` にのみ存在しない。**

リファクタ前（`eb208ed` の game.ts:1014 付近）では吸収処理がステージ分岐なしに毎フレーム
無条件実行されていたため Stage0 でも動作していた。`Logistics` クラスへ切り出す際に
Stage1/2/00 には呼び出しを移植したが **Stage0 だけ漏れた**。

座標系の取り違えは無い（`absorbNearbyAmmo` は logistics.ts:88 で `ammo.state.r` と
`player.state.r` の絶対 ECI 同士を比較しており floating origin は絡まない）。
配列参照も stage.ts:94 で `simulator.ammos` を直接参照しており食い違いなし。

**修正方針**: `stage0.ts` の `update()` 内に
`this.logistics.updateLogistics(simTime, player);` を 1 行追加する（Stage1/2 と同形）。
Stage0 は Wave 方式ではないので `respawnOnDespawn` はデフォルト `false` のままでよい。

**再発防止の提案**: 全ステージ共通の処理なら、各 `update()` に書かせるのではなく
基底 `Stage.update()` 側で呼ぶテンプレートメソッド形式にするほうが漏れにくい。

---

## B3. 【中】RCS の効果音が鳴らない

**症状**: RCS の音が出ない（報告バグ②）。

**根本原因**:
`Sfx.setRcs()`（`src/audio/sfx.ts:459`）は定義されているが、
**コードベース全体で呼び出し箇所がゼロ**（`grep -rn "\.setRcs(" src/` が定義行のみ）。

旧実装（`eb208ed:src/game/game.ts:1577-1592`）:
```ts
const rotating =
  this.player.alive && this.phase === 'playing' && !this.paused &&
  !this.mapMode && lenSq(tau) > 0.01;
this.sfx.setRcs(rotating);        // ← これ
if (!rotating || this.zoomActive) { ... }
```

現行 `src/game/player/rcs-effects.ts:34-35` は**同じ `rotating` 判定を持っているのに
`setRcs` の呼び出しだけが落ちている**:
```ts
const rotating = alive && phasePlaying && !paused && lenSq(torque) > C.RCS_PUFF_TORQUE_EPS ** 2;
if (!rotating || camera.zoomActive) {
```
さらに `RcsEffects` のコンストラクタは `constructor(scene: THREE.Scene)`（rcs-effects.ts:5）で、
**そもそも `Sfx` が注入されていない**。

Sfx 側は健全（`sfx.ts:460-461` の `ctx`/`rcsGain` null チェック、AudioContext resume、
`PlayerThrottle` からの `setThrust()` 呼び出しは正常動作している）。単に呼ばれていないだけ。

**修正方針（どちらか）**:
- (A) 最小差分: `RcsEffects` のコンストラクタに `sfx: Sfx` を追加し、`sync()` の `rotating` 算出直後に
  `this._sfx.setRcs(rotating)` を追加。`player.ts:69` の `new RcsEffects(_scene)` に `this._sfx` を渡す。
- (B) 責務的に綺麗: すでに `_sfx` を持つ `PlayerThrottle` 側で `rotating` 判定と `setRcs` を担当し、
  `RcsEffects.sync()` には bool を渡すだけにする。

---

## B4. 【中】`Enemy.dispose()` が `OrbitLine` を破棄しない

`src/game/orbit-entity/enemy.ts:70-73`:
```ts
dispose(): void {
  super.dispose();
  this.scene?.remove(this.orbitLine.line);   // scene から外すだけ
}
```
`OrbitLine`（`src/render/orbitline.ts`）は **`dispose()` メソッド自体を持たない**ため、
geometry/material を解放する手段がない。撃破・再スポーンのたびにリークする。

同時存在数が少ない（最大 5 隻程度）ため単独では 2 分ブラックアウトの主因にならないが、
Stage00 のウェーブ方式では敵の生成/破棄が繰り返されるため B1 の悪化を加速する。

**修正方針**: `OrbitLine` に `dispose()`（geometry/material 破棄）を追加し、`Enemy.dispose()` から呼ぶ。
B1 の修正と同じ回で入れるのが効率的。

---

## B5. 【中】敵の二重 dispose

`src/game/stages/stage-utils/wave-manager.ts:96-103` が範囲外の敵を
`alive=false` にした直後に自分で `dispose()` を呼ぶ:
```ts
enemy.alive = false;
enemy.dispose();
```
同じフレームで `Game.update()` → `simulator.cleanup()` → `prune()`（simulator.ts:191-199）が
`!x.alive` を見て**もう一度 `dispose()` を呼ぶ**。

現状 `THREE.Object3D.remove()` は非所属オブジェクトに対して例外を投げないので実害は出ていないが、
**B4 の修正で `OrbitLine.dispose()`（＝非冪等な GPU リソース解放）を追加した瞬間に二重解放になる。**
→ B4 と B5 は必ずセットで直すこと。

simulator.ts のコメント上の契約は「`alive=false` にすれば cleanup が回収する」なので、
**`wave-manager.ts` 側の `enemy.dispose()` を削除するのが正しい修正**。

---

## B6. 【中】`consumeFirstNode()` が `PlanEditor.selectedNodeIdx` を追随させない

`plan-guide.ts:53-65` はノード達成時に `plan.consumeFirstNode()` を呼ぶが、
`plan.ts:56-59` の実体は `this._nodes.shift()` のみで、`PlanEditor.selectedNodeIdx` は据え置き。
→ インデックスが 1 つずれる。

現状は `MapModeToggler.open()`（map-mode-toggler.ts:20-27）が毎回 `selectedNodeIdx = null` に
リセットするため顕在化しない。ただし **防御的コードに救われているだけ**で、
将来マップを開く経路が増えるか `open()` のリセットを外すと、
ユーザーが選んでいないノードの Δv を編集してしまう不具合になる。

**修正方針**: `Plan` 側に選択インデックスを持たせるか、`consumeFirstNode()` の戻り値で
消費を通知して `PlanEditor` 側が `selectedNodeIdx` を減算する。
「選択状態の正本が 2 箇所に分散している」のが本質なので、正本の一本化が望ましい。

---

## B7〜B12. 低優先

- **B7** `Ammo`（entities.ts:122-128）も `dispose()` 未実装で `buildAmmo()` 由来のマテリアルが漏れる。
  ただし `MAX_AMMO = 3`、`LOGISTICS_CHECK_INTERVAL = 20s` と低頻度で量的に無視できる。
  B1/B4 と同じ回でついでに直すのが効率的。なお `BeltSection` はメッシュを持たない（`Object3D`）ためリークなし。
- **B8** `MapModeToggler.update`（map-mode-toggler.ts:55-69）は `isPlaying` のみ見て `_isPaused` を見ない。
  `game.ts:187-204` で `handleInput()` はポーズ判定より前に呼ばれるため、**ポーズ中でも `[M]` が効く**。
  コメントは「ポーズ中、死亡後はマップモードを開けない」と読めるので実装と意図が不一致。
  実害は軽微だが、意図がどちらか（ポーズ中に許可したいのか否か）は**人間の判断が必要**。
- **B9** `CollisionPhysics.resolveCollisionPairs`（collision.ts:29-48）は casings（上限 260）+ debris（160）
  + enemies + belt + player の総当たり O(n²)。継続射撃で数万〜十万ペアに達し CPU フレーム時間を圧迫する。
  ブラックアウトの主因ではないが悪化要因。**B1 修正後に `?perf=1` の `sim ms` を見て再評価**すること。
- **B10** `simulator.ts:108-111` の `nSub` 計算にコード上「// 謎実装」とコメントがある。
  `SIM_SPEED_LEVELS=[1,4,16,...]`、`MAX_PHYS_SIM_SPEED=4` のとき、ワープ 16 倍では
  `ceil(simDt/20)=1` となりサブステップ分割が実質発動しない。判定式がフレームレート依存（`dt` を含む）のため
  積分精度が fps に依存して変動する。**確信度低**（実害未実証）。設計意図の確認が先。
- **B11** `physics/orbital.ts:152-163` の `timeSincePeriapsis` は `a<0`（双曲線軌道）で
  `sqrt(MU/a³)` が NaN になる。現在の呼び出し元は `tofBetween` のみで、そこからの実行経路は
  見つからなかった（デッドコードの疑い）。ランデブー機能を実装する際にはガードが必要。
- **B12** `sfx.debrisImpact()`（sfx.ts:406）は**リファクタ前から**未使用。リグレッションではない。
  意図的に鳴らしたい音なら配線、不要なら削除。

---

## 調査で「問題なし」を確認した範囲

念のため、疑ったが健全だった箇所を記録する（再調査の無駄を省くため）。

- `sfx` の他メソッド（`fire`/`playReload`/`spinUp`/`clank`/`magFeed`/`pickup`/`emptyClick`/`hit`/
  `explosion`/`warp`/`altAlarm`/`setThrust`/BGM 系）は全て呼び出し元を確認済み。
- HUD 系（`setStats`/`setTarget`/`showEnd` 等）は grep で消えたように見えるが、
  `hud/panel.ts` の `HudPanels.update`、`hud/result-screen.ts` 等へ**意図的に内部化**されただけ。
  呼び出し配線（game.ts:351、stage.ts:159,191 等）は健全。
- 高度警告・熱制限（旧 `environment.ts` → `player/thermal.ts:73-101`）は EMA・ヒステリシス閾値ごと
  移植済みで `altAlarm()` の呼び出しも維持されている。
- マップモードの三系統同期（`cameraSystem.overviewMode` / `editor.editMode` / `predict.forceCurrent`）は
  `map-mode-toggler.ts` の `setMapMode()` 一箇所に完全集約されており、
  ポーズ・ゲームオーバー・ステージ再出撃（`location.replace` によるフルリロード）のいずれの経路でも
  同期漏れは見つからなかった。
- `npm run typecheck` エラーなし、`npm run test:physics` 41/41 pass。

**未調査で残っている領域**: 網羅的なデッドコード検出（`ts-prune` 等の専用ツール推奨。
今回はヒューリスティックが誤検知だらけで信頼できる結果が出なかった）。

---

## 推奨する修正の進め方（Sonnet への指示単位）

各バッチは独立してレビュー・検証できる単位に切ってある。

1. **バッチ1（最優先・即効）**: B2（stage0 に 1 行追加）+ B3（setRcs 配線）。
   どちらも数行の配線修正で、報告バグ 2 件がそのまま直る。低リスク。
2. **バッチ2（致命バグ）**: B1（ships.ts のリソース共有化 + `Bullet.dispose`）。
   `?perf=1` での実測による検証込みで依頼すること。
3. **バッチ3（リーク周辺の一括整理）**: B4 + B5 + B7 を**必ず同時に**。
   B4 単独で入れると B5 が二重解放として顕在化するため分離不可。
4. **バッチ4（設計整理・任意）**: B6（選択インデックスの正本一本化）。
5. **判断待ち**: B8（ポーズ中の [M] を許可するか）、B9/B10（実測してから）、B11/B12。
   これらは仕様判断が絡むので、実装前に方針を決めること。

---

# 追加調査（2026-07-26 第2回）

B1〜B5 の修正コミット（`75b7d80` / `3ce6e83` / `23bb5db` / `ab133eb`）投入後、
「敵を撃破すると『(敵名) 再突入により喪失』が出てブラックアウト、音が鳴り続ける」
（Stage0 / Stage00 の両方）という報告について調査した結果。

## B13.【致命】`DebrisPiece.dispose()` が共有ジオメトリを破棄する

**確信度: 高（実コードを直接確認済み）**。B1 と同じ「共有リソースの誤破棄」パターンだが、
**B1 とは別の未修正バグ**。今回の症状の主因と考えられる。

**メカニズム**:

`cloneIndependent()`（`src/render/ships.ts:50-62`）は**マテリアルだけを clone し、
geometry はテンプレートと共有したまま**返す（コメントにも明記されている意図的な設計）。

```ts
function cloneIndependent<T extends THREE.Object3D>(template: T): T {
  const clone = template.clone(true) as T;
  clone.traverse((child) => {
    ...
    mesh.material = (mesh.material as THREE.Material).clone();  // material のみ
  });
  return clone;   // geometry は cached テンプレートと同一インスタンス
}
```

ところが `DebrisPiece.dispose()`（`src/game/orbit-entity/entities.ts:175-184`）は
traverse して見つけた mesh の geometry を**無条件に破棄する**:

```ts
dispose(): void {
  super.dispose();
  this.obj.traverse((child) => {
    ...
    mesh.geometry.dispose();          // ← 共有テンプレートの geometry を破棄
    ...
  });
}
```

安全な経路と危険な経路が混在している:

| 生成関数 | geometry | 安全性 |
|---|---|---|
| `buildCasingMesh`（ships.ts:271） | `mesh.geometry.clone()` 済み | **安全** |
| `buildGenericDebris` の chunk 分岐（ships.ts:410） | `mesh.geometry.clone()` 済み | **安全** |
| `buildGenericDebris` の **panel 分岐**（ships.ts:416付近） | clone なし＝**テンプレート共有** | **危険** |
| `buildGenericDebris` の **rod 分岐**（ships.ts:421付近） | clone なし＝**テンプレート共有** | **危険** |
| `buildMagazineFrame`（ships.ts:112-118） | `parseMagazine()` をそのまま＝**共有** | **危険** |

**なぜ致命的か（一度で全滅する）**:
`memoParse` はテンプレートを**モジュールスコープにキャッシュして使い回す**ため、
panel 型デブリが 1 個 dispose された瞬間に `parseDebrisPanel` のテンプレート geometry が死ぬ。
すると **画面上の他の panel 型デブリ全部**に加えて、**以後生成されるすべての panel 型デブリ**も
破棄済みバッファを参照する。復旧不能な一方向の破壊で、WebGPU が破棄済みバッファに触って
device lost → ブラックアウトに至る。

`buildMagazineFrame` はさらに深刻で、`parseMagazine()` のテンプレートは
**自機の弾薬ベルト表示メッシュ（`buildMagazineMesh`）と同じもの**を共有している。
排出された空マガジンのデブリが 1 個 dispose されると、**自機のベルト表示が巻き添えで壊れる**。

**症状との対応**:
- 撃破時は `scatterFragments(..., 11, ...)`（`vfx/effects-system.ts:106`）で 11 個の破片を一気に生成し、
  `MAX_DEBRIS = 160`（const.ts:134）の上限を押し上げる。上限超過時の
  `addCapped` の `arr.shift()!.dispose()`（simulator.ts:70-73）が最初の1個を破棄した瞬間に発火する。
  → 「**撃破した瞬間に**落ちる」「Stage00 では**1分程度経過後**（デブリが上限に達するまでの時間）」に符合。
- デブリの再突入・寿命切れによる dispose でも同様に発火する。

**修正方針（どちらか。前者を推奨）**:
1. `buildGenericDebris` の panel / rod 分岐と `buildMagazineFrame` でも、
   chunk 分岐や `buildCasingMesh` と同様に `mesh.geometry = mesh.geometry.clone()` して個体化する。
2. または `DebrisPiece.dispose()` 側で「このインスタンスが所有する geometry か」を
   フラグ等で判定してから破棄する（`Bullet` / `Enemy` が採る「共有リソースは traverse dispose しない」方針に揃える）。

**再発防止**: `cloneIndependent` が material のみ複製する仕様に対し、
`DebrisPiece` だけが geometry まで破棄するという非対称が根本原因。
「誰がそのリソースを所有しているか」をコードで表現する（所有フラグ、あるいは
生成側で必ず clone を済ませる規約）のが望ましい。

## B14.【高】rAF ループに例外ハンドリングがない

**確信度: 高**。`src/main.ts:63-83` の `animate()` は先頭で `requestAnimationFrame(animate)` を
予約してから `game.update` / `sync` / `render` を呼ぶため、**例外が出てもループは止まらず、
毎フレーム同じ例外を投げ続ける**。描画だけが壊れた状態で回り続ける。

これが B13 のクラッシュを「**ブラックアウトしたまま音が鳴り続ける**」という症状に変換している:
- WebAudio はメインループと独立したオーディオクロックで駆動されるため、描画が壊れても音は止まらない
- 「連射音が不規則」「RCS 噴射音が断続的」= 例外の発生位置がフレームごとに前後し、
  `sfx.fire()` / `setRcs(true/false)` の呼ばれ方が一貫しなくなるため
- 「リロードが重い」= WebGPU device lost からの回復にページ全体の再初期化が必要なため

**修正方針**: `animate()` を try/catch で囲み、例外時は `console.error` に加えて
ループ停止・エラーオーバーレイ表示・SFX 全停止を行う。
根本原因（B13）を直すのが本筋だが、**今後同種の事故の原因究明を容易にするため防御としても入れるべき**。

## 否定できた仮説（再調査の無駄を省くための記録）

- **「撃破した敵自身に再突入判定が走る」→ 否定。**
  `Enemy.attacked()` と `Enemy.checkLoss()` は両方とも冒頭に `if (!this.alive) return;` ガードを持ち
  （enemy.ts:117, :135）、`attacked()` は撃破時に**即座に** `alive = false` を立ててから
  `recordEnemyDeath(this, simTime, true)` を呼ぶ（enemy.ts:128-129）。
  同フレームで後から走る `simulator.cleanup()` の `checkLoss` ループ（simulator.ts:178）は
  即 return するため、再突入分岐（stage.ts:172-174）には構造上到達できない。
- **「dispose 後に state が NaN / 0 になって高度計算が壊れる」→ 否定。**
  `dispose()`（enemy.ts:70-74, entities.ts:81-83）は scene からの除去とリソース破棄のみで
  `state` を一切変更しない。`prune()` は配列から除去した**後**に `dispose()` するので、
  除去済みの敵に `checkLoss` が再度走ることもない（simulator.ts:184-199）。
- したがって「(敵名) 再突入により喪失」は**別の敵が自然に再突入したメッセージ**であり、
  ブラックアウトと同時刻に起きたために同一事象に見えていたと考えられる。
  B13 が発火するのはデブリが蓄積した時点＝プレイ開始から一定時間後で、
  Stage0 / Stage00 の敵が高度低下で自然再突入し始める時間帯と重なる。

## 前回の4コミット（B1〜B5）のリグレッション判定

**リグレッションは見つからなかった。** 4コミットはいずれも本レポートの推奨方針どおりに実装されている。
ただし **B1 の修正で「約72秒でのブラックアウト」が解消され、プレイがそれ以上継続できるようになった結果、
B13（デブリ蓄積後に発火）が初めて表面化するようになった**可能性が高い。

**要確認**: 今回の報告が **4コミット投入前のプレイ**によるものである可能性がある
（`memos/dev.md` の記述時刻と修正コミットの時刻が同日）。
再ビルドした現行版で再現するかどうかを先に確認すること。
再現する場合は B13 が主因、再現しない場合でも B13 のコード欠陥自体は実在するので修正は必要。
