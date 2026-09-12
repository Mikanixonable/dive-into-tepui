# 段 D — 無駄な import 辺を削る(現況調査と直し方)

測定時点: `160d8c64`(branch `workspace4`)。比較対象は段 A 前が `e66c32fe`、段 C 前が `ecc730f0`。
以下の数字は `src/` の import を機械的に数えたもので、**コードが動けば古くなる。**

段 A〜C の記録は `refactor_interface.md`。この文書はその**続きではなく、別の量を狙う段**である。

---

## 1. 段 A〜C は何を動かし、何を動かさなかったか

**「import 文が全然減らない、むしろ interface を import するぶん増えた」という体感は、正しい。**
測ると次のとおり。

| 量 | `e66c32fe` | `ecc730f0` | `160d8c64` | 段 A〜C の変化 |
| --- | --- | --- | --- | --- |
| ファイル数 | 515 | 526 | 532 | +17 |
| **import 文** | 3,314 | 3,379 | **3,395** | **+81** |
| うち `src/` 内向き | 3,100 | 3,165 | 3,181 | +81 |
| **import した識別子** | 5,774 | 5,835 | **5,857** | **+83** |
| うち型のみの識別子 | 1,457 | 1,573 | **1,600** | **+143** |
| (差)値の識別子 | 4,317 | 4,262 | **4,257** | **-60** |
| 1ファイルあたりの識別子 | 11.21 | 11.09 | **11.01** | -0.20 |

**段 A〜C がやったのは「値の import を型の import へ置き換える」ことだった。** 値の識別子は 60 個
減ったが、型のみの識別子が 143 個増えて、差し引き +83。1ファイルあたりで見れば 11.21 → 11.01 で
**実質不変**。体感どおり、配線の本数は減っていない。

さらに「**弱い辺**」— そのモジュールから引いた識別子が importer の中で合計2回以下しか現れない辺 —
を数えると:

| ref | 辺(名前付き import) | 弱い辺 | 割合 |
| --- | --- | --- | --- |
| `e66c32fe` | 2,985 | 1,136 | 38.1% |
| `ecc730f0` | 3,045 | 1,157 | 38.0% |
| `160d8c64` | 3,066 | 1,173 | **38.3%** |

**ctx2 平均が -32% 動いた同じ期間に、弱い辺の割合は 0.2 ポイントも動いていない。**

### これは失敗ではない — 別の量である

`ctx_k` は「1ファイルを読むために開くことになる行数」を測る。段 A〜C はそれを本当に減らした
(ctx2 平均 5,587 → 3,781)。**減らしていないのは「配線の本数」で、それは誰も測っていなかった。**
指標が結論を決める、という段 C の教訓がここでも当たっている。

### 決定的な区別 — 何が辺を減らし、何が減らさないか

| 直し方 | 辺の総数 | 1ファイルの import 数 | ctx |
| --- | --- | --- | --- |
| **重複クラスタの集約**(同じ import の束が N ファイルに重複 → 1つへ寄せる) | **減る** | 減る | 減る |
| **たらい回しの切断**(素通しのために受けている型を、中継しない配線へ) | **減る** | 減る | 減る |
| 責務の切り出し(大きいファイルから別モジュールへ) | ほぼ不変(新設ファイルの import 行ぶん微増) | **減る** | 減る |
| 面を割る / 面を新設する | **増える** | 不変〜微増 | 減る |

**面を割っても import 文は1本も減らない。** `CelestialBodies` は 20 メンバあって受け手は平均 2.0 個
しか使わないが、割ったところで各ファイルの import は「面1つ」のままである。**段 A〜C が本数を
動かせなかったのは、この4行目しかやっていないからで、それは想定どおりの挙動だった。**

したがって段 D の主戦場は上の2行 — **重複の集約と、たらい回しの切断。**

---

## 2. `CODING-RULE` 1.12 の2条文について

段 C で足した次の2つは、**矛盾していない。ただし2つ揃うと出口の無い罠になる。**

> - 面へ移せるかは、そのファイルが**渡す先の一番広い型**で決まる。
> - **1ファイルのために面を広げない。**

前者は**実現可能性**の話(このファイルは狭められるか)、後者は**面の設計**の話(面に何を入れるか)で、
論理としては別のことを言っている。問題は、2つを並べると次の袋小路が閉じることだ:

- ファイル X は値を Y へ渡すだけ。Y はメンバ `m` を要る。
- `m` は面に無い。1ファイル(Y)のために足すのは後者が禁じる。
- ならば前者により、X も狭められない。**手が無い。**

**両方とも「面の広さ」という一次元の量だけで考えているのが誤りである。** 実際には
**「面の数」という自由度がある** — そして、それが正しい出口になる。

`object-placer-panel` が `CelestialBodyDef` 全体を要るのは、面が狭すぎるからではない。
**その1ファイルだけが別の問いを立てているから**である。`celestial-bodies.ts` の 20 メンバは、
読むと少なくとも4つの問いに割れている:

1. `celestialMotions` / `gravityMotions` / `atmosphereMotions` — 1フレームの積分が読む顔ぶれ
2. `epoch` / `frames` — 座標系の解決
3. `nameOf` / `has` / `motionOf` / `findMotion` / `bodyClassOf` / `starId` / `originId` / `stateAt` / `sunDirFrom` — id で引く索引
4. `bodyParentId` / `ancestorsOf` / `sameSystemIds` / `chainFrom` / `membersFrom` / `systemMembersAt` / `isPositionInFocusedSystem` — 系の階層クエリ

そして `object-placer-panel` が要る `defOf` は**5つ目の問い(天体の宣言を読む)**である。
「面を広げるか、そのファイルを諦めるか」の二択に見えていたのは、**問いが5つあることを
1つの面で表そうとしていたから**にすぎない。

**よって、2条文は「利用パターンで割る」規則へ置き換えるのが正しい。** 案:

> - **面はメンバの共起で割る。** 受け手ごとに「実際に呼ぶメンバの集合」を出し、集合が綺麗に
>   割れるなら面を割る。**同時に使われないメンバを1つの面へ入れない。**
> - 1ファイルだけが要るメンバがあるなら、それは面を広げる理由でも、そのファイルを諦める理由でも
>   ない — **そのファイルが別の問いを立てている証拠**である。面を1つ増やして答える。
> - 面を割ることは import 文を1本も減らさない。**面の設計は「読んで分かるか」のためにやることで、
>   配線の本数のためにやることではない。** 本数は §1 の表の上2行でしか動かない。

**残る問題は、この規則でも「20 メンバの窓口」が生まれ得ること。** 受け手 56、平均 2.0 メンバという
`CelestialBodies` の形は、面というより「天体について何か知りたい人はここ」という窓口である。
割るかどうかは §3 の棚卸しで個別に決める。

---

## 3. 疑いの立て方 — 機械的な兆候と、その限界

「価値の低い import」を機械的に洗うのに使った兆候と、**実地で当たって分かった誤検出**を残す。
次に同じ調査をするとき、この4つで時間を失わないため。

**使った兆候**(全 5,658 組の (ファイル, 識別子) について測った)

- import した識別子の出現回数が少ない(1回 2,806 組 / 2回以下 4,249 組)
- 1つのメソッド・宣言の中にしか出てこない(4,230 組)
- そのモジュールを引くファイル数(fan-in)が多いのに、どこでも薄くしか使われない
- 同じモジュール対がいつもセットで import される

**誤検出 1 — 識別子の数はモジュール辺の数ではない。**
`markerItem` から `fmtMarkerDist` を抜いても、同じファイルの別の場所で `fmtDist` を使っていれば
`hud/utils` への辺は死なない。**「1メソッドでしか使わない識別子が7個」は「辺が7本消える」ではない。**
実測では、消える識別子 23 個に対して消える辺が 1 本、という箇所もあった。
**効き目は必ず「その辺が死ぬか」で数え直すこと。**

**誤検出 2 — 型名は型位置にしか現れないのが正常。**
「中身へ触っていない率(pt%)」を、識別子が `.` や `(` の前に来るかで測ったが、これは
**union 型・関数型・mapped type では常に 100%**(`RenderStyle` `View` `MapListSection`
`ObjectPickerGenre` `ProjectFn` `GraphicsSettingsData` はすべてこれ)。
interface でも、型名 `Notifier` は型位置にしか出ず、触られるのは束縛名 `notifier` のほうである。
**たらい回しを測るには、その型で宣言された束縛の名前を集めて、その名前がメンバ参照されるかを見る**
必要がある。測り直した結果は下記。

**誤検出 3 — 葉の値型は、メンバではなく自由関数で操作するのが正しい。**
束縛名で測り直しても、`Vec3`(126 受け手中 88)・`Quat`(16 中 16)・`KinematicState`・
`PhaseOffsets` などは「素通し」と出る。これは `add(a, b)` の形で操作するからで、**設計として正しい。**
たらい回しの兆候として意味があるのは、**振る舞いを持つ型(メソッドを持つサービス)だけ。**

**誤検出 4 — import ブロックが分断されていると、未使用に見える。**
`stage.ts` の `calendarDateToJulianDate` / `parseCalendarDate` が「未使用」と出たが、実際は
`stage.ts:29-30` の `STORY_EPOCH` 定義で使われている。**import 文の途中に `export const` が
挟まっている**ため、「最後の import 行より後」を本体とみなす走査から漏れた。
(なお、この並び自体は 1.12 の import 順の規則に反しているので、`STORY_EPOCH` を import 群の
後ろへ動かすのが正しい。)

### 測り直した「たらい回し」

型で宣言された束縛名がメンバ参照されるかで測り、**振る舞いを持つ型に限る**と、次が残る。
「素通し」= その型を受けるが、束縛したものへ一度も触らずに次へ渡すだけのファイル数。

| 型 | 受け手 | 触る | **素通し** |
| --- | --- | --- | --- |
| `game/camera/floating-origin.ts#FloatingOrigin` | 37 | 21 | **16** |
| `game/celestial/celestial-bodies.ts#CelestialBodies` | 54 | 39 | **15** |
| `game/map/visibility-policy.ts#MapVisibilityPolicy` | 18 | 7 | **11** |
| `game/stages/stage.ts#Stage` | 20 | 10 | **10** |
| `game/dynamic/sim-speed-manager.ts#SimSpeedManager` | 14 | 4 | **10** |
| `hud/overlay-manager.ts#OverlayManager` | 18 | 8 | **10** |
| `game/marker/marker-slots.ts#MarkerSlots` | 26 | 17 | **9** |
| `game/dynamic/entity-registry.ts#EntityRegistry` | 14 | 6 | **8** |
| `game/vfx/flash-effects.ts#FlashEffects` | 13 | 5 | **8** |
| `audio/sfx/world-sfx.ts#WorldSfx` | 20 | 12 | **8** |
| `game/dynamic/dynamic-entity/controllable.ts#Controllable` | 23 | 16 | **7** |

合計で約 110 辺。全 3,066 辺の 3.6%。**ここが「たらい回しの切断」の在庫。**
ただし全部が defect ではない — `FloatingOrigin` は毎フレーム作り直される値で、素通しの多さは
型の欠陥ではなく `sync` の連鎖が5段深いことの帰結である(§4-2 参照)。

---

## 4. 箇所ごとの診断

以下はすべて**コードを読んで確かめた結果**で、機械的な疑いのままではない。
各項目に「無駄 / 無駄でない / 判断が要る」を付ける。**「無駄でない」も成果**として残す —
次に同じ疑いを立てたときに、また調べ直さないため。

### 4-1. たらい回し(引数そのものが消えるものは、辺も減る)

#### (a) `Stage` を1メンバも触らずに渡す 9 モジュール — **無駄**

`Stage` を型として受ける 20 ファイルのうち、メンバに触るのは 10 だけ。残りは
`activeStage` を次へ渡すだけで、`bullet.ts` / `debris-piece.ts` / `dynamic-entity.ts` /
`entity-contact-physics.ts` / `surface-contact-physics.ts` / `dynamic-system.ts` /
`radiator.ts` / `controllable.ts` / `stage-utils/wave-attack.ts` が該当する
(`wave-attack.ts:138-142` が典型 — `enemy.despawn(simTime, activeStage)` へ流すためだけ)。

実際に触られているのは `scoreCounter` / `recordEnemyDeath` / `recordPlayerLost` /
`nextSimulationEventTime` / `applySimulationEvents` だけ。**戦果の記録面だけの `interface` で
受ければ、hub `stage.ts` への型辺 9 本が葉への辺に差し替わる。**

**注意: これは辺の総数を減らさない**(§1 の表の4行目 — 受け手は面1つを引き続ける)。
効くのは ctx で、`stage.ts` は 340 行で `three/webgpu` / `Player` / `Enemy` / `solarSystem` を
値 import する hub なので、差は大きい。§7 では C6 として「辺は動かない」側に置いている。

- **懸念**: `recordEnemyDeath(enemy: Enemy, ...)` が `Enemy` を引くので、面を `enemy.ts` の
  近くへ置くと型循環が残る(1.12「引くなら…やっただけ無駄になる」)。**面を「敵の戦果」と
  「自機の喪失」に割るか、`Enemy` 側を先に狭めるかは判断が要る。**
- 併せて `wave-attack.ts:88` の `addEnemy: (enemy: Enemy) => void` — `Stage.addEnemy` が
  `protected` なので `creative-stage.ts:440-442` がクロージャを注入している(1.12「不要な
  クロージャ注入は行わない」)。面に `addEnemy` を含めれば消える。**同じ直しの一部。**

#### (b) ビルボードの正対のために `CameraSystem` を配っている 6 ファイル — **無駄**

**ユーザーの仮説は成立する。** 実測:

- プリミティブは既に集約されている — `render/billboard.ts` の `Billboard.sync(position, scale,
  brightness, cameraQuat)` の最後の引数が正対で、実体は `mesh.quaternion.copy(cameraQuat)` の1行。
- 分散しているのは**インスタンスの所有**。`Billboard` を持つのは `thrust-effects` /
  `rcs-effects` / `reentry-effects` / `render/booster.ts` の `BoosterPlume` /
  `render/star-sphere.ts` / `point-entity.ts` の6箇所で、各自が自分の `sync` の中で向ける。
  だから各所有者がカメラを要求する。
- **「登録だけして向けるのは別途」の先例が既にある** — `game/vfx/flash-effects.ts` は
  `spawnFlash()` で登録するだけで、向けるのは `game.ts:538` の1回。
- **制約は無い**: カメラ姿勢は `game.ts:511` の `cameraSystem.sync()` でフレーム冒頭に確定する。
  全ビルボードの mesh は scene 直下か回転を与えられない `Object3D` の子なので、後から一括で
  書いても同じ絵になる。`Billboard.sync` は quaternion を書いた後それを読まない。
- **`base.ts` は `CameraSystem` のメンバを1つも触らない**(`:241` で受け、`:249-250` で
  thrustEffects / rcsEffects へ渡すだけ)。

**対処**: `render/billboard.ts` に「生存中の `Billboard` を保持し、`faceCamera(quat)` で一括して
向ける」だけの小さな持ち主を足す。`Billboard.sync` から `cameraQuat` が落ち、`BoosterPlume.sync` /
`BoosterPlumeSet.sync` / `StarSphere.sync` の `cameraQuaternion` 引数も落ちる。
`zoomActive` は `flash-effects` と同じく boolean のまま渡す(`CameraSystem` を渡さない)。

- **効き目**: `CameraSystem` の import が 6 ファイルから消える(31 → 25)。
- **懸念**: 保持を module 級のグローバルにすると `render-lab` / `cloud-lab` と scene を共有して
  しまう。**`Game` が所有して配る形にすること。** `star-entity.ts:66` の輪郭円は `Billboard`
  ではなく `Line` なので、対象に含めるかは**判断が要る**。

#### (c) 赤道交点マーカーの sync を個体から roster 級のパスへ — **無駄**

`dynamic-entity.ts` が `CameraSystem` と `TimeLabelSetting` を受ける理由は
`syncEquatorNodes`(`:753-760`)だけ。そこで `CameraSystem` は
`activeCameraProjection` / `activeCameraPos` / `view === 'map'` の3値へ即座に分解され、
受け手の `EquatorNodeMarkerPair.sync` は**既に `ProjectFn` / `Vec3` / boolean という葉の型で
受けている**。面は葉にあり、hub 型を運んでいるのは中間の1段だけ。

`dynamic-entity.ts:751` のコメント「投影関数は引くたびに作られるので、交点を持つ個体でだけ引く」が
`CameraSystem` を渡す根拠になっているが、**`DynamicSystem` 側で1回引けばフレームあたり1個で
済み、現状(交点を持つ個体ごとに1個)より少ない。** 根拠として成立していない。
同型の解決パス `updateEquatorNodes` は既に roster 級で存在する(`dynamic-system.ts:319`)。

- **効き目**: `dynamic-entity.ts` から **2 辺**(`CameraSystem` / `TimeLabelSetting`)。
- **注**: 調査は `FrameAnchorSource` も落ちると報告したが、**これは誤り**。同ファイルの
  `:329-346`(`strongestAttractor` / `orbitalElementsOf`)と `:395-406`(軌道線の sync)でも
  使っており、辺は残る。落ちるのは2本。

#### (d) `InstancedPools` を毎フレーム全個体へ配っている — **無駄**

生成時に固定(`dynamic-system.ts:66` で1度 `new`、`dispose` まで差し替わらない)。
実使用は `bullet.ts:128,134` と `debris-piece.ts:175,177` の**2種別だけ**で、残る5ファイル
(`dynamic-entity` / `base` / `detached-booster` / `protein-enemy` / `player`)は `_pools` として
無視している。**5 ファイルから import が消える。**

- **懸念**: 「プールへ積む」1ループを分けると、弾・破片で数百〜数千要素を再走査する。
  **計測なしで断定しない。** `EntityRegistry` から取れるようにして `Bullet` / `DebrisPiece` の
  コンストラクタで受ける案もあるが、`EntityRegistry` に描画資源が乗る。**判断が要る。**

#### (e) `GraphicsSettingsData` を `proteinVibration` 1個のために配っている — **無駄。ただし boolean 引数への切り詰めは不採用**

`game/dynamic/` + `game/player/` 全体で読まれているフィールドは
**`protein-enemy.ts:182` の `graphics.proteinVibration` ただ1つ。**
そのために `dynamic-system.ts` / `dynamic-entity.ts` / `player.ts` が型 import している(全て未使用)。

**boolean 1本に絞る対処は採らない。** 今回の3ファイルは減らせても、`GraphicsSettings` から
sync 側が読みたいものが将来増えるたびに引数が増える・呼び出し口が増える・boolean が2本3本と
並ぶ、という形で同じ問題が戻ってくる。**代わりに `GraphicsSettings` を、render-pipeline が
使う側(重い)と sync が使う側(軽い)に割る** — §6 の「どこで切るか」基準どおり、利用パターンで
割る。sync 側の面はいまは `proteinVibration: boolean` 1個だけの軽いインターフェイスになるが、
それは面であって boolean 引数ではないので、将来 sync 側が読みたいフィールドが増えても
面へ足すだけで済み、シグネチャは増えない。面である必要はあるが、それが `graphics` という
名前・型である必然性は無い。

- **効き目**: 3 ファイル。**懸念**: 新設する面の名前と置き場所(`GraphicsSettings` の中に
  sync 用の狭い面を作るか、別モジュールへ切り出すか)は**判断が要る**。

#### (f) `Launcher` が `Game.create` へ渡すためだけに4つ持っている — **無駄**

`launcher.ts:53-66` の 12 引数のうち `gs: GameScene` / `hud: Hud` / `sections: FrameSections` /
`graphics: GraphicsSettings` は `startRun` の `Game.create` 呼び出し(`:120-124`)以外に参照が
1つも無い。1.3「受け取って別の誰かへ渡すだけの引数は、置き場所が間違っているサイン」。
**`launcher/` → `game/hud/` の辺が生じているのは 1.3 が名指しで警告している状態そのもの。**

- 1.3 は「作らせられないなら、**同じ寿命のものと束ねて1つの引数にする**」と明示しており、
  `GameScene` / `Hud` / `FrameSections` はまさにそれ(起動時に1度だけ組む)。
- **懸念**: `graphics` は呼び出し時点で `current` を読むので束ねると型が広がる。**含めない案を推す。**
  束ねる型の名前は 1.6 に触れるので `Deps` / `Ctx` ではなく中身を言う名にする — **命名は判断が要る。**

### 4-2. 触ってはいけないもの(調べて「正当」と確定したもの)

- **`FloatingOrigin`(fanin 37 / 素通し 16)** — THREE と `vec3` しか引かない葉で、毎フレーム
  作り直される値。既に2メソッドしかなく、狭める余地が無い。素通しの多さは型の欠陥ではなく
  **`sync` の連鎖が5段深いこと**(`game` → `dynamic-system` → `entity.sync` → `syncModel` →
  `placeModel` → `effects.sync`)の帰結。**効くのは連鎖を浅くすることだけ。**
- **`MapVisibilityPolicy` / `OrbitReference` / `TimeLabelSetting`** — いずれも毎フレーム
  作り直される、ビュー・操作対象に依存する値。引数で配るしかない。**正当。**
- **`ProjectFn`(fanin 16)** — `math/projection.ts` は hub を一切引かない葉。マーカー系 16 ファイルが
  揃ってこれを受けているのは、1.12 が目指す形が既に達成されている証拠。**`CameraSystem` を
  狭めた先もここへ収束する。触らない。**
- **`hud/notifier.ts#Notifier`(fanin 25)** — 8行・import ゼロの完全な葉。20 ファイルが実際に
  `.hint()` / `.toast()` を呼ぶ。渡すだけの5ファイルも、`Hud` で受けたら推移依存を全部背負うので
  **`Notifier` で受けるのが正解**。25 という数はゲーム側の通知点の数そのもので、辺の価値は低くない。
- **`render/tsl-types.ts`(fanin 52)** — 22行の型エイリアスのみ、全件 `import type` でビルド時に消える。
- **`hud/utils.ts`(fanin 29 / `fmtDist` 17)** — 1.3 が `hud/` の責務に「数値の整形」を明記している。
  17 ファイルが距離を表示するという事実の反映。
- **`hud/breakpoints.ts#MQ_*`(fanin 20)** — `@media ${MQ_*}` の形。**メディアクエリの条件部は
  カスタムプロパティで書けない**ので置換不能。1.13 が求める形そのもの。
- **`hud/widgets/index.ts`(fanin 43)** — 純粋な再 export バレル。widgets/ 配下 15 ファイルの外部
  依存は `MQ_COARSE` 1本だけで、**バレルが引き込む推移的近傍はディレクトリ内で閉じている。**
  1.12 の「公開境界として意図的に設計したディレクトリ」に当たる。**個別直 import へ倒すのは規約違反。**
- **`hud/overlay-manager.ts`(fanin 22)/ `PropertyRow`(fanin 22)** — 全件 `import type`。
  前者は UI-DESIGN §4「重なりは一箇所が裁く」の登録義務、後者は「各対象が自分の行を自分で書く」設計。
- **`render/pipeline/render-pipeline.ts` のパス群** — 「フィールド型 + constructor での `new`」で
  ちょうど2回ずつ。1.3 の明示的な例外(生成・後始末は配線を担うモジュール自身が書く)。
  段の順序・中間ターゲットの共有・`autoClear` の落とし方は個別の理由で決まっており、
  一般化した「登録」にすると理由が消える。**触らない。**
- **`solar-system/` の 9 ファイルの同型 import** — シグネチャは完全に同型
  (`sun: StarMotion, phases: PhaseOffsets, simZeroEt: number`)だが、共通の引数型を作るのは
  1.6「情報をまとめるためだけの型を作らない」に**触れる**(3値は互いに無関係で、名前が `Params` にしか
  ならない)。`SphereEntity` / `PointEntity` は各系ファイルが直接 `new` している(`new SphereEntity`
  だけで 89 箇所)ので 1.3 に照らして正当。工場関数へ寄せる案も、`earth-system` の `CumulusShell` /
  `EarthCoastline` / `Aurora` 4枚、`saturn` の環と Laplace 面など個別調整が逃げ口を要求するので
  1.2「早急な一般化」に当たる。**現状維持。**
- **`point-entity.ts` のコンストラクタ 11 import** — 描画資源を `new` しているのではなく、
  **全部が引数かその型**。自分で `new` するのは `BodyGraticule` / `Billboard` / `RingView` で、
  どれもシーン登録が要る自分の持ち物(`dispose()` が対称に畳んでいる)。**1.3 に照らして正当。**
- **`stage.ts#ObjectAuthoring`(9 ファイルが1回ずつ)** — 「1回ずつ」は**面が正しく効いている印**
  だった。`InspectedObject.runMenu` の第3引数の型で、実際に呼ぶ消費者が5体
  (`player` / `base` / `enemy` / `ammo-pickup` / `rcs-fuel-pickup` が `authoring?.
  openObjectPlacerForDuplicate(...)`)。1.12 の3条件を全部満たす。
  **ただし定義の置き場所は誤り** — `stage.ts`(hub)ではなく `pickable/` の
  `inspected-object.ts` の隣へ移せば、**hub への型辺が 9 → 1** になる。
- **`EquatorNodeMarkerPair` を `DynamicEntity` が持つこと** — 1.6「配列に対して外部から対応付けを
  行う設計を避ける」の具体例として規約が明示的に肯定している。**外部の対応表へ移してはいけない。**
- **`game.ts` の `perfCounts()` / `serialize()` / `static create`** — 1.2 の明示的な例外
  (生成・後始末・直列化は持ち主が書く)。`timeLabelSettingOf` も、`dynamicSystem.sync` と
  `navTarget.sync` の両方へ同じ値を渡すために1度だけ解いている(1.6-2)。**正当。**
- **`stage-debug-alt-system.ts`(135行 / 34 シンボル)** — 30-85 行が丸ごと架空星系の宣言データ。
  1.5「各ステージの挙動は個別に調整される要素」。**正当。**
- **`orbit-chart.ts` / `orbit-projection-chart.ts` に共通基底を作ること** — 前者は直交座標の折れ線、
  後者は円筒図法テクスチャと自前の pan/zoom 状態を持つ。描画規則は独立に調整される。
  **基底クラスは作るべきでない。**(定数の往復だけは無駄 — 下記 4-3(f)。)

### 4-3. 重複の集約(辺が確実に減る)

#### (a) `markerItem` — 5 ファイルに同型のクラスタ — **条件付きで無駄**

生産者は `player` / `enemy` / `base` / `ammo-pickup` / `rcs-fuel-pickup` の5つ、消費者は
`targeter.ts:146,168,176` の1経路だけ。読むと:

- **5個とも1文字違わない**: `dist = len(sub(pos, viewerPos))` と
  `detail: view === 'map' ? '' : fmtMarkerDist(dist)`
- **player / enemy / base で一致**: `role === 'primary'` のときの強調(`' mk-target'` を足す、
  色を `signal` にする、`priority` を `MARKER_PRIORITY.PRIMARY_TARGET` にする)
- **個体差はデータだけではない**: `sym` は生きた HP バー SVG、`priority` と `bearingVisible` は
  距離の関数、player の色は `isActive` の関数。**「識別データを申告するだけ」にはできない**
  (申告用の型を作れば `GroupedMarkerItem` の半分の写しになり 1.6 に触れる)

**対処**: 全体の型化はしない。共通の2群だけを外へ出す。

1. `detail` と `dist` を `Targeter.pushMarkerItem`(`targeter.ts:190`)で付ける。ここは既に
   `detail` を上書きしているので受け皿がある。**`GroupedMarkers.sync` 側では作れない** —
   `celestial-sub-labels.ts:114` が `item.detail` を使うので、sync に入る前に確定が要る。
2. `role` の強調適用を `grouped-markers.ts` へ `withTargetRole(item)` として置き、Targeter が
   `role === 'primary'` のときだけ通す。`markerItem` から `role` 引数が消える。
   **置き場所は判断が要る** — marker 層に置くと `theme.ts` への辺が1本増える(いまは
   `game/marker/` は theme を引いていない)、Targeter に置くと Targeter が強調の色規約を持つ。

- **効き目**: 死ぬ辺は `theme.ts` × 3(player/enemy/base)、`view/view` × 3(base/ammo/fuel)の
  **6本 − 追加1本 = 5本**。消える識別子は `fmtMarkerDist` × 5、`MarkerRole` × 3、
  `currentThemePalette` × 6箇所、`PRIMARY_TARGET` × 3。`markerItem` の引数が 6 → 3。
- **やらない**: `- dist/1e9` の同順位崩しを `GroupedMarkers` 側の `m.dist` へ寄せる案。
  `m.dist` はカメラ基準、entity 側は自艦基準で**別物**。並び順が変わる。

#### (b) `destroyEffect` を `FlashEffects` へ移設する — **辺ではなく置き場所の直し(決定)**

`destroyEffect` を持つのはこの2つだけ。差分は**スケール係数と破片色の2つ**で、
`_worldSfx.explosion()`・フラッシュ2枚・破片11個・spread 20.0 は同一。

**共通化(1関数 + scale 引数)はしない。** いま見えている差分がスケール2つだけでも、
撃破演出は将来「定数倍スケール以外の差」で分岐する可能性が全然ある。1関数へ畳んでしまうと、
分岐が生まれた瞬間に条件分岐かオプション引数の増殖で書き直す羽目になり、1.5 の
「自機と敵の戦闘挙動は個別に調整されうる」を将来的に破りかねない。

**対処は共通化ではなく移設。** `FlashEffects` に `spawnPlayerDestroyFlash(state)` /
`spawnEnemyDestroyFlash(state)` を**別々の実装として**生やし、`player.ts` / `enemy.ts` からは
呼ぶだけにする。破片(`debris-piece.ts` の `destroyFragments` 化)も同様に player 用・enemy 用を
分けて置く(`buildDestroyFragments` 自体は `player.ts:526` の `radiatorBreakEffect` が
別引数で使い続けるので残す)。

- **効き目**: 辺はほとんど減らない(`FlashEffects` は既に player / enemy 双方への辺を持つ)。
  **狙いは辺ではなく責務** — 演出そのもの(定数・数量・色)という単なる演出に過ぎないものを
  `Player` / `Enemy` から追い出し、それらのファイルがゲームに関わる重要部分に集中できるようにする
  (1.3)。行数が多く読みづらかった点も解消する。
- **1.5 との整合**: `FlashEffects` 側でも player 用・enemy 用を別実装のまま持つので、
  将来演出が分岐しても書き直しは要らない。「一般化しないと決めたもの」には触れない。

#### (c) セーブからの復元デコーダが7箇所に重複 — **無駄**

`saved.{r,v,q,w}` → `KinematicState` / `Attitude` の展開が `player.ts:158` / `base.ts:155,161` /
`ammo-pickup.ts:59` / `rcs-fuel-pickup.ts:56` / `detached-booster.ts:66,73` / `enemy.ts` の
**6ファイル7箇所**でほぼ同一。`save-data.ts:24` の `EntitySaveData` という共通の外部形式に
対応しているのに、デコーダが7つある。個体差は `inertia` だけ。

**対処**: `save-data.ts` の隣に `savedKinematicState(saved, simTime)` と
`savedAttitude(saved, inertia)` を置く。**1.6「多態を保存し、復元する」とは矛盾しない** —
復元の判断(どのクラスを、どの既定値で)は各クラスに残り、**共通の外部形式の純粋なデコードだけが
移る。**

- **効き目**: `physics/kinematic-state` の値辺が ammo / rcs から死ぬ。7箇所の重複が消える。
- **懸念**: `base.ts:167-172` の `savedAtt ?? att` と「att が無いときだけ inertia を上書き」は
  分岐が絡むので、そのまま畳むと読みにくい。**base だけ手作業で確認が要る。**

#### (d) 距離行が3箇所に重複 — **無駄だが効き目が薄い**

`if (viewer) rows.push({ key:'dist', ... fmtDist(len(sub(...))) })` が
`base.ts:392` / `ammo-pickup.ts:176` / `rcs-fuel-pickup.ts:174` で1文字違わず重複。
`pickable/orbit-rows.ts` へ `viewerDistanceRow(entity, viewer)` を併置できる。
**ただしモジュール辺は1本も減らない**(`hud/utils` は `listDetail` の `fmtDist` で全ファイル生存、
`math/vec3` も生存)。**急がない。**

`menuItems` の完全一致は `ammo-pickup` / `rcs-fuel-pickup` の2箇所だけで、
1.5「2箇所以上でも個別に調整されうるなら一般化しない」に当たる。**触らない。**

#### (e) 同一モジュールから2本以上に割れた import 文 — 59 組 — **無駄**

`src/` 全体で 59 組。値と型に分かれているもの(`import { X }` + `import type { Y }`)は
1.12 の並べ方どおりで問題ないが、**値 import が2本に割れているもの**は単なる漏れ:
`player.ts`(`hud/utils` / `stages/stage`)、`creative-stage.ts`(`physics/elements`)、
`stage-debug-alt-system.ts`(`physics/kepler-orbit`)、`wave-attack.ts`(`physics/elements`)、
`small-bodies.ts`(`physics/kepler-orbit`)、`plan-guide.ts`、`physics/kepler-extrapolation.ts`、
`physics/orbit-solvers.ts`(2組)、`physics/satellite-orbit.ts`。

- **効き目**: **辺は減らないが import 文が減る。** 機械的、判断不要。
- 併せて `stage.ts:26-30` の `STORY_EPOCH` を import 群の後ろへ動かす(1.12 の並び順)。
- 併せて型位置でしか使っていない値 import を `import type` へ:
  `WorldSfx` / `FlashEffects`(`protein-enemy` / `metal-enemy` / `enemy` / `player`)、
  `OrbitingMotion` / `CelestialSurface` / `CameraSystem` / `FloatingOrigin`
  (`point-entity` / `sphere-entity` / `celestial-entity`、計 13 箇所)、
  `celestial-system.ts:37` の `CelestialEntity`。

#### (f) チャート定数の往復 — **無駄**

`CHART_LINE_WIDTH` / `CHART_MARK_RADIUS` / `CHART_MARK_RING_WIDTH` は `chart-canvas.ts:12-14` で
定義 → export → 両チャートが import → **`drawPolylineWithGaps` / `drawPointMarker` の引数として
`chart-canvas.ts` へ返している。** 全コードベースで各引数の実引数は1種類しかない。
1.3「受け取って別の誰かへ渡すだけの引数は置き場所が間違っているサイン」の典型。

**対処**: 引数を落として `chart-canvas.ts` 内のモジュール定数(export しない)に閉じる。
**効き目**: 3 識別子 × 2 ファイル。`FONT_FAMILY` / `FONT_XXS` は canvas 2D 用なので残す。

### 4-4. 責務の切り出し(1ファイルの import が減る。総数はほぼ不変)

#### (a) `celestial-system.ts` から光源と影を分ける — **無駄(切り出せる)**

613 行 / 44 モジュールのうち、光源・影・大気の選定が3つの private メソッドに集中している。
書き込み先 8 個(`sunLight` / `exposure` / `bodyShadow` / `ringShadow` / `cumulusShadow` /
`planetLight` / `ambient` / `atmosphere`)は `build()` が引数で受けてそのまま代入するだけで、
正本は `RenderPipeline`。`game.ts:127-131` が `gs.pipeline.*` を8本並べて渡している —
**1.3「受け取って別の誰かへ渡すだけの引数」に真正面から当たる。**
選定の**方針**は既に `render/pipeline/` 側にある(`shadow-select` / `planet-light-select` /
`ambient-source` / `atmosphere`)。残っているのは候補の組み立てと ECI→描画座標の変換だけ。

- **`render/pipeline/` へは寄せられない** — 候補の組み立てが `CelestialEntity` / `StarEntity` を
  読むので `render/` が `game/` を引くことになり、1.3 のフォルダ境界を破る。**game 側に置くしかない。**
- **順序の制約が2本ある**: ① `cumulusShadowAt` / `atmosphereCandidateAt` は
  `point-entity.ts:190,206` で `group.visible` を読むので**全個体の `sync()` より後**。
  ② `exposure.setReference` → `fixedBrightnessScale` → 星殻と点群、という**読み戻し**がある。
- **効き目**: `celestial-system.ts` から import 文 16 本 / 約 28 識別子。44 モジュール → 約 29、
  613 行 → 約 480。`game.ts` の `build` 呼び出しが 8 引数 → 2 引数。触るのは3ファイル。
- **懸念**: **判断が要る** — 新設を `CelestialSystem` が持つ(順序が自然に保たれる)か、
  `Game` が持つ(`CelestialSystem` からシンクが完全に消えるが `fixedBrightnessScale` が1フレーム
  遅れる)か。`RingMaterials` の置き場所も要判断。

#### (b) `creative-stage.ts` を2つに割る — **無駄でない(中継ではない)が、置き場所が違う**

63 の import が2つの塊にきれいに割れる。**どちらも中継ではなく判断を持っている**:

- **配置クラスタ(228-430 行 / 30 import)**: `computeFieldIssues` は `placementMode` / `sizeMode` の
  組でどの検証を掛けるかを決めて詰め替え、`buildElementsState` は a・e を出して基準天体中心 → ECI へ
  直す軌道計算、`placeObject` は `entityKind` で5クラスを作り分けて id 採番・命名・トーストまで持つ。
- **手動スポーンクラスタ(126-206 行 / 14 import)**: `spawnManualEnemy` は形を引いて
  `drifting` / `protein` / 既定を選び分ける。

1.2「独立した意味を持つ手続きが直に書かれている → モジュールとして切り出す」に当たる。
`game/creative/object-placement.ts` と `game/creative/manual-spawn.ts` へ。

- **効き目**: `creative-stage.ts` が **508 行 → 約 120 行、64 import → 約 12。**
- **懸念**: 両方とも `_hud` / `_scene` / `_dynamicSystem` / `_celestialSystem` / `_markers` /
  `_worldSfx` / `_fx` を要り、いまは `Stage` の `protected` から取っている。切り出すと同じ7個を
  コンストラクタで渡すことになり、1.4「多数の引数」に触れる。**`StageDeps` を再利用してよいかは
  判断が要る。** `addPlayer` / `addEnemy` / `spawnEnemyWhenReady` は `protected` なので公開口が要る。

#### (c) `game.runSummary` を下ろす — **ユーザーの仮説は成立しない。ただし切り出しは正しい**

`RunSummary` の 11 フィールドのうち、`GameSaveData` から**取れないもの**:

- `centerBodyId` / `centerBodyName` / `altitude` / `speed` — `orbitInfo` は基準天体の時刻 t の
  状態と `attractor.def.radius` を要る。セーブにあるのは `phaseOffsets` と `epochJdTdb` だけで、
  天体状態を得るには `stageClass.createCelestialSystem`(**async・暦パックのロードを伴う**)を
  回すしかない。**セーブに天体の表示名は一切入っていない。**
- `hpRatio` / `maxHp` — `PlayerSaveData` に hp が無い。艦の hp は `parts[]` の合計なので、
  セーブから出すには Ship の集計をもう一度書くことになる(1.6「実装の重複」)。

**ただし手前の主張は成立する** — `runSummary` は `Game` の private を1つも触らず、public getter
だけで書けている(1.4「クラス外から情報をもらいまくっていて、クラス内の情報に全然手を付けて
いない関数」に完全一致)。**既存の `run-summary.ts` へ `runSummary(game: Game)` として下ろす。**
`snapshot-service.ts:22` は既に `Game` を引いているので1行置換。

- **効き目**: `game.ts` から6辺(`isEnemy` / `isBase` / `isPlayer` / `autoOrbitReference` /
  `orbitInfo` / `RunSummary`)。**辺の総数は減らない**が、`game.ts` が「種別を名指しする」ことと
  「軌道要素を解く」ことをやめる。
- **懸念**: `run-summary.ts` が `Game` の具象型を引くことになる。使う面は5メンバだが、その面は
  `Controllable` / `CelestialSystem` / `EntityRoster` / `Stage` を返すので**葉に置けない**
  (1.12 の2番目で落ちる)。**具象 `Game` で受ける判断が要る。**

#### (d) `render-pipeline.ts` のデバッグ材質表 — **触らない(決定)。優先度低**

`compositeMaterials`(`:167-212`、16 エントリ)と4つのノード構築メソッド、計約 115 行が
配線モジュールに同居している。1.2 が名指しする「配線で占められたモジュールに実装を書かない —
メニュー項目表、座標計算は、たとえ1箇所からしか使われなくてもその関心を持つモジュールへ置く」に
当たり、同じ抽出の先例が隣にある(`SchematicComposite`)。切り出せば 32 モジュール → 約 26、
470 行 → 約 360。

**しかし描画は静かに黒くなる種類の壊れ方をする。** `depthDebugProjInv` の所有をどちらへ置くかも
要判断で、実施するなら `/rendering-workflow` の手順(render-lab で全 debugTarget を1枚ずつ撮る)が
必須。**効き目に対してリスクが見合わない。**

**ユーザー判断: 触らない。** `render/pipeline/` 自体がゲーム本体と十分に疎結合を保てている
(1.2 が問題にしているのは配線モジュールへ実装が漏れることで、`render/pipeline/` が `game/` から
独立していることそのものではない)ので、この程度の同居を許容するコストは低い。優先度低。

### 4-5. import 辺ではないが、調査で見つかった不具合

**`theme.ts` の色定数は起動時に凍結され、配色切替に追従しない。**
`ACCENT` / `EDGE` / `TEXT_DIM` / `FILL_4` 等は `theme.ts:209-` で `ACTIVE_THEME` から module load 時に
確定する定数。`applyThemePalette()`(`:511`)は `activePalette` を差し替えて CSS 変数を書き換えるが、
**これらの export された定数は更新しない。** したがって:

- `chart-canvas.ts:82-86` / `orbit-chart.ts:136-195` / `orbit-projection-chart.ts:155-221` の
  canvas 2D 描画と、`marker-style.ts:151` の `stroke: ${FILL_4}` は、**設定から配色を変えても
  変わらない。** UI-DESIGN §2「選択は画面へ即座に反映され」に反する。
- 生きた口は `currentThemePalette()` で、`game/dynamic/*` / `entity-line-manager` / `player` は
  そちらを使っている。**同じ関心に2つの流儀が並存している。**
- `marker-style.ts:151` は `var(--fill-4)` に直せば消える。canvas 側は `currentThemePalette()` へ
  寄せる必要があり、**再描画のトリガをどこが持つかは仕様判断。**

**併せて `theme.ts` のトークン別名 15 件、うち 11 件が完全な未使用。**
両方が現役の3組が特に問題 — `--text`(52 箇所)/`--title`(16)、`--text-dim`(89)/`--muted`(17)、
`--text-muted`(2)/`--body`(7) で、**同じ値に2つの名前**。1.6「同じ値へ入口を2つ作らない」と
UI-DESIGN §2「トークンは1箇所だけで定義」に反する。`theme.ts:141` の
"The old --accent names below remain compatibility aliases" は 1.11「互換のための旧名エイリアスを
残さない」に真っ向から当たり、**コメントが英語である点も 3.1 違反。**
`ACCENT_SECONDARY` の `@deprecated` エイリアス(`theme.ts:207`)も同様。

**入口の二重化が3件。**

- `injectOnce` — `hud/widgets/index.ts` 経由 4 件、`inject-style.ts` 直 13 件。**同じ入口が2つ**。
  しかも CSS 注入機構でウィジェットではない。`pointer-pan-zoom.ts` も widgets/ に居ながら
  バレルにも UI-DESIGN §3 の 11 種にも属さない。**どちらも `src/hud/` 直下へ移すのが正しい。**
- `hud/windows/index.ts` はバレル経由 4 : 直 13、`game/hud/windows/index.ts` はバレル経由 3 : 直 36。
  **8割超が迂回する境界は「意図的に設計した公開境界」ではない**(1.12)。
  `object-windows.ts` は `:5` で `'../hud/windows'`、`:6` で `'../../hud/windows'`、
  `:28` で `'../hud/windows/context-menu'` を**同じファイルで併用**している。
  → **2つのバレルを削除し、7ファイルを直 import へ寄せる。**
- `game.ts:187` の `celestial.origin.id` — `celestial-system.ts:221` に `get originId()` がある。

**`hud-root.ts` の 11 本の `*_STYLE` 連結のうち3本は持ち主が別。**
`PAUSE_MENU_STYLE` / `SETTINGS_VIEW_STYLE` の持ち主 `PauseMenu` / `SettingsView` は
`main.ts:114-115` で生成される **`hud/` 層(共通部品)**。つまり共通層のウィンドウの見た目が、
game 層の `hud-root` が起動したかどうかに依存している。UI-DESIGN §8 は設定ビューを
「タイトル画面とゲーム中の両方から開ける共通の画面」と定めており、**この依存は境界の逆流。**
3本ともセレクタが完全に id スコープなので注入順に依存しない。各持ち主の constructor で
`injectOnce` へ移せる。

- **残る8本は集約が正しい**(起動時に必ず存在する静的な骨格)。ただし `hud-root.ts:26` の
  コメント「同一セレクタの再定義は各ファイル内で完結させてある」は**実際には破れている** —
  `#hud-map-scale .map-scale-value` と `.map-scale-ruler::before` が `skeleton-style.ts:167,169` と
  `map-view-style.ts:395-396` の両方にあり、連結順の後勝ちで map-view が勝っている。
  **ただし `--text` と `--title`、`--text-dim` と `--muted` は同一値なので、
  `map-view-style.ts:395-397` の3行は現状すでに何も変えていない死んだ CSS。消せば依存も消える。**

**`celestial-entity.ts:33` だけが具象 `CelestialSystem` を引いている。**
契約(`inspected-object.ts:18,31` / `listed-object.ts:15,17`)が宣言しているのは狭い面
`CelestialBodies` で、**他の 11 実装はすべて `CelestialBodies` で受けている。** celestial だけが
hub を引き込んでいる。使っているのは `origin.id` と `star?.id` だけで、どちらも面の
`originId` / `starId` で足りる(`propertyRows` は引数を1つも使っていない)。**1行の置換。**

---

## 5. 段 A〜C の面の棚卸し — 差し戻すべきものはあるか

**結論: 1つも無い。** 新設した面はすべて 1.12 の3条件を満たしており、
**受け手側で面と具象を二重に引いているファイルは、主要6面すべてで 0** — 辺を足したのではなく
差し替えている。

### 辺 +81 の出どころ

```
+9 pickable/inspected-object.ts   +8 pickable/map-pickable.ts     +6 celestial/celestial-bodies.ts
+4 pickable/listed-object.ts      +3 marker/marker-slots.ts       +3 dynamic-entity/orbiting-object.ts
+2 pickable/pick-candidate.ts     +2 pickable/pickable-listing.ts +2 hud/hud-layers.ts
+1 dynamic/entity-roster.ts       +1 dynamic/entity-registry.ts    0 hud/notifier.ts
-11 pickable/object-pickable.ts
```

**約 41 本(半分)は新設した面のモジュール自身が持つ import。** 面は自分が言及する型を自分で
宣言し直すので、**面1つにつき1回だけ扇形の import を払い、その代わり N の受け手が hub への辺を
落とす。** 残る約 40 は、1つの具象を2つ以上の面へ割ったことで受け手側に増えた1本ずつ
(`hud.ts` → `HudLayers` + `Notifier` で6ファイル、`dynamic-system.ts` → `EntityRoster` +
`EntityRegistry` で3ファイル、ほか)。

**「読む手間が減っていない」と感じる本当の理由は、受け手の 25〜45% が1メンバも呼ばない
持ち回りだから**(`CelestialBodies` 15/56、`Notifier` 11/25、`FrameAnchorSource` 11/17、
`Controllable` 15/26、`OrbitingObject` 12/22)。**この層は import 文の本数が変わらず、ctx だけが
軽くなる。** §1 の表の3・4行目に当たる。

### 面ごとの判定

| 面 | fanin | 受け手のメンバ集合 | 判定 |
| --- | --- | --- | --- |
| `CelestialBodies` | 56 | **割れない**(受け手 41 のうち 24 が facet をまたぐ。階層クエリを単独で引くファイルは 0) | **維持** |
| `Notifier` | 25 | 割れない(2メンバ)。8行・import 0 の完全な葉 | **維持** |
| `EntityRoster` | 18 | 割れない(`all` が共通項)。11行・型 import 1本 | **維持** |
| `EntityRegistry`/`SpawnGate` | 17 | 割れない(2メンバ)。13行 | **維持** |
| `OrbitingObject` | 22 | 割れない。`id` は誰も呼んでいないので落とせる | **維持** |
| `ProjectFn`/`ScaleFn` | 17 | 受け手は**もともと同じ import 行に足しているだけ** — 追加の辺 0 | **維持** |
| `FrameAnchorSource` | 17 | 分かれ気味だが4メンバで `physics/frame.ts` に同居、追加 import 0 | **維持** |
| `ObjectPickable` 4分割 | 19 | **完全に割れている**(3面をまたぐ消費者 0) | **維持**(下記の残作業あり) |
| `DynamicEntityKind` / `CelestialClass` | 17 / 11 | union。`Record<K,...>` の網羅性検査に値として掛かっている | **維持** |
| `MapListSection` / `ObjectPickerGenre` | 10 / 9 | **面ではなく語彙。** 1.12 ではなく 1.6「定数は概念の所有者が持つ」が根拠。8ファイルが HUD パネルを引くのをやめている | **維持** |
| `MarkerSlots` | 27 | **綺麗に割れる**(`shows` だけの受け手5〜7 vs 書く側8、またぐのは2) | **割ってよい。ただし辺は減らない** |
| `HudLayers` | 8 | ほぼ割れる({`layers`,`overlayManager`} vs {`root`,`mapRoot`,`combatRoot`}、またぐのは `plan-editor` だけ) | **判断が要る**(受け手8で、割ると2ファイルの import が1本増える) |
| `Controllable` | 26 | **完全に割れる**(消費者6の集合が互いに素) | **判断が要る**(段 A〜C の成果ではなく元からある面。割っても `Stage` を引く `updateControls` が残る側に居座る) |

### 残作業 — 面の中身がまだ葉でない

`ObjectPickable` の割り方は正しいが、**面の署名が hub を引いている**:
`inspected-object.ts` が `plan-editor.ts`(583行/27 import)と `stage.ts`(340行、
THREE・Player・Enemy・solarSystem を値 import)を引き、`map-pickable.ts` が
`object-windows.ts`(306行/24 import)を引く。1.12「葉に置けるか」に落ちている。

**原因は `runMenu(act, controlSelection, authoring, planEditor)` と `onMapSelect(windows, x, y)` の
引数の型。** これを実装する6クラスは、**使わない引数も `_` 付きで書くために全部の型を import する**
(`orbit-point-marker` は `_controlSelection` と `_authoring` の2つとも未使用)。
**処方は revert ではなく「先にその引数の型を葉へ狭める」。**

---

## 6. `CODING-RULE` 1.12 をどう書き直すか

§2 で「2条文は矛盾しないが出口が無い」と書いた。棚卸しの結果、**出口は3つに分けて書くのが正確**
だと分かった。3つは別々の問いに答えていて、取り合っていない。

1. **面を作るか** — 実装型が重い依存を持つか。**既存の1.12 冒頭3基準のまま。変更不要。**
2. **どこで切るか** — **受け手のメンバ集合が割れるか。互いに素なら割り、またぐ受け手が多数なら
   割らない。**(ユーザーの提案どおり。実測で裏付けあり: `Controllable` は消費者6の集合が互いに素、
   `ObjectPickable` は3面をまたぐ消費者 0、`CelestialBodies` は 41 中 24 がまたぐ。
   **この規則を先に持っていれば、`ObjectPickable` の4分割は測る前に決まっていた。**)
   → **新設すべき条文。**
3. **どのファイルが受けられるか** — **渡す先の一番広い型で決まる。**(1つ目の条文。**維持**。
   `anchor-zone` などは `ListedObject` のメンバを1つも呼ばないが、配列を運ぶために面を受けている。
   「使用メンバで数えると 0 だから何でも受けられる」と読めてしまうのを、この条文が防いでいる。)

**そして「1ファイルのために面を広げない」は書き直す。**

段 C はこの教訓を `object-placer-panel` から引いたが、**記録した理由が誤っている。**
`object-placer-panel.ts` が `CelestialSystem` に要るのは `nameOf(id)` と
`entityOf(secondary).def`(`primaryDistanceKm(def)` が `def.orbit.kepler.a` を読む)の2つ。
memo は「面へ `defOf` を足すと ctx1 が 785 → 約 1,770 行に膨れる」から広げなかったと書いていて、
**この数字は正しい**(`CelestialBodyDef` は 178 行で `kepler-orbit` / `satellite-orbit` /
`atmosphere` を引く)。

しかし**膨らんだ原因は「1ファイルのためだったこと」ではなく、「戻り値が重い型だったこと」。**
同じ需要を `primaryDistanceKm(id: string): number` のような**スカラを返すメンバ**で満たせば、
`celestial-bodies.ts` へ持ち込む import は **0 本**で、`object-placer-panel` は具象を捨てられる
(`CelestialBody.def` は `{ id, mu, radius }` に絞られていて `orbit` を持たないので、
`motionOf(id).def` では届かない — 面の側が答えるしかない)。よって:

> **面のメンバを増やしてよいかは、そのメンバの戻り値の型が面のモジュールへ何を引き込むかで
> 決まる。受け手が何ファイルあるかでは決まらない。**

これは1つ目の基準(「重い型を返すメンバを落とせるなら数が半分残っても価値がある」)の裏返しで、
**条文を1本増やす必要すらない。** いまの書き方は、正しい規則(戻り値の重さ)から**たまたま同じ
結論が出た**特殊例を、ファイル数という当たらない量で一般化してしまっている。この形で残すと、
`primaryDistanceKm(id)` のような**コスト 0 の追加まで禁じてしまう。**

---

## 7. 直しの一覧 — 何がどれだけ効くか

**§1 の表を各項目に当てはめた結果。「辺」は import 辺の総数の増減。**

### A. 辺が確実に減るもの(合計 約 -36 辺)

| # | 直し | 辺 | 判断 |
| --- | --- | --- | --- |
| A1 | ビルボードの正対を一括の1回呼び出しへ(`CameraSystem` が 6 ファイルから消える) | **-6** | 所有者を `Game` にする。`star-entity` の輪郭円を含めるかは要判断 |
| A2 | `ObjectAuthoring` を `stage.ts` から `pickable/` の葉へ | **-6** | 消費者は既に `inspected-object.ts` を引いているので辺が畳める |
| A3 | `markerItem` の共通2群を Targeter / `grouped-markers` へ | **-5** | `role` 強調の置き場所が要判断 |
| A4 | `InstancedPools` を毎フレーム配るのをやめる | **-5** | 2周目のコストは計測が要る |
| A5 | `GraphicsSettingsData` を `proteinVibration` 1個のために配るのをやめる | **-3** | boolean 引数ではなく sync 用の軽い面を新設する(決定)。置き場所が要判断 |
| A6 | `Launcher` の4つを寿命の同じ束へ | **-3** | `graphics` は含めない。命名が要判断 |
| A7 | 赤道交点マーカーの sync を roster 級のパスへ | **-2** | リスク最小。**ここから始めるのがよい** |
| A8 | チャート定数の往復を止める | **-6** | 判断不要 |
| A9 | `FrameControls` を `ObjectWindows` / `MapPicking` / `PlanEditor` へ配るのをやめ、`setFocus` だけのコールバックへ差し替える(深い所有者 `MapView` だけが本体を持つ) | **-3** | §10-1 参照。`Game` 自身の起点1回・`MapView` の駆動はそのまま残る |
| A10 | `CelestialMarkers` を `Targeter` / `CombatView` へ配るのをやめ、`Targeter` は `activeLabels` の値、`CombatView` は `hideLabels` コールバック(またはビュー離脱時の処理を `ViewManager` へ寄せる)に差し替える | **-2** | §10-1 参照。置き場所(`CombatView` 自身が持つか `ViewManager` へ寄せるか)は判断が要る |

### B. 辺は減らないが、import 文が減るもの

| # | 直し | 効き目 |
| --- | --- | --- |
| B1 | 同一モジュールから2本に割れた値 import を1本へ(59 組のうち値どうしの組) | import 文 -10 前後 |
| B2 | 型位置でしか使っていない値 import を `import type` へ(約 18 箇所) | 実行時の辺が減る |
| B3 | `hud/windows` の2つのバレルを削除し 7 ファイルを直 import へ | モジュール -2、入口の二重化が解消 |
| B4 | `injectOnce` / `pointer-pan-zoom` を `src/hud/` 直下へ | 入口の二重化が解消(17 ファイルの import 先が揃う) |
| B5 | セーブ復元デコーダを `save-data.ts` の隣へ(7箇所 → 1) | 重複 -6。`base` だけ手作業 |

### C. 辺は動かないが、1ファイルの import と ctx が減るもの

| # | 直し | 効き目 |
| --- | --- | --- |
| C1 | **`View` を葉へ出す** | 19 ファイルが、2値の union のために `PlanEditor`(583行)ほか7モジュールを引くのをやめる。**単独では最大の ctx 削減で、コストは新設1ファイル** |
| C2 | `creative-stage.ts` を配置 / 手動スポーンの2つへ割る | 508 行 → 約 120、64 import → 約 12 |
| C3 | `celestial-system.ts` から光源と影を分ける | 44 モジュール → 約 29、613 行 → 約 480、`game.ts` の `build` が 8 引数 → 2 |
| C4 | `game.runSummary` を `run-summary.ts` へ下ろす | `game.ts` が種別を名指しするのをやめる |
| C5 | `celestial-entity.ts:33` を `CelestialBodies` へ | 1行。エンティティ → hub の逆辺が消える |
| C6 | `Stage` の戦果記録面を切って 9 ファイルの持ち回りを狭める | hub への型辺 9 本が葉へ移る。**面の割り方が要判断** |
| C7 | `MarkerSlots` を読み口と書き口に割る | 5〜7 ファイルが `projection` / `vec3` / `celestial-body` を引かなくなる |
| C8 | `reference-orbit-rows.ts` の build/sync/型 9 本を 3 クラスへ | 9 識別子 → 3 |
| C9 | `PAUSE_MENU_STYLE` / `SETTINGS_VIEW_STYLE` / `HELP_PANEL_STYLE` を持ち主へ | `game/hud` → `hud/style` の層逆流が2本消える |
| C10 | `player.ts` / `enemy.ts` の `destroyEffect` を `FlashEffects` の別々の関数(`spawnPlayerDestroyFlash` / `spawnEnemyDestroyFlash`)へ移設(**決定**、共通化はしない) | 辺はほぼ増減なし。演出専用コードが `Player` / `Enemy` から消え、ゲームに関わる重要部分に集中できる |
| C11 | `orbit-altitude-tab.ts` / `orbit-approach-tab.ts` / `orbit-projection-tab.ts` の `AnalysisTab` 契約を `Game` から `{ celestialSystem }`(projection だけ `+ 経過秒数`)へ狭める | §10-2 参照。3 ファイルが `Game` を丸ごと捨てられる |
| C12 | `frame-controls.ts` / `trajectory-frame-panel.ts` が受ける `DisplayWindowManager`(9 メンバ)を `frame` の get/set だけの面へ狭める | §10-2 参照。両ファイルとも `frame` 以外は1回も触っていない |
| C13 | `physical-object-list-panel.ts` → `physical-object-list-tree.ts` の `CelestialBodies` 0タッチ中継を、実際に触る `object-groups.ts` / `physical-object-list-order.ts` 側の3メンバ集合まで絞る | §10-2 参照。`CelestialBodies` 素通し15(§3表)の内訳の一部 |

### D. 不具合(import の話ではないが、調査で出た)

| # | 直し |
| --- | --- |
| D1 | canvas 2D とマーカーの色が配色切替に追従しない(`marker-style.ts:151` は `var(--fill-4)` で即消える。canvas 側は再描画トリガの設計が仕様判断) |
| D2 | `theme.ts` の未使用別名 11 件を削除、現役3組を統一(CSS 40 箇所の置換)。`@deprecated` と英語コメントも 1.11 / 3.1 違反 |
| D3 | `map-view-style.ts:395-397` の死んだ CSS 3 行を消す(`skeleton-style` との後勝ち依存も同時に消える) |

### E. 触らないと決めたもの

§4-2 の全項目。**とくに `render-pipeline.ts` のデバッグ材質表**(効き目は大きいが描画は静かに
壊れる。`/rendering-workflow` の全 debugTarget 撮影が必須で、リスクに見合わない。`render/pipeline/`
自体はゲーム本体と十分疎結合を保てているので、この同居を許容するコストは低い。**触らないと
ユーザーが確定、優先度低**)と、**`solar-system/` の 9 ファイルの同型 import**(共通の引数型は
1.6 に触れ、工場関数は 1.2 に触れる)。

---

## 8. ユーザー指摘を受けた再検査 — パターンを2つ追加する

測定時点は §1 と同じ `160d8c64`。**偽陰性の指摘は当たっていた。** §3〜4 の「機械的な兆候→
読んで確認」は兆候を4種類使ったが、兆候そのものに次の2つが抜けていた。

1. **「配線モジュールが `new` して2つ以上へ配る」は、1.3 の例外があっても自動で正当にはならない。**
   受け手の1つが深い(毎フレーム・多メンバ)所有者でも、もう1つが浅い(単発・1メンバ)だけなら、
   浅いほうは配る理由が無い。
2. **HUD パネルが太い型(`Game` / `Stage` / hub 型)を受けて、実際には1〜2メンバしか使わない。**
   機械的には「宣言された型のメンバ数」対「実際に触るメンバ数」の比で検出できるが、その先
   ——1つの共通面にまとめてよいか、パネルごとに別の面が要るか——は意味論判断が要る。

以下は両方とも実測(コードを読んで確認済み)。

### 10-1. 「1.3 の例外」の第二・第三事例 — `FrameControls` / `CelestialMarkers`

ユーザーが挙げた前例(`PlanEditor` を `Game` が `new` して `ObjectWindow` と `MapView` へ配って
いたが、興味を持つべきは `MapView` だけだった。コミット `a30b91af`)と**まったく同じ形**が、
`game.ts` にまだ2つ残っている。

#### (a) `FrameControls` — **無駄**

`game.ts:254` で `new FrameControls(...)` し、直後に3方向へ配っている:

- `game.ts:302` → **`ObjectWindows`**(コンストラクタ引数)。使うのは
  `object-windows.ts:276,295` の `this.frameControls.setFocus(...)` **2箇所だけ**。
- `game.ts:314` → **`MapView`**(コンストラクタ引数)。**ここが深い所有者** —
  `map-view.ts:124,145` で毎フレーム `update()` / `sync()` を駆動する。
- `map-view.ts:59` → `MapView` 自身が組む `PlanEditor` のコンストラクタへも同じ参照を渡し、
  `plan-editor.ts:151` の `setFocus(...)` **1箇所だけ**で使われる。
- `map-view.ts:68` → `MapView` 自身が組む `MapPicking` のコンストラクタへも渡し、
  `map-picking.ts:157,165` の `setFocus(...)` **2箇所だけ**で使われる。
- `game.ts:332,364` → `Game` 自身も起動時の1回(`setFocus`)と `dispose()` を呼ぶ(所有者としては正当)。

`MapView` を経由する `PlanEditor` / `MapPicking` への配布は「マップでしか使わないものは
`MapView` が持つ」という既存方針(`map-view.ts:32` のコメント)どおりの、`MapView` 自身の
子への配布であり問題ない。**問題は `game.ts:302` の `ObjectWindows` への直配布** — `Game` が
`FrameControls` を、深い所有者 `MapView` と並ぶ兄弟として `ObjectWindows` にも直接渡している。
`ObjectWindows` が要るのは `setFocus` という1メソッドだけであり、`FrameControls` を受け取る
理由が無い。

**懸念**: `game.ts:297-298` のコメント「候補列と計画の編集口はマップビューが持つので、ビュー
より先に組み上がるここへは遅延評価で渡す」は、`ObjectWindows` が本来 `MapView` 側の関心を
借りていることを実装者自身が認めている箇所。**構築順序(`ObjectWindows` がビューより先に
組まれる)が理由で `MapView` から直接もらえない** ため、`Game` 経由の直配布になっている。
`setFocus: (target: FocusTarget) => void` という1メソッドのコールバック型に差し替えれば、
構築順の制約を保ったまま `FrameControls` 本体への依存を切れる。

- **効き目**: `ObjectWindows` から辺1本(`FrameControls` → コールバック型)。
  `MapPicking` / `PlanEditor` は `MapView` の子なので触らなくてよい(辺は動かない)。

#### (b) `CelestialMarkers` — **無駄**

`game.ts:243` で `new CelestialMarkers(...)` し、同様に配っている:

- `game.ts:307` → **`CombatView`**(コンストラクタ引数)。使うのは
  `combat-view.ts:111` の `this.celestialMarkers.hideLabels()` **1箇所だけ**
  (`syncLabels()` — マップ専用表示なので戦闘ビューでは畳む、というコメントどおり)。
- `game.ts:314` → **`MapView`**(コンストラクタ引数)。**ここが深い所有者** —
  `shownLabelCount` / `hideLabels` / `syncLabels` / `syncSubLabels` を毎フレーム呼ぶ
  (`map-view.ts:81,131,132,150`)。`MapView` の子 `ObjectPickables` / `MapPicking` も
  深く使うが、これは `MapView` 自身の子への配布であり問題ない。
- `targeter.ts:178` → **`Targeter`**(コンストラクタ引数、`game.ts` から見て `MapView` とは
  別の兄弟)。使うのは `this.celestialMarkers.activeLabels` **1箇所だけ**。

`CombatView` と `Targeter` はどちらも `MapView` と並ぶ兄弟でありながら、`CelestialMarkers`
という多メンバの型を1メソッド/1プロパティのためだけに受けている。

**懸念**: `CombatView.syncLabels()` は「戦闘ビューに入っている間はマップ専用ラベルを畳む」
というビュー遷移の関心であり、`CombatView` 自身が毎フレーム持ち回るより、両ビューを知っている
`ViewManager`(`game.ts:320`)がビュー切替の瞬間に一度呼ぶほうが自然かもしれない
(`onLeave`/`onEnter` の対称性——`map-view.ts:97` の `onLeave` は既に離脱時処理を持っている)。
**置き場所(`CombatView` に残すか `ViewManager` へ寄せるか)は判断が要る。** `Targeter` 側は
単に `activeLabels: readonly string[]` を渡せば済み、判断は不要。

- **効き目**: `CombatView` / `Targeter` から辺2本。`MapView` 側は触らない。

#### (c) 検討したが「正当」と確定したもの — 同じ形に見えて違うもの

同じ「`Game` が `new` して複数へ配る」形に見えて、**受け手がすべて浅いか、配布が
`Game` からの直配布ではなく1つの子が自分の子へ配っているだけ**のものは、1.3 の例外に
そのまま当たる。取り違えないよう記録する。

- **`MarkerManager` → `CombatView`**(`game.ts:309`)— `combat-view.ts:48` の
  `new PlanGuide(notifier, uiSfx, markers)` 以外に読み取りが無い。**しかしこれは
  `CombatView` が「戦闘ビューにいる間しか出さない」自分専用の子 `PlanGuide` を組むための
  材料**(`combat-view.ts:30-31` のコメントどおり)であり、`MapView` が `PlanEditor` を
  組む形と同型。**中継ではなく自分の子への部材** なので 1.3 の例外そのもの。
- **`NavTarget` / `SimSpeedManager` / `EntityRoster`(dynamicSystem)/ `scene` / `hud` →
  `MapView`**(`map-view.ts:38-56`)— これらは `private readonly` 修飾が無く、コンストラクタ
  本体でも `map-view.ts:57-70` の4つの子(`PlanEditor` / `ObjectPickables` /
  `LinePickables` / `MapPicking`)を組む以外に一度も使われない(フィールドにも残らない)。
  一見 `FrameControls`/`CelestialMarkers` と同じ「触らず右から左」だが、**`MapView` は
  `Game` からの受け手ではなく、`Game` に代わって map 専用の4つの子を組む側の合成ルート**
  ——`map-view.ts:32` のコメントが明言する既存方針そのもの。`Game` の構築が肥大化するのを
  避けて `MapView` へ委譲している設計であり、1.3 の例外がここでも成立する。**触らない。**
- **`FrameAnchors`**(`game.ts:249`)— `FrameControls` / `MapView` / `CameraSystem.update` /
  `DynamicSystem.sync` / `EntityLineManager.sync` など複数層へ配られ、途中の層では触られず
  末端(`entity.actualLine.samplePoints` 等)まで運ばれる。これは「複数へ配る」ではなく
  §3 で既出の**たらい回し**(`FloatingOrigin` と同型)——生成自体は `Game` の私有クロージャ
  (`dynamicSystem.all()` / `activeControllable` / `navTarget.resolveState`)に依存するため
  `Game` でしか作れない。**新パターンではなく、`FloatingOrigin` と同じ「連鎖が深いだけ」の
  既知の形。触らない。**

**検出のしかた(一般化)**: 配線モジュールの中で、同じ `new T(...)` の結果(またはそこから
辿れる参照)が、生成した本人以外の**2つ以上の兄弟モジュール**のコンストラクタ実引数に現れる
箇所を洗い出し、各受け手が呼ぶメンバ集合を比べる。**1つが深く(多メンバ・毎フレーム)、他が
浅い(1〜2メンバ・低頻度)なら、浅い側を狭い面かコールバックへ差し替える。** 一方が「自分の
子を組むためだけの部材」(1.3 の例外そのもの)であることも多いので、**受け手が中継しているのか、
自分の子を組んでいるだけなのかを先に区別する**——後者は何個受けても正当。

### 10-2. HUD パネルの太いインターフェース — 実測

`src/game/hud/**` と `src/hud/panels|windows/**` のうち、`Game` / `Stage` / `CameraSystem` /
`CelestialBodies` / `DisplayWindowManager` のような多メンバ型を受ける約15ファイルを実測した。
**「宣言された型」と「実際に触るメンバ」の差はほぼ全ファイルで大きいが、そこから先——複数
パネルで共有できる部分集合があるか——は個別に違う。**

| ファイル | 受ける型(メンバ数) | 実際に触るメンバ |
| --- | --- | --- |
| `orbit-altitude-tab.ts` | `Game` | `celestialSystem` のみ |
| `orbit-approach-tab.ts` | `Game` | `celestialSystem` のみ |
| `orbit-projection-tab.ts` | `Game` | `celestialSystem`, `displayWindowManager.current.duration` |
| `orbit-panel.ts` | `Game` | `celestialSystem`, `activeControllable`, `orbitReference`, `navTarget`, `dynamicSystem` |
| `orbit-analysis-window.ts` | `Game` | 同じ5メンバ(`orbit-panel.ts` と重複) |
| `frame-controls.ts` | `DisplayWindowManager`(9) | `frame` の get/set のみ |
| `trajectory-frame-panel.ts` | `DisplayWindowManager`(9) | `frame` の get/set のみ |
| `top-bar.ts` | `DisplayWindowManager`(9) / `SimSpeedManager`(14) | `current.epochUnixSec` のみ / `simSpeed`,`estimatedRealSecondsToWarpEnd`,`remainingSimulationSeconds`,`setSpeed`(介入) |
| `vessel-panel.ts` | `Stage`(35) / `CameraSystem`(13) | `.id` のみ / `combatCamera.rotationFollow` のみ |
| `enemies-panel.ts` | `Stage`(35) | `.scoreCounter` のみ |
| `map-scale-badge.ts` | `CameraSystem`(13) | `mapCamera.resolvedFocus`, `activeCameraScale(...)` |
| `target-panel.ts` | `CelestialBodies`(21) | `celestialMotions` のみ |
| `view-badge.ts` | `CelestialBodies`(21) | `nameOf` のみ |
| `camera-frame-panel.ts` | `CelestialBodies`(21) | `nameOf` のみ |
| `rotation-zone.ts` | `CelestialBodies`(21) | `findMotion`, `nameOf` |
| `frame-labels.ts` | `CelestialBodies`(21) | `nameOf` のみ |
| `object-groups.ts` (`groupPickables`) | `CelestialBodies`(21) | `celestialMotions`, `bodyClassOf`, `nameOf` |
| `physical-object-list-order.ts` | `CelestialBodies`(21) | `starId`, `stateAt`, `isPositionInFocusedSystem` |
| `anchor-zone.ts` | `CelestialBodies`(21) | **0**(`object-groups.ts` へ中継するだけ) |
| `physical-object-list-panel.ts` | `CelestialBodies`(21) | **0**(`physical-object-list-tree.ts` / `-order.ts` へ中継するだけ) |
| `physical-object-list-tree.ts` | `CelestialBodies`(21) | **0**(`ListedObject.listDetail` へさらに中継) |

**共有できる部分集合は2つだけ確認できた**(§2 の「面はメンバの共起で割る」規則がここでも
使える):

1. `orbit-altitude-tab.ts` / `orbit-approach-tab.ts` / `orbit-projection-tab.ts` — 3枚とも
   `AnalysisTab` インターフェース(`orbit-analysis-tab.ts`)の契約 `draw(game: Game, ...)` を
   実装するために `Game` を丸ごと要求されているが、要るのは `celestialSystem` だけ(projection
   だけ経過秒数も)。**契約そのものを狭い面へ差し替えられる。**
2. `frame-controls.ts` / `trajectory-frame-panel.ts` — どちらも `DisplayWindowManager` の
   `frame` プロパティの読み書きだけ。**`{ get frame(); set frame(f) }` という2行の面で足りる。**
3. `orbit-panel.ts` / `orbit-analysis-window.ts` — 同じ5メンバ集合(`celestialSystem` /
   `activeControllable` / `orbitReference` / `navTarget` / `dynamicSystem`)を共有しているが、
   `dynamicSystem` は `orbitReference.resolve(...)` の引数として1回渡すだけの中継で、この
   5つを束ねる面に固有の名前を与えるべきかは**判断が要る**(§2 で警告した「情報をまとめる
   だけの型」に触れないよう、面の名前は概念——「軌道解決に要る材料」——を持たせること)。

**それ以外(`vessel-panel` / `enemies-panel` / `map-scale-badge` / `target-panel` /
`view-badge` / `top-bar` / `camera-frame-panel` / `frame-labels`)は、互いに素な1〜2メンバの
集合をそれぞれ別々に求めている。** これは**ユーザーの見立てを裏付ける** — HUD の直すべき形は
「ゲーム側の情報を1つの共通コンテキスト面に集約してパネルへ配る」ことではなく、**パネルごとに
独立した、他のパネルとは共有しない狭い面を都度切ること**。共通面を1つ作ってしまうと、
そこへ将来また別のパネルの都合でメンバが足され続け、今回 `Game` / `Stage` / `CameraSystem` /
`CelestialBodies` が背負っている問題をそのまま1段下で再現する。

**介入(read-only でない呼び出し)の実例**: `top-bar.ts` の `simSpeedManager.setSpeed(...)`
(`<select>` の change リスナー経由)、`orbit-analysis-window.ts` が `Game` 経由で辿り着いた
`DynamicEntity` へ書く `entity.analysisPanelReader = true/false`(`update()` 内)。
`frame-controls.ts` / `trajectory-frame-panel.ts` の `displayWindow.frame = ...` は
意図された双方向状態(基準系の選択そのもの)であり、問題のある介入ではない。

**完全な素通し(0メンバ)**: `physical-object-list-panel.ts` → `physical-object-list-tree.ts`
の2階層と `anchor-zone.ts` → `object-groups.ts` は、§3 の「`CelestialBodies` 素通し15」
(受け手54・触る39・素通し15)にすでに数えられている具体例。**実際に触っているのは
`object-groups.ts` の `groupPickables`(3メンバ)と `physical-object-list-order.ts`
(別の3メンバ)で、この2つも互いに素**——`CelestialBodies` を1つの狭い面に割り直すことは
できず(§5 の既存判定「維持」のとおり)、**中継そのものを切る(C13)のが正しい対処**。

---

## 9. 実施の順序

1. **A7 → A1**(赤道交点 → ビルボード)。どちらも `CameraSystem` の持ち回りを断つ同じ方向で、
   A7 がリスク最小。A1 は先例(`flash-effects`)がある。
2. **C1(`View` を葉へ)**。新設1ファイルだけで 19 ファイルの ctx が落ちる。手順が単純で、
   段 A〜C で `entity-kind.ts` / `pickable-listing.ts` に対してやったのと同型。
3. **B1〜B4**。機械的で判断不要。まとめて1コミット。
4. **A2 + C6**(`stage.ts` の面)。A2 は独立、C6 は面の割り方の判断が要るので後。
5. **A3 / A4 / A5 / A8 / B5 / C10**。それぞれ独立。
6. **C2 / C3**(大きいファイルの解体)。判断点があるので、上が済んでから。
7. **D1〜D3** は import の話ではないので、別のブランチに分ける。

---

## 10. 測り方(再現手順)

§1 の数字は次で出した。`tools/dep-metrics.mjs` は ctx しか出さないので、**この段の指標
(辺の本数・弱い辺・たらい回し)は `tools/` へ入っていない。** 続けるなら入れる。

- **import 文 / 識別子の本数** — `import (type )?{...} from '...'` を数え、節内の識別子を
  `,` で割る。`type` 前置のものを型のみとして別に数える。ref ごとに測るには
  `git ls-tree -r --name-only <ref> -- src` + `git cat-file --batch`。
- **弱い辺** — 辺 (f → g) について、g から引いた識別子が f の本体(import 節より後)に現れる
  回数の合計が 2 以下のもの。
- **たらい回し** — 型 T を import しているファイルで、`name: T` / `name?: T` /
  `name: readonly T[]` の形で宣言された束縛名を集め、その名前が `.` / `?.` / `[` の前に
  一度も現れないもの。**`implements` / `extends` しているファイルと、`new T` / `T(` / `T.` が
  あるファイルは除く。** union 型・関数型・mapped type と、自由関数で操作する葉の値型
  (`Vec3` `Quat` `KinematicState`)には当たらない(§3 の誤検出 2・3)。
- **前後比較は必ず同じ実装で両方を測る。** 作業木と git ref で別実装を使うと数字がずれる
  (今回、弱い辺で 1,147 と 1,173 の差が出た。表には ref 側の実装で揃えた数字を載せている)。
- 数字は `git rev-parse --short HEAD` を添えて、いつの時点かを必ず明示する。