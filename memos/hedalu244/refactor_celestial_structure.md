# 天体側の構造が GameEntity 側と非対称なこと

## 何のための文書か

`GameEntity` 側の構造(`EntityManager` → `GameEntity` → `DynamicTrajectory`)に対して、
天体側が同じ形になっていないことの**事実の記録**と、そのうち**是正すべきものと、そのままで
よいものの切り分け**。是正の手順そのものはまだ決めていない。

**`572d6343` 時点のコードから引いたスナップショットであり、正本ではない。** 食い違ったら
コードを信じる。

## 現状の保持木

```
launcher.ts  Stage.createEphemeris()         ← Ephemeris はここで new される。Game は受け取るだけ
└─ Ephemeris                                  (物理側の管理者。1インスタンス)
   ├─ registry: CelestialRegistry ………………… 参照共有。SOLAR_SYSTEM か ALT_REGISTRY
   │  └─ Record<id, CelestialBodyDef>         ← 静的パラメータの正本
   ├─ planetHelioCache / satelliteRelCache    (Map<id, TimeRing<KinematicState>>)
   ├─ allCelestialBodies / gravityAttractors / atmosphereCelestialBodies Cache
   │                                          (TimeRing<readonly CelestialBody[]>)
   ├─ frameCache: Map<center, Map<rotatingWith|null, ReferenceFrame>>
   └─ precise: OriginCenteredEphemeris | null (DE440 パックがあるときだけ)

Game
├─ _ephemeris: Ephemeris ……………………………… 参照共有(所有していない)
├─ futureCelestialBodies: FutureCelestialBodies  ← Ephemeris を候補一覧の形へ見せる薄い層
└─ _environment: EnvironmentScene             (見た目側の管理者。所有し dispose する)
   ├─ bodies: readonly CelestialView[]         ← id だけ持つ。位置・速度は持たない
   ├─ referenceLines: Map<OrbitingId, OrbitLine>
   ├─ geoLine: OrbitLine
   └─ pointFieldView: PointFieldView | null
```

`CelestialBody` はこの木に載らない。`Ephemeris.celestialBodyAt(id, t)` が**都度作る値**で、
`TimeRing` に時刻キーでメモ化されるだけ。同一 t には同一配列参照が返るので呼び出し側は
書き換えてはならない、と `celestialBodiesAt` のコメントが規定している。

### 4つの型の役割

| 型 | 場所 | 種別 | 寿命 |
| --- | --- | --- | --- |
| `CelestialBodyId` | `physics/celestial-body.ts` | `string` の別名 | — |
| `CelestialBodyDef` | `physics/solar-system.ts` | 判別 union(star / planet / satellite) | レジストリと同じ |
| `CelestialBody` | `physics/celestial-body.ts` | **クラスでない readonly 値** | 時刻 t 限り |
| `CelestialView` | `game/celestial/celestial-view.ts` | 抽象クラス(Earth / Sphere / Point / Sun) | EnvironmentScene と同じ |

3者を繋いでいるのは **`id` 文字列だけ**で、互いへの参照は張られていない。

### 2つのレジストリ

| 名前 | 場所 | 中身 | 引く側 |
| --- | --- | --- | --- |
| `CelestialRegistry` | `physics/solar-system.ts` | `Record<id, CelestialBodyDef>` | `Ephemeris` |
| `CELESTIAL_APPEARANCES` | `game/celestial/celestial-appearance.ts` | `Record<SolarSystemId, {name, create()}>` | `EnvironmentScene` |

両者を突き合わせるのは `environment-scene.ts:121-123` の1箇所だけ:

```ts
this.bodies = Object.keys(registry).map((id) =>
  id in CELESTIAL_APPEARANCES ? CELESTIAL_APPEARANCES[id as SolarSystemId].create() : fallbackCelestialAppearance(registry, id));
```

## GameEntity 側との対応

| GameEntity 側 | 天体側 |
| --- | --- |
| `EntityManager`(種別ごとの配列) | `Ephemeris` と `EnvironmentScene` の**2つ**に割れている |
| `GameEntity`(識別子 + 見た目 + 軌道 + ゲーム状態) | **対応物なし。** id / Def / CelestialBody / View の4つに散っている |
| `GameEntity.renderObject` | `CelestialView`(別オブジェクト) |
| `GameEntity.actual: DynamicTrajectory` | **対応物なし。** `Ephemeris` のメソッドで解析評価 |
| `orbitLine` / `predictedLine` / `actualLine` / `marker` を個体が所有 | `EnvironmentScene` が `Map<OrbitingId, OrbitLine>` で id 引きに所有 |
| 個体が自分の state を `renderObject` へ push | `CelestialView.sync` が `ephemeris.positionOf(this.id, t)` を pull |
| `EntityIdAllocator` が実行時に id を発行、参照同一性で識別 | id はレジストリのキー。`CelestialBody` は値で、参照同一性を持たない |

## 非対称のうち、そのままでよいもの

**天体に `DynamicTrajectory` が無いこと。** 天体の運動は任意時刻へ解析的に評価でき、積分の
履歴を溜める必要がない。個体ごとの状態オブジェクトを作れば、正本が `Ephemeris` と個体の
2箇所に増えるだけで損をする。`CelestialBody` が値であることも同じ理由で妥当。

**`CelestialView` が位置を持たないこと。** 正本が `Ephemeris` 1箇所に閉じており、
`celestial-view.ts` の冒頭コメントがその意図を明示している。

**物理と見た目が分かれていること自体。** `Ephemeris` は THREE/DOM 非依存で、
`tests/physics` から直接 compile される。ここを繋ぐと依存が壊れる。

## 是正候補

### 1. `CELESTIAL_APPEARANCES` が実行中のレジストリではなく `SOLAR_SYSTEM` を直接引いている

`planetEntry` / `satelliteEntry` / `texturedSatelliteEntry` / `solidPlanetEntry` /
`shapeOf` / `ringsOf` はすべて `bodyDef(SOLAR_SYSTEM, id)` を呼び、半径・形状・環を
**現実の太陽系から**取る。`registry` を見るのは `fallbackCelestialAppearance` だけ。

現在の `ALT_REGISTRY` は `zephyrus` / `zephyrus-i` という衝突しない id を使うため実害は
出ていないが、代替レジストリが太陽系と同じ id を別のパラメータで再定義した瞬間、
**見た目だけが現実の太陽系の値で描かれる。** 静的パラメータの正本が2箇所になる。

### 2. 「registry」という語が2つの別物を指していた(解消済み)

見た目の表を `celestial-appearance.ts`(`CELESTIAL_APPEARANCES` /
`CelestialAppearance` / `fallbackCelestialAppearance`)へ改めた。

### 3. 天体の参照軌道線の持ち主が、エンティティ側と逆

エンティティ側は**線の実体を `GameEntity` のフィールドが持ち、出す/消す/スタイルの判断は
`EntityLineManager` が持つ**という分担になっている(`refactor_trajectory.md` の結論)。
天体側は `EnvironmentScene` が**実体も判断も**両方持つ。

分担の形が揃っていないので、「天体の参照線を1本増やす」と「エンティティの線を1本増やす」で
触る場所がまるで違う。**どちらの形が正しいのかを1回決めて、両側を揃える。**

### 4. 天体1体を指すときに何を渡すかが場面ごとに違う

`id` / `CelestialBodyDef` / `CelestialBody` / `FutureBodyCandidate`(`{id, mu, radius}`)の
4通りが混在する。`FutureCelestialBodies` は 4番目を作るためだけに存在する層で、
`Ephemeris` へ直接 `candidates()` を生やせば消せる可能性がある — ただし
`FutureCelestialBodyProvider` の interface が計画側との境界を担っているので、
消してよいかは `refactor_predict_simulation_v2.md` の結論と合わせて判断する。

### 5. `CelestialBody`(値のスナップショット)をフィールドに保持している箇所

`dynamic-trajectory.ts:27` の `_extrapolationCenter: CelestialBody | null`。
値である前提(同一 t にしか意味がない)と、フィールドに置いて持ち越す使い方が噛み合っていない。
どの時刻のスナップショットなのかは `state.t` にしか書かれていない。

## 未確定

- 是正 1 の直し方 — `CELESTIAL_APPEARANCES` の各 entry を `create(def: CelestialBodyDef)` の形に
  変えて呼び出し側から渡すのが素直だが、`EarthView` / `SunView` が引数を取らないので
  署名が揃わない。
- 是正 3 の向き — 天体側を `CelestialView` 所有へ寄せるのか、エンティティ側を
  `EntityLineManager` へ寄せきるのか。
- 是正 4 を `refactor_predict_simulation_v2.md` の作業と同時にやるか、切り離すか。
  (追記 `33748733`: このファイルはもう存在しない。外部文書を待たず、下の再編の中で判断する。)

---

# 追記(`33748733`): モジュール構成調査からの合流

モジュール構成の全体調査(`module_restructure.md`、2026-08-28)のうち、天体まわりの論点を
この文書へ移した。以下は `33748733` 時点のスナップショット。

## 是正候補 1〜5 の再検証 — 5件すべて現存

- **候補1(SOLAR_SYSTEM 直引き)**: `planetEntry` / `ringsOf` / `shapeOf` / `satelliteEntry` /
  `texturedSatelliteEntry` / `solidPlanetEntry` は依然 `bodyDef(SOLAR_SYSTEM, id)` を呼ぶ
  (`celestial-appearance.ts:37,48,54,63,74,84`、`moon` エントリ直書きが `:103`)。
  `registry` を見るのは `fallbackCelestialAppearance` だけ。突き合わせ箇所は
  `environment-scene.ts:171-174` へ行番号が移動(引数増のため)。
- **候補2(registry の語)**: 未変更。`environment-scene.ts` は `CelestialRegistry`(:5)と
  `./celestial-appearance`(:38)を同じファイルで両方 import している。
- **候補3(参照線の持ち主)**: 未変更。`environment-scene.ts:126` の
  `referenceLines: Map<OrbitingId, OrbitLine>` が実体も判断(:390-428)も持つ。
  エンティティ側(実体=個体、判断=`EntityLineManager`)との非対称のまま。
- **候補4(型4通り)**: 未変更。`FutureCelestialBodyProvider`(`arc-bodies.ts:18-22`)は
  `candidates()` と `celestialBodyAt(id, t)` の2メソッドを要求する形へ変化。
  さらに5通り目として `environment-scene.ts:544-547` が `CelestialBody` を手書きリテラルで
  捏造している(`orbitalElementsOf` へ渡すためだけに `accel: v3(), degree2: null` 等を埋める)。
- **候補5(CelestialBody のフィールド保持)**: 行番号まで同一(`dynamic-trajectory.ts:27`)。
  外部の読み手 `game-entity.ts:473-474` は保持スナップショットの `state` を使わず、
  `id` だけ取り出して `ephemeris.stateOf(..., t)` を引き直している。

## 見た目の事実の分散(新規の記録)

天体1体の「見た目」を成立させる表が5つに割れている:

| 表 | 場所 | 網羅性 |
| --- | --- | --- |
| 環の光学(τ・単一散乱アルベド・位相 g) | `physics/solar-system.ts:143-159`(`RingOpticsDef`)、実値 `:393-405`(`SATURN_RINGS`) | `CelestialBodyDef` の一部。**見た目の量が physics にある** |
| `CELESTIAL_ALBEDO`(82天体の線形 RGB ボンドアルベド) | `render/celestial-albedo.ts:34-117` | 緩い `Record<string,_>`、網羅強制なし |
| `CELESTIAL_TEXTURES` / `EARTH_TEXTURES`(url・albedoScale・bondAlbedo・averageHue) | `render/celestial-textures.ts:39-67` | 同上 |
| `ATMOSPHERE_OPTICS`(earth / mars。「大気の見た目を持つ天体」の正本) | `render/atmosphere.ts:20-39` | 同上。physics 側 `AtmosphereDef`(抗力用の密度層)とは別の分布 |
| `CELESTIAL_APPEARANCES`(日本語名 + View 選択) | `game/celestial/celestial-appearance.ts:97-203` | `SolarSystemId` で網羅 |

付随する事実:

- 「その天体の色」を知るには texture 表と albedo 表の**両方**を通る関数を経由する
  (`celestial-albedo.ts:26,131,144` が texture 側へ分岐する)。
- 「月だけ表面ラインを持つ」は `celestial-appearance.ts:104` の手書きファクトリ1行で表現され、
  `SphereView` の第8引数を使うのはこの1箇所のみ。
- 参照軌道線の色(`SATELLITE_REFERENCE_LINE_COLOR` 等)は `environment-scene.ts:64-65` に直置き。
- render → physics の import は13箇所(`ring.ts:18` が環の光学定義を physics から引く、等)。
  game/celestial → render の import は albedo / texture / atmosphere-optics /
  メッシュ部品(`CelestialSurface` / `MoonSurfaceMarkings` / `createSun` 等)に及ぶ。
  この分担自体は `celestial-appearance.ts:4-5` のコメントで意図されたもの。

## 再編の方向(ユーザー判断、2026-08-28)— これから具体化する

**目的は「見た目の集約」ではない。** 単に1箇所へ集めるだけでは、そのモジュールが肥大するだけ。

- **天体レジストリの登録/削除を整理する。** そのために管理データ構造と各天体を表すクラスを
  整理し、各天体のデータや個別の事象(リング・オーロラ・大気など)を**多態的に**扱う。
  表による集約ではなく、再分割を含む。
- **`solar-system.ts` の分離を含む**(大気や輪の実データはその天体のクラスへ)。
  当初「地学系の分離」と呼んでいた懸念の実体はこれ(atmosphere / thermal 等の関数群ではない)。
- 太陽系を表すコードが physics / game / render に跨って肥大しているため、
  **`src/` 直下に `celestial/` を新設することも視野に入れる。**
- `FutureCelestialBodies` との密結合は合意済みで、この再編の中で扱う
  (旧 `refactor_predict_simulation_v2.md` の結論待ちという条件は消滅 — ファイルが存在しない)。
- 参照線の持ち主の非対称(候補3)も、この再編と結合して「どちらの形が正しいか」を決める。
- 候補1(SOLAR_SYSTEM 直引き)の直し方も、再編後の形が決まってから。

どのように問題があり、どのように是正可能かをここで練るのが次の作業。上の保持木・
型の対応表・見た目の分散が、その検討の材料になる。
