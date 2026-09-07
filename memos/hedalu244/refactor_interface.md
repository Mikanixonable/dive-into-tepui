# 依存グラフの単純化 — 段 A・段 B を実施したあとの現況

測定時点: `9d3c20e1`(branch `workspace4`, 2026-09-08)。着手前は `e66c32fe`。
以下の数字はすべてこの2点の `src/` を**同じスクリプトで**機械的に走査して出したもので、
**コードが動けば古くなる。** 再測定の手順は末尾「測り方」に置く。

段 A(型の置き場所)と段 B(具象型で受けるのをやめる)は実施済み。**段 C は未着手。**

---

## 0. 結論(先に)

**型の工夫で取れるものはほぼ取り切った。残っているのは責務の向きの問題だけになった。**

| 指標 | 着手前 | いま |
| --- | --- | --- |
| 強連結成分(全辺) | **153**, 9, 4, 2, 2 | **150**, 2, 2, 2 |
| 強連結成分(値の辺だけ) | **22**, 3, 2 | **8**, 3, 2 |
| 最大 SCC を解く帰還辺 | 119 / 内部 857(型のみ 63) | 98 / 内部 747(型のみ 54) |
| ts ファイル / 辺 | 515 / 3,008 | 526 / 3,068 |

**読み方が2つある。**

- **値の辺で見た循環は 22 → 8 に落ちた。** ここが本当の進捗で、
  「型の工夫で到達できる下限」と見ていた 22 を下回っている。残った 8 は
  自機・武装・エンティティが互いを `new` する相互所有で、**インターフェイスでは直らない。**
- **全辺で見た最大の塊は 153 → 150 でほとんど動いていない。** 型を葉へ追い出しても、
  その型を引く側も同じ塊の中に居るなら、塊の大きさは変わらない。

**`physics/` の 9-SCC と `hud/windows/` の 4-SCC は消えた。** 残る 2 は3つとも
「互いに相手を値で必要とする2ファイル」で、性質が違う(§4)。

---

## 1. 何が効いて、何が効かなかったか

**これが今回いちばん学びのあった数字。** 同じ「型を葉へ移す」でも、効果が二極化した。

### 効いたもの — 塊の外に居るファイルを切り離す

推移的依存が減ったファイルは **69 個**。上位はすべて、**塊の外に居るのに hub の型を1つ
引いていたせいで塊ごと背負っていた**ファイル。

```
game/player/altitude-alarm.ts              462 → 9    (-453)
game/pickable/line-pickable.ts             462 → 9    (-453)
game/pickable/body-search-text.ts          462 → 26   (-436)
game/dynamic/sim-speed-manager.ts          462 → 15   (-447)
game/lines/trajectory-line.ts              462 → 39   (-423)
game/celestial/celestial-entity/ring-view.ts 462 → 40 (-422)
```

`line-pickable.ts` は import が4本しかないのに、そのうち1本
(`ProjectFn`)のせいで `src/` の 9 割を引いていた。`altitude-alarm.ts` は `Hud` 1本で
同じことになっていた。**この形が段 A・段 B の本命だった。**

### 効かなかったもの — 塊の内側での引っ越し

推移的依存が増えたファイルは 184 個あるが、**うち 178 個がちょうど +11**
(= 今回新設した葉ファイル 11 枚ぶん)で、**中身は1つも増えていない。**
150-SCC の中に居るファイルは、塊の全部と塊より下の全部を引くので、
**塊が解けるまでこの数字は動かない。**

だから次のような変更は、正しい直し方ではあっても**推移的依存には効かなかった**:

- `EntityRegistry` / `SpawnGate` を `dynamic-system.ts` から葉へ(引く側 14 ファイルが全部塊の中)
- `MapListSection` / `ObjectPickerGenre` を表示側から申告側へ(同上)
- 天体の宣言型を `celestial-motion.ts` から `celestial-body-def.ts` へ(同上)
- `ObjectPickable` を4面へ割る(受け手も塊の中)

**やる価値が無かったという意味ではない** — 契約は読みやすくなり、責務の置き場所は正しくなった。
ただ**「依存グラフを軽くする」目的で測るなら、効くのは塊の外に居る受け手を切るときだけ。**

---

## 2. いまの hub

`importer(うち型のみ)/ 自分の import 数` を、着手前 → いま で並べる。

| モジュール | 着手前 | いま |
| --- | --- | --- |
| `physics/celestial-motion.ts` | 82(27)/ 15 | **26(0)/ 15** |
| `game/celestial/celestial-system.ts` | 65(62)/ 42 | **36(33)/ 43** |
| `game/camera/camera-system.ts` | 42(26)/ 18 | 31(18)/ 18 |
| `game/dynamic/dynamic-entity/controllable.ts` | 39(38)/ 15 | 26(25)/ 14 |
| `game/dynamic/dynamic-system.ts` | 33(29)/ 30 | 20(16)/ 31 |
| `game/pickable/object-pickable.ts` | 32(24)/ **19** | 22(15)/ **8** |
| `game/hud/hud.ts` | 31(11)/ 17 | **12(5)/ 18** |
| `game/game.ts` | 17(13)/ 50 | 12(8)/ 50 |
| `game/player/player.ts` | 22(6)/ **67** | 20(4)/ **67** |
| `game/dynamic/dynamic-entity/dynamic-entity.ts` | 41(24)/ 44 | 42(25)/ 45 |
| `game/stages/stage.ts` | 37(27)/ 25 | 39(29)/ 26 |
| `game/marker/marker-manager.ts` | 30(26)/ 11 | 30(26)/ 11 |

**下がっていないのが `player.ts`(out 67)・`game.ts`(out 50)・`dynamic-entity.ts`(out 45)・
`stage.ts`(out 26)。** どれも「入ってくる型」ではなく「出ていく値」が多い。
**型の面では手が付けられない** — これが段 C の正体。

`marker-manager.ts`(30 importer)は今回まったく動いていない。使われるのは
`shows` / `hide` / `setPosition` 中心なので、同じ手が効く余地がある。

### 今回入れた面

| 面 | 場所 | 何を答えるか | 葉か |
| --- | --- | --- | --- |
| `CelestialBody` / `OrbitingCelestialBody` / `EphemerisBody` / `CelestialMotions` | `physics/celestial-body.ts` | 天体1体の状態・姿勢・暦と、星系の一覧 | 葉(推移的 5) |
| `CelestialBodies` | `game/celestial/celestial-bodies.ts` | 星系の名前・系統・状態 | 葉(推移的 22) |
| `OrbitingObject` | `game/dynamic/dynamic-entity/orbiting-object.ts` | 個体の位置・同一性・接触軌道 | 葉(推移的 8) |
| `Notifier` | `hud/notifier.ts` | 一時的な告知(hint / toast) | 葉(推移的 0) |
| `EntityRegistry` | `game/dynamic/entity-registry.ts` | 生んだ個体を顔ぶれへ入れる口 | 塊の中 |
| `PickCandidate` | `game/pickable/pick-candidate.ts` | 候補の芯(名前・記号・位置) | **葉(推移的 3)** |
| `ListedObject` | `game/pickable/listed-object.ts` | 一覧・選択ウィジェットへの申告 | **葉(推移的 27)** |
| `InspectedObject` | `game/pickable/inspected-object.ts` | 窓に出す中身 | 塊の中(推移的 473) |
| `MapPickable` | `game/pickable/map-pickable.ts` | マップでの候補と掴み | 塊の中(推移的 473) |

**`ObjectPickable` の4面のうち、葉になったのは2面だけ。** 窓とマップの面は引数の型
(`ObjectWindows` / `PlanEditor` / `ControlSelection` / `MarkerManager`)が塊の中にあるので、
面を割っても葉にならない。**面を割る前にそれらの置き場所を直す必要がある。**

---

## 3. 残った循環(全辺)

```
150  src/game/ の本体
  2  physics/celestial-motion.ts ↔ physics/planet-system.ts
  2  render/protein-ribbon.ts ↔ render/protein-ribbon-color.ts
  2  game/protein/protein-asset-catalog.generated.ts ↔ protein-asset-loader.ts
```

**残る 2 は3つとも「互いに相手を値で必要とする2ファイル」で、型の面では直らない。**

`celestial-motion ↔ planet-system` は、恒星が惑星系(`PlanetSystem`)を持ち、惑星系が
`new PlanetMotion(...)` で本体の運動を作る相互所有(`planet-system.ts` の生成関数)。
`PlanetSystem` の生成をどちらの持ち物にするかを決めれば切れる。

**150-SCC を解くのに切る必要がある辺は 98 本**(内部 747 辺のうち。近似最小フィードバック辺
集合。貪欲法なので実行ごとに ±2 本ぶれる)。**うち 54 本が型のみ**で、着手前(119 本中 63 本)
からあまり減っていない。逆流の宛先:

```
15  game/player/player.ts
 7  game/dynamic/dynamic-system.ts
 7  game/dynamic/dynamic-entity/enemy.ts
 7  game/game.ts
 6  game/stages/stage.ts
 5  game/camera/camera-system.ts
 4  game/celestial/celestial-system.ts
 3  game/dynamic/dynamic-entity/controllable.ts
 3  game/dynamic/dynamic-entity/dynamic-entity.ts
 3  game/plan/plan-editor.ts
```

**一番の逆流先は変わらず `Player` と `Game`。** `memos/hedalu244/refactor_game.md` が扱って
いる問題と同じものの別の断面。

ディレクトリ単位で相互 import している対は 85 → 81。**`game/dynamic/dynamic-entity` が
4つの対に出てくる**(`game/dynamic` 18/22、`game/player` 16/23、`game/marker` 22/9、
`game/pickable` 14/13、`game` 20/8)。フォルダの境界が依存の境界になっていない。

---

## 4. 段 C — 残った値依存(未着手)

値の辺だけで見た循環は3つ。**着手前の 22 が 8 まで落ちたので、輪郭がはっきりした。**

### 4.1 自機・武装・エンティティの相互所有(8ファイル)

```
player.ts  fire-control.ts  attached-boosters.ts  belt.ts  ammo-status.ts
bullet.ts  debris-piece.ts  enemy.ts
```

閉じている辺(値):

```
player          -> bullet / debris-piece / attached-boosters / belt / fire-control / ammo-status
fire-control    -> bullet / debris-piece / player
attached-boosters -> debris-piece / player
belt            -> fire-control
bullet          -> enemy / player
debris-piece    -> bullet / player
enemy           -> bullet / debris-piece
ammo-status     -> fire-control
```

**着手前にここを閉じていた `player → hud/hud.ts` と `fire-control → hud/hud.ts` は
`Notifier` で消えた。** 残っているのは、
**撃つ側・撃たれる側・生成物(弾・破片)が互いを直接 `new` している**構造そのもの。

- `player → hud/ammo-status.ts → fire-control` の輪だけは性質が違う。HUD の整形関数が
  弾倉容量の定数を `fire-control` から引き、`player` がその整形関数を呼んでいる。
  **弾薬の諸元(容量・表示単位)を葉へ切り出せば切れる。規模 S。**
- 残りは **「誰が弾や破片を生むか」の置き場所の問題。** 生成を `EntityRegistry` 越しの
  依頼に寄せる(生む側が具象クラスを知らない)形にできるかが論点。**規模 L。**

### 4.2 基準系パネルの相互参照(3ファイル)

```
frame-controls.ts ↔ camera-frame-panel.ts / trajectory-frame-panel.ts
```

親(`frame-controls`)から `buildPanel` を子が引き、子を親が組んでいる。
**共有ヘルパを葉へ出せば切れる。規模 S。**

### 4.3 表示窓と予測パネル(2ファイル)

```
display-window-manager.ts ↔ hud/panels/predict-panel.ts
```

定数と型の相互参照。**規模 S。**

### 4.4 型では直らないが、面の分割が待っているもの

`InspectedObject` / `MapPickable` を葉にするには、`ObjectWindows` / `PlanEditor` /
`ControlSelection` / `MarkerManager` が塊から出ている必要がある。
**4.1 と同じ「責務の向き」の問題なので、そちらを先に決める。**

---

## 5. 「何でもインターフェイスにすべきではない」への答え

**判定は `DEVELOP/CODING-RULE.md` 1.12 に条文として入れた**(narrow か / 葉に置けるか /
契約の写しでないか)。ここでは、今回それを当ててみて分かったことだけを残す。

- **判定2(葉に置けるか)は事前に必ず確かめること。** 今回、
  `ObjectPickable` の4面のうち2面、`EntityRegistry` は葉にならなかった。
  **葉にならない面を作っても、循環にも推移的依存にも効かない。**
- **`EnemyClass` は移せなかった。** `new (...): Enemy` を含む静的側インターフェイスなので
  `Enemy` 自身を引く。判定2に落ちる例。
- **判定1(narrow か)は「メンバ数」で測らないほうがよい。** `CelestialSystem` は
  28 メンバ中 17 メンバを `CelestialBodies` へ出した(数の上では半分残っている)が、
  **`render/` と THREE を引き連れるメンバを全部落とせた**ので効果は大きかった。
  数ではなく、**落とせる依存の重さ**で測る。
- **面に `CelestialBodyDef` のような「宣言の全体」を入れると循環が戻る。**
  天体の読み取り面は `def` を `{ id, mu, radius }` だけに絞ってある。
  面 → `celestial-body-def` → `kepler-orbit` → `elements` → 面 の輪ができるため。
- **面が配列や集合を答えるときは、要素の型も面にする。** `CelestialBodies` は
  最初 `celestialMotions: readonly CelestialMotion[]`(具象クラス)を継いでいて、
  受けた 30 ファイルが結局 `celestial-motion.ts` を背負っていた。**要素が具象なら面は葉にならない。**
- **「1メンバも触らない引数は消せる」は、この規模のコードでは成り立たなかった。**
  `celestialSystem` を受けて1メンバも使っていない 18 ファイルを調べたが、**全部が
  渡した先で実際に使われていた。** `CODING-RULE` 1.3 の「渡した先に作らせる」は、
  星系や HUD のように**1つしかない持ち物**には効かない。消すのではなく、
  渡した先が要る一番狭い面まで**連鎖で狭める**のが正しい直し方。

**インターフェイス以外の道具も効いた。** 天体を選ぶだけの `selectShadowBodies` /
`selectPlanetLights` は generics にして、呼び出し側が渡した型をそのまま返すようにした
(`pickNearest` と同じ形)。**「幾何で選ぶ」に被選択物の具象型は要らない。**

---

## 測り方(再現手順)

上の数字は全部、`src/` の相対 import を正規表現で拾って有向グラフを組み、
Tarjan で SCC、Eades-Lin-Smyth の貪欲法で近似最小フィードバック辺集合を出したもの。
`import type` と値 import を区別して数えている。スクリプトは調査用の使い捨てで、
リポジトリには残していない。再測定するなら:

- 辺の抽出: `import (type )?{...} from '相対パス'` と `export ... from '相対パス'` を拾い、
  `.ts` / `/index.ts` へ解決する。節内の識別子が全部 `type` 前置なら型のみ辺とみなす。
- hub のメンバ利用率: `名前: 型名` で束縛される変数名を集め、`変数名.メンバ` を数える。
  `extends` / `implements` は「利用0」に出るので、pass-through と読み違えないこと。
  **配列に対する `map` / `filter` / `push` / `length` も「メンバ」に出る**ので、
  型そのものの面と混ぜないこと。
- **前後比較は必ず同じスクリプトで両方を測る。** 片方だけ測ると、
  新設ファイルぶんの増分(今回は全ファイル一律 +11)を効果と読み違える。
- 数字は `git rev-parse --short HEAD` を添えて、いつの時点かを必ず明示する。
