# 調査: 表示マガジン数が所持数と食い違って見える件

ヘッドレス Chrome + CDP でステージ1を実機駆動して計測した結果。修正は未実施。
ベルトの実装そのものの説明は [BELT.md](BELT.md)。

## 結論(先に)

**本命は `BeltPhysics` の発散**。旋回すると節点位置が指数的に増大して Inf → NaN になり、
**18節点のうち17個が NaN で固定**される。NaN 位置のリンクは描画されないため、
機体に固定されている先頭の2本だけが残る ——「8連あるのに2連しか表示されない」の正体。
**一度 NaN になると自己回復する経路が無い**(復帰手段が全部 NaN 比較で無効化される)。
発砲は一切不要で、旋回だけで起きる。

副次的な要因が2つ(こちらは所持数と表示の食い違いではなく、数えにくさ・在庫の減り):

- [R] 手動リロードが満タンのマガジンを1本破棄する(所持数そのものが減る)。
- 給弾が進むと先頭マガジンが機体に埋まり、常時1本少なく見える。

## 計測方法

`main.ts` に一時的に `window.game` を生やして(計測後に撤去済み、`src/` に差分なし)、
CDP から `belt.physics` の内部状態を毎フレーム読み、さらに `BeltPhysics.prototype` の
各フェーズを monkey-patch して**フェーズごとの最大 |beltPos| の増幅率**を記録した。

---

## 1【本命】BeltPhysics が発散して NaN で固着する

### 再現(発砲ゼロ)

ステージ1開始 → 補給で8連にする → 発砲せずに操作を与えるだけ:
ロール[U] 4秒 → ピッチ[I] 4秒 → ヨー[L] 4秒 → 推力[W] 4秒 → **ロール[U]+ピッチ[I] 同時 4秒**。

最後の同時入力(w ≈ (0.42, 0, −0.42) rad/s)で発散した。節点間隔 `segLen` の推移:

| 操作 | segLen(リンク0..7) |
| --- | --- |
| 無操作 | 4.18 ×8(正常) |
| ピッチ単独 | 4.18, 4.20, 5.03, 4.94, 4.16, 4.28, 4.26, 4.23 |
| **ロール+ピッチ** | 4.18, **9.4e38, 3.6e39, 1.1e40, 2.8e40, 6.8e40, 1.6e41, 3.5e41** |
| その次のフレーム以降 | 4.18, NaN, NaN, NaN, NaN, NaN, NaN, NaN(以後ずっと) |

このとき HUD は `32/32 +8連`(薬莢0=未発砲)、画面上のベルトは**2本ぶんの短い塊**だけ。

### 発散源は `advanceOrientationConstraints`

フェーズ別の最大 |beltPos| 増幅ログ(発散フレーム前後):

```
advanceOrientationConstraints  58.9   → 601
advanceOrientationConstraints  258    → 10400
advanceOrientationConstraints  2710   → 17300
integrateVerlet                5560   → 8580
advanceOrientationConstraints  3830   → 785000
advanceOrientationConstraints  266000 → 3140000
advanceOrientationConstraints  692000 → 481000000     → … → 1.0e45 → Inf → NaN
```

増幅はほぼ全部 `advanceOrientationConstraints`(`belt-physics.ts:207`)で起きている。原因はこのループ:

```ts
let prevPoint = this.anchor;
for (let i = 0; i < this.linkCount; i++) {
  const rawDir = sub(this.beltPos[i]!, prevPoint);
  const segLen = len(rawDir);            // ← すでに動かした prevPoint からの距離
  ...
  const newPos = addScaled(prevPoint, clampedDir, segLen);   // ← その距離をそのまま採用
  this.beltPos[i] = newPos;
  prevPoint = this.beltPos[i]!;
}
```

`prevPoint` は**このループ内で既に補正済みの節点 i−1**。節点 i−1 をクランプで動かすと、
節点 i から見た `rawDir` は `MAG_BELT_PITCH` より長くなり、そのまま `segLen` として
「その長さで置き直す」ため、**1回のパスの中で誤差がリンクを下るごとに掛け算で増幅する**。
上の表でリンクごとに 3〜4 倍ずつ伸びているのがそれ。

火種は `clampDirectionToPrevFrame` の `lx = Math.max(local.x, 0.001)`。継手の折れ角上限は
前リンク基準の相対値なので累積し(実測で機体+X軸から 31° → 62° → 93° → 124° → 156° → 173°)、
90° を超えた継手では `local.x` が負になる。それを 0.001 に潰すと方向がほぼ前リンクの +X へ
反転し、節点が最大 2·segLen ぶんワープする。

さらに、この書き戻しは **`beltPrevPos` も同量だけ平行移動して Verlet 速度を保存する**
(`belt-physics.ts:229`、コメントで「【重要】」と明示されている意図的な処理)。
そのため注入された巨大な速度が次フレームへ持ち越され、遠心力 `-ω×(ω×r)` と
オイラー力 `-α×r` が |r| に比例するので正のフィードバックになり、数フレームで overflow する。

### NaN から回復できない

`Infinity - Infinity` で NaN 化すると、復帰経路が全部無効になる:

- `relaxDistanceConstraints`: `if (dist < 1e-6) continue;` は `dist = NaN` では **false** なので
  そのまま `corr = NaN` を計算し、節点は NaN のまま。
- `resetIfFolded` / `isFolded`: `lenSq(...) < minSq` は NaN では **false**。
  「絡まっている」と判定されず、直線への再整列が永久に走らない。
- `pinRootToAnchor` が毎フレーム上書きするのは `beltPos[0]` だけ。だから
  **節点0のみ有限、1〜17は NaN** という観測結果になる。

`Belt.sync` はその節点をそのまま `link.position.set(...)` へ流すので、リンク2以降は
NaN 行列となり描画されない。**リンク0(アンカー)とリンク1(節点0)だけが残って「2連」**。
`visibleCount` 自体は `mags` に忠実(前回調査のとおり)なので、`link.visible` は true のまま
——「表示されているはずなのに見えない」状態になる。

`NanWatchdog` は `Simulator` のエンティティ状態を見るだけでベルトを見ていないので警告も出ない。
`collision.ts` は `if (!Number.isFinite(distSq)) return false;` で守られているため、
NaN が `BeltSection` 経由で自機や薬莢へ伝播することは無い(そこは既存のガードが効いている)。

### 修正方針の候補(未実施)

- `advanceOrientationConstraints` で `segLen` に `MAG_BELT_PITCH` を使う(または
  `min(segLen, PITCH * k)` でクランプする)。誤差の掛け算増幅はこれで止まる。
- 折れ角上限を前リンク相対だけでなく**機体+X軸からの累積角**でも制限し、
  `local.x < 0`(90°超え)が起きないようにする。
- 書き戻し時に速度を保存せず減衰させる(位置補正で注入されたエネルギーを捨てる)。
- 保険として、`update` の末尾で非有限を検出したら `resetIfFolded` と同じ直線再整列を行う
  (`isFolded` に `!Number.isFinite` の判定を足す)。NaN 固着からの自己回復手段が現状ゼロなので、
  根治とは別にこれは要る。

---

## 2 [R] 手動リロードが満タンのマガジンを破棄する

`player-fire.ts:185`:

```ts
const canReload = this.mags > 0 && (this.rounds < C.MAG_ROUNDS || this.barrel < C.MAGS_PER_BARREL);
```

`||` の後半のせいで、**装填中が満タン(32/32)でもバレル残が減っていればリロードが成立し、
マガジンを1本消費する**。得るものは無い(`rounds` は 32 のまま)。

| | mags | rounds | barrel |
| --- | --- | --- | --- |
| [R] 前 | 10 | 32 | 2 |
| [R] 後 | **9** | 32 | 3 |

`barrel = 3` なら正しく拒否される。つまり**マガジンを1本でも消費した直後から次のバレル交換までの
間、[R] は常に「効く」**。弾数収支の実測(消費 = `mags*32+rounds` の減少、発射 = `scoreCounter.shots`):

| 操作 | 消費弾数 | 発射数 | 差分 |
| --- | --- | --- | --- |
| 8秒連射 | 101 | 101 | 0 |
| 断続射撃×6 | 111 | 111 | 0 |
| 射撃→[R] ×4 | 140 | 80 | **60** |

自動給弾・自動バレル交換は収支が完全に合う。中途半端に減ったマガジンを [R] が捨てるのは
実銃どおりで仕様として妥当だが、**満タンでも捨てる**のは誤り。

## 3 先頭マガジンが機体に埋まって常時1本少なく見える

`anchor = 0.9 - beltFeed * MAG_BELT_PITCH`(`beltFeed = 1 - rounds/32`)。
`Belt.sync` はリンク i を手前ノード(リンク0はアンカー)に置くので、`feed` が 1 に近づくと
`anchor ≈ -3.28` まで動き、先頭リンクが左舷側へ丸ごと潜る。実測でも anchor は
+0.9 〜 −0.93 を周期的に往復していた。マガジンを1本消費して `feed` が 1→0 に戻ると再び現れる。

## 4 補足

- 表示リンク数 `visibleCount = min(mags, 18)` は約1300フレームの監視で `mags` に忠実だった
  (不一致は各1フレームのみ、`Player.behave` 内の呼び出し順による遅れ)。
- `BELT_MAX_VISIBLE = 18` を超える所持数は表示されない(補給1個で +4 連なので到達しうる)。
- カールしたベルトは遠側リンクのスクリーン間隔が手前の 1/2 以下に圧縮され、
  3D 的には正しく並んでいても画面上は数えられない。`resetIfFolded` のしきい値
  `MAG_BELT_PITCH * 0.5 ≈ 2.09 m` はマガジン長 `MAG_WIDTH = 4.0 m` より小さいので、
  見た目に重なっていても絡まりとは判定されない。
