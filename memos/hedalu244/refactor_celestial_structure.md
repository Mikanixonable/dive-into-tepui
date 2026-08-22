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
| `CELESTIAL_VIEWS` | `game/celestial/celestial-registry.ts` | `Record<SolarSystemId, {name, create()}>` | `EnvironmentScene` |

両者を突き合わせるのは `environment-scene.ts:121-123` の1箇所だけ:

```ts
this.bodies = Object.keys(registry).map((id) =>
  id in CELESTIAL_VIEWS ? CELESTIAL_VIEWS[id as SolarSystemId].create() : fallbackCelestialView(registry, id));
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

### 1. `CELESTIAL_VIEWS` が実行中のレジストリではなく `SOLAR_SYSTEM` を直接引いている

`planetEntry` / `satelliteEntry` / `texturedSatelliteEntry` / `solidPlanetEntry` /
`shapeOf` / `ringsOf` はすべて `bodyDef(SOLAR_SYSTEM, id)` を呼び、半径・形状・環を
**現実の太陽系から**取る。`registry` を見るのは `fallbackCelestialView` だけ。

現在の `ALT_REGISTRY` は `zephyrus` / `zephyrus-i` という衝突しない id を使うため実害は
出ていないが、代替レジストリが太陽系と同じ id を別のパラメータで再定義した瞬間、
**見た目だけが現実の太陽系の値で描かれる。** 静的パラメータの正本が2箇所になる。

### 2. 「registry」という語が2つの別物を指している

`CelestialRegistry`(静的事実の表)と `celestial-registry.ts`(見た目の表)。
CODING-RULE の「類義語の混雑」「曖昧な区別」に当たる。どちらかを改名する。

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

- 是正 1 の直し方 — `CELESTIAL_VIEWS` の各 entry を `create(def: CelestialBodyDef)` の形に
  変えて呼び出し側から渡すのが素直だが、`EarthView` / `SunView` が引数を取らないので
  署名が揃わない。
- 是正 3 の向き — 天体側を `CelestialView` 所有へ寄せるのか、エンティティ側を
  `EntityLineManager` へ寄せきるのか。
- 是正 4 を `refactor_predict_simulation_v2.md` の作業と同時にやるか、切り離すか。
