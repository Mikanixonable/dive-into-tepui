# マガジンベルトの現在の挙動

自機左舷(+X)に垂れ下がる予備マガジンの連鎖の挙動を、実装から読み取れる事実として
まとめたもの。責務の一次情報は `CLAUDE.md` / `OWNERSHIP.md` / `CALLSTACK.md`、
ここは「実際に何が起きているか」の記述。

## 構成

| ファイル | 責務 |
| --- | --- |
| `src/game/vessel/belt-physics.ts` (`BeltPhysics`) | Vec3/Quat だけの算術。節点位置 `beltPos` / 前フレーム位置 `beltPrevPos` / ねじれ角 `beltTwist` / 根本アンカー `anchor` を持つ |
| `src/game/vessel/belt.ts` (`Belt`) | リンクメッシュ(`THREE.Group` × `BELT_MAX_VISIBLE`)の所有、給弾進み `feed` と可視リンク数 `visibleCount` の導出、物理結果からの姿勢導出とメッシュ反映 |
| `src/render/ships.ts` | `buildMagazineMesh()`(4×8=32 発が見えるケージ。原点は平たい直方体 X 4.0 × Y 1.0 × Z 3.0 の中心)、`MAG_BELT_PITCH = MAG_WIDTH + 0.18`、給弾口の位置 `MAG_BELT_ANCHOR_X` |
| `src/game/vessel/belt-physics.ts` (`BeltSection`) | 剛体接触用プロキシ。`mass = 5`, `radius = 0.8`, `collides = true` |

`Belt` は `Vessel` が所有(`vessel/vessel.ts` の `new Belt(this.renderObject, this)`)。リンク群は
`vessel.renderObject` の子なので、機体の位置・姿勢は THREE の親子関係で自動的に付いてくる。
物理はすべて**機体座標系**(機体原点基準)で解かれる。

## 毎フレームの流れ

- update フェーズ: `Vessel.updateControls` → `Belt.update(dt, mags, rounds, att, thrustAccelVec)`
  (`vessel/vessel.ts`)
- update フェーズ: `ContactPhysics.resolveBelt` → `belt.collisionSections(...)` で
  ワールド ECI のプロキシを渡し、解決後 `belt.applyCollisionSections(...)` で書き戻す
  (`contact.ts` の `resolveBelt`)。実 dt(非ワープ)で1フレーム1回だけ、
  `simSpeedManager.canResolvePhysicalCollisions` が真のときのみ。substep ごとに解決される他の
  剛体接触(弾・薬莢・放熱板など)とはここだけ異なるタイミングで走る。
- sync フェーズ: `Vessel.syncVessel` → `Belt.sync()`(`vessel/vessel.ts`)

## 可視リンク数と給弾(`Belt.update`)

- `visibleCount = min(magsLeft, BELT_MAX_VISIBLE=18)`。リンクメッシュは常に 18 個
  存在し、`sync` で `visible` を切り替えるだけ(生成・破棄はしない)。`alive === false`
  なら全リンク非表示。
- `targetFeed = 1 - roundsInMag / MAG_ROUNDS(32)`。通常は
  `feed += (targetFeed - feed) * min(1, dt*12)` の指数追従で、ベルトが連続的に
  機体へ吸い込まれていくように見える。
- マガジンを1本消費して `targetFeed` が 0 側へ飛ぶ(`targetFeed < feed - 0.5`)と、
  `BeltPhysics.shiftBeltNodes()` を呼んで節点を1つ前詰めし、`feed` を即座に
  `targetFeed` へスナップする。可視リンク数が1減るのと同時に feed が 1→0 へ
  巻き戻るので、見た目は途切れない。
- `shiftBeltNodes` は末尾に新節点を追加する。位置は「前の末尾の速度を引き継いだ
  外挿 + `MAG_BELT_PITCH`」で、`beltPrevPos` は同値(速度ゼロ)。この節点は追加直後に
  非表示側へ回るので精度は問われない。

## たわみの物理(`BeltPhysics.update`)

自由落下中なので重力は効かない(等価原理:ベルトも機体も同じく落ちる)。
唯一の駆動力は**機体の非慣性系で感じる擬似力**で、節点位置 `r`・Verlet 速度 `v` に対し

```
a = -a_thrust - α×r - ω×(ω×r) - 2ω×v
```

(並進慣性・オイラー力・遠心力・コリオリ力)。`a_thrust` は `Vessel` から渡される
ワールド系推力加速度を `qRotate(qInvert(att.q), ...)` で機体系へ回したもの。
`α` は `att.w` の前フレーム差分(`prevShipW`)から推定。
**推力も回転もなければベルトは真っ直ぐ垂れたまま動かない**(環境揺らぎの演出は無い)。

処理順:

1. `initNodesOnce` — 初回のみ `x = MAG_BELT_ANCHOR_X + (i+1)*PITCH` の直線に配置、twist は 0。
2. `estimateAngularAccel` — `α = (w - prevW)/dt`。
3. `integrateVerlet` — 積分刻みは `h = min(dt, 0.05)` にクランプ、減衰 `damping = 0.95`。
   コリオリ項の速度換算は `h` ではなく実 `dt` を使う(`inv2Dt = 2/dt`)。
4. `pinRootToAnchor(feed)` — `anchor = (MAG_BELT_ANCHOR_X - feed*PITCH, 0, 0)`。リンク0は
   `anchor + PITCH·+X` に**毎フレーム強制**し、`beltPrevPos[0]` も同値にして
   速度を殺す。よって根本の継手は常に機体に垂直で、揺れるのはリンク1以降だけ。
5. `relaxDistanceConstraints` — 6反復の position-based dynamics。リンク間隔を
   `MAG_BELT_PITCH` に収束させる。`i === 0`(参照 = アンカー)と `i === 1`
   (参照 = 固定された根本)は片側だけ補正、それ以外は 0.5 / 0.5 で両側に分配。
6. `resetIfFolded` — 非隣接リンク同士(|i-j| ≥ 2)の距離が `PITCH*0.5` 未満なら
   絡まったと見なし、**アンカーから** +X 方向の直線へ全リンクを整列し直す(速度・twist もリセット)。
   非有限値(NaN/Infinity)を含む場合も同じ整列の対象になる。判定は O(n²) の総当たり。
7. `advanceOrientationConstraints` — 下記の角度制限とねじれ積分。
8. `resetIfFolded`(2回目) — 角度クランプが節点位置を書き換えるため、その後にもう一度検査する。
   非有限値は距離拘束・絡まり判定の比較が軒並み false になって素通りするので、ここで拾わないと
   以後ずっと固着してリンクが描画されなくなる。

## 曲げ角の制限とねじれ

`advanceOrientationConstraints` は**節点位置そのものを補正する**(見た目だけの補正ではない)。

- 前リンクのローカル系(+X = 進行方向)に方向ベクトルを移し、
  `y/x` をヨー、`z/x` をピッチとして `tan(上限角)` でクランプ、再正規化して戻す。
  上限は `MAG_CHAIN_MAX_PITCH_DEG = 30`(上下)/ `MAG_CHAIN_MAX_YAW_DEG = 10`(左右)。
  `local.x` はゼロ割回避のため最低 0.001。
- 書き戻す位置は `前点 + クランプ済み方向 × MAG_BELT_PITCH`。**長さに実測値を使わないのは、
  前点がこのループ内で既に補正済みの節点だから** — 補正で伸びた実測長をそのまま採用すると
  誤差がリンクを下るごとに掛け算で増幅し、数フレームで Infinity/NaN へ発散する。
- クランプ後の位置を書き戻す際、`beltPrevPos` も同じ平行移動量だけずらして
  Verlet 速度 `pos - prevPos` を保存する。
- ねじれ(リンク自身の +X まわりのロール、平行移動フレームが決められない自由度)は
  `beltTwist[]` に明示保持。発生源は機体のロール角速度
  `att.w.z * MAG_CHAIN_ROLL_GAIN(0.6)` で、リンク0は常に twist = 0(完全固定、
  ただし伝播用シードはそのまま次へ渡す)。リンク1以降は前リンクの値を目標に
  `lerp(min(1, dt*MAG_CHAIN_ROLL_RATE(3.5)))` で追従し、毎フレーム
  `±MAG_CHAIN_MAX_ROLL_DEG(15°)` にクランプされる。目標値も渡す前にクランプ済みなので
  上限を超えることはない。

## 姿勢導出とメッシュ反映(`Belt.sync`)

**節点は継手(マガジンの端面)を表す。** マガジンは前後2節点の間に架かる剛体棒なので、
メッシュ原点(平たい直方体の中心)は `position = (prevPoint + beltPos[i]) / 2`
—— 線分の中点 —— に置く(`prevPoint` は前の節点、リンク0はアンカー)。
こうすると曲げたときに各マガジンは隣とは共有する端面を軸に回る。
節点間隔 `MAG_BELT_PITCH = 4.18` に対し箱の長さ `MAG_WIDTH = 4.0` なので、
端面と継手の間には片側 0.09 の逃げがある。向きは平行移動(parallel transport):

```
bendQ = qFromUnitVectors(qRotate(prevQ, +X), dirUnit) * prevQ
q     = bendQ * qFromAxisAngle(+X, beltTwist[i])
```

`prevQ` の初期値は単位クォータニオン(= 機体の +X 方向)。曲げにねじれは混入せず、
ロールは `beltTwist` 経由でのみ入る。`Belt.sync` は `BeltPhysics` が
`advanceOrientationConstraints` 内で使ったのと同じ計算を独立に再実行する
(物理側は prevQ を保持しない)。

## 剛体接触との受け渡し

`BeltSection` はリンクごとに永続保持されるプロキシ(`BeltPhysics.sections`、遅延生成)。

- `collisionSections(dt, baseR, baseV, att)`:
  `r = baseR + q·beltPos`、`v = baseV + q·(v_verlet + ω×beltPos)`
  (`v_verlet = (pos - prevPos)/dt`)。
- `applyCollisionSections(...)`: 逆変換して `beltPos` を書き戻し、
  `beltPrevPos = beltPos - v_verlet*dt` として Verlet 速度を復元する。
- 衝突が起きなければこの往復は恒等変換で、Verlet 状態は変化しない。
- `BeltSection.contactsWith` が吊り元の艦と、それに取り付いた実体(他のベルト節点・放熱板の折り)を
  落とす。よってベルトが当たる相手は薬莢・敵・補給・デブリのみで、除外の判断は接触を列挙する `simulation/contact.ts` ではなく当事者側にある。

## 主要定数

| 定数 | 値 | 効果 |
| --- | --- | --- |
| `MAG_ROUNDS` | 32 | 1マガジンの装弾数。`feed` の分母 |
| `BELT_MAX_VISIBLE` | 18 | リンクメッシュ数 = 物理節点数 |
| `MAG_BELT_PITCH` | `MAG_WIDTH + 0.18` | 継手の間隔 = 距離拘束の目標長。角度クランプの書き戻し長にも使う |
| `MAG_BELT_ANCHOR_X` | −1.19 | 給弾口(= 先頭マガジンの機体側の端面)の X 位置 |
| `MAG_CHAIN_MAX_PITCH_DEG` / `_YAW_DEG` / `_ROLL_DEG` | 30 / 10 / 15 | 継手の角度上限 |
| `MAG_CHAIN_ROLL_GAIN` / `_ROLL_RATE` | 0.6 / 3.5 | ねじれの発生量と追従速度 |
| `BeltSection.mass` / `radius` | 5 / 0.8 | 接触プロキシの物理諸元 |
| Verlet 減衰 / 拘束反復 / 積分刻み上限 | 0.95 / 6 / 0.05 s | `belt-physics.ts` 内のハードコード値 |

## 気づいた点(挙動そのものではない観察)

- `belt-physics.ts` の `(newLast)` のような**無意味な括弧**がいくつか残っている
  (基底データは不変なので代入自体は正しい)。
- `ships.ts:48-49` のコメントが「`MAG_BELT_PITCH` は game.ts が使う」と書いているが、
  実際の参照は `vessel/belt.ts` と `vessel/belt-physics.ts`。
- `resetIfFolded` の O(n²) は n = 18 なので毎フレーム 136 ペアと軽微。毎フレーム2回走る。
- 継手の折れ角上限は前リンク基準の相対値なので**角度は継手ごとに累積**し、機体 +X 軸から見た
  折れ角に上限は無い(実測で 90° 超えまで曲がる)。カールすると遠側のマガジンがスクリーン上で
  重なって数えづらい。`resetIfFolded` のしきい値 `MAG_BELT_PITCH * 0.5 ≈ 2.09 m` は
  マガジン長 `MAG_WIDTH = 4.0 m` より小さいので、見た目に重なっていても絡まりとは判定されない。
