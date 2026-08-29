# celestial / dynamic 再編 — 計画

## 目的

`2d55148b`〜`afbb5ab4` の再編で、天体側は「運動と見た目を1つの所有木へ載せる」形まで到達した。
そこで表面化したのが**二重の非対称**である。

1. **命名と置き場の非対称。** 解析暦で動く側(`game/celestial/`)と数値積分で動く側
   (`game/simulation/` + `game/game-entity/`)は構造的に同じものを持つのに、族語
   (`celestial` ⇄ `game`)も役割語(`System` ⇄ `Manager`)も対応していない。個体を指す語も
   `CelestialEntity` ⇄ `GameEntity` ⇄ `bodies` と3通りに割れている。
2. **責務の非対称。** `game/celestial/` が「何があるか」に加えて「いくつまで扱えるか・
   どれを選ぶか」という描画予算の判断まで持っている。予算もスロット本数も
   `render/pipeline/` 側の実装が決めるものなので、判断の正本が game 側にあると、スロットを
   増減するたびに game を書き換えることになる。

**この計画が終わった状態:**

- 族語が `celestial` / `dynamic` の2つに固定され、役割語が `Entity` / `System` に固定される。
  `GameEntity`・`EntityManager`・`bodies` という同義別語が消える。
- `src/game/celestial/` と `src/game/dynamic/` が同じ形(個体のフォルダ + 系のクラス)を持つ。
- 「どの天体を光源にするか」「いくつ遮蔽器を採るか」「どの環の影を落とすか」「環境光をどれだけ
  足すか」の判断が `src/render/` にあり、`src/game/` は候補を渡すだけになる。
- 検査で見つけた死にコード・置き場違い・過剰 export が消える。

**挙動は変えない。** 全手順を通して、絵・セーブの形・操作は再編前と同じでなければならない。

---

## 決めたこと

ユーザーが覆せる判断として、先に4つ置く。覆るとどの手順が変わるかも書く。

### 決定1. 族語は `celestial` / `dynamic`、役割語は `Entity` / `System`

`DEVELOP/CODING-RULE.md` 2.2「`orbit` / `ephemeris` / `celestial` / `dynamic`」が既に語を
固定している —

- **`celestial`** … 天体という存在そのもの。位置は時刻から解析的に決まる(`CelestialMotion`)。
- **`dynamic`** … 数値積分に基づくもの。位置は積分で決まる(`DynamicTrajectory`)。

`GameEntity` の実体は `DynamicTrajectory` を持つ個体なので、**`DynamicEntity` は既存の規則
から素直に出る。** 逆に `game` は置き場の名前であって族語ではないから、型名から外す。
`entity`(運動と見た目を統合したもの)はどちらの族にも付く共通語なので、族語ではなく被修飾語
として残す。

役割語は `System` に揃える。`CelestialSystem` の `System` は「星系」という領域語でもあり、
これを動かさずに揃えられるのは `System` の側だけであるため(`Manager` へ寄せると星系の読みが
消える)。既存クラスも `CameraSystem` / `PowerSystem` / `RadiatorSystem` / `EffectsSystem` と
`System` 側に前例がある。

**覆されたら:** 役割語を `Manager` にするなら下の対応表の `System` 行だけが変わる。族語を
`dynamic` 以外(`sim` など)にするなら手順9・10・11の全体が変わる。

#### 対応表 — 旧名から新名へ

**型・クラス**

| 旧 | 新 | 手順 |
| --- | --- | --- |
| `GameEntity` | `DynamicEntity` | 9 |
| `EntityManager` | `DynamicSystem` | 10 |
| `MapEntityKind` | `DynamicEntityKind` | 6 |
| `BodyClass` | `CelestialClass` | 6 |
| `BodyClassLookup` | `CelestialClassLookup` | 6 |
| `BodyClassToggles` | `MapDisplayToggles` | 6 |
| `BodyClassDisplayMode` | `MapDisplayMode` | 6 |
| `CelestialSystem` | (変えない — `System` は「星系」の読みを兼ねる) | — |
| `CelestialEntity` / `SphereEntity` / `StarEntity` / `PointEntity` | (変えない) | — |

**関数・定数・メンバー**

| 旧 | 新 | 手順 |
| --- | --- | --- |
| `CelestialSystem.bodies` | `.entities` | 11 |
| `CelestialSystem.bodiesById` | `.entitiesById` | 11 |
| `CelestialSystem.bodyOf(id)` | `.entityOf(id)` | 11 |
| `CelestialSystem.starBody` | `.starEntity` | 11 |
| `MapVisibilityPolicy.body(id)` | `.celestial(id)` | 6 |
| `MapVisibilityPolicy.entity(kind)` | `.dynamic(kind)` | 6 |
| `bodyClassOfKind` | `celestialClassOfKind` | 6 |
| `bodyClassVisible` / `bodyNameVisible` | `celestialClassVisible` / `celestialNameVisible` | 6 |
| `bodyClassDisplayMode` / `nextBodyClassDisplayMode` / `applyBodyClassDisplayMode` / `applyBodyClassToggle` | `bodyClass` → `celestialClass` へ置換 | 6 |
| `DEFAULT_BODY_CLASS_TOGGLES` | `DEFAULT_MAP_DISPLAY_TOGGLES` | 6 |
| `normalizeBodyClassToggles` | `normalizeMapDisplayToggles` | 6 |
| `CameraSystem.bodyClassToggles` | `.mapDisplayToggles` | 6 |
| `Game.entities`(`EntityManager` の保持) | `Game.dynamicSystem` | 10 |
| `celestialBodiesAt` / `celestialBodyAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt` | (変えない — physics の `CelestialBody` を返す口で、既に有標) | — |

**ファイル・フォルダ**

| 旧 | 新 | 手順 |
| --- | --- | --- |
| `game/game-entity/` | `game/dynamic/dynamic-entity/` | 9 |
| `game/game-entity/game-entity.ts` | `game/dynamic/dynamic-entity/dynamic-entity.ts` | 9 |
| `game/simulation/` | `game/dynamic/` | 10 |
| `game/simulation/entity-manager.ts` | `game/dynamic/dynamic-system.ts` | 10 |
| `game/simulation/arc-bodies.ts` | `game/dynamic/arc-celestial-bodies.ts` | 10 |
| `game/simulation/substep-bodies.ts` | `game/dynamic/substep-celestial-bodies.ts` | 10 |
| `game/simulation/sim-epoch.ts` | `game/sim-epoch.ts` | 10 |
| `game/celestial/{celestial-entity,celestial-entity-def,sphere-entity,star-entity,point-entity,ring-view,geostationary-overlay}.ts` | `game/celestial/celestial-entity/` へ | 8 |
| `game/celestial/{orbit-guide-*,guide-curve,direction-markers,zero-velocity-lines}.ts` | `game/celestial/orbit-guide/` へ | 7 |
| `game/celestial/body-visibility.ts` | `game/map/display-toggles.ts` + `game/celestial/system-membership.ts` に分割 | 6 |
| `game/celestial/map-visibility.ts` | `game/map/visibility-policy.ts` | 6 |
| `game/celestial/planet-light.ts` | `render/pipeline/lighting/planet-light-select.ts` | 2 |
| `game/celestial/solar-system/point-field-view.ts` | `game/celestial/point-field-view.ts` | 5 |
| `game/celestial/solar-system/` | (変えない — 決定3) | — |
| `game/player/` | (変えない — 個体の族で切るフォルダではない) | — |

### 決定2. `src/game/dynamic/` を作り、`simulation/` と `game-entity/` をその下へ畳む

到達形:

```
src/game/celestial/               解析暦で動く側
  celestial-entity/               個体1体とその派生
  celestial-system.ts             個体の集合 + 毎フレーム同期
  orbit-guide/                    ラグランジュ軌道ガイド
  solar-system/                   具体的な系の組み立て

src/game/dynamic/                 数値積分で動く側
  dynamic-entity/                 個体1体とその派生
  dynamic-system.ts               個体の集合 + 毎フレーム同期
  <積分機構>                      simulator / predictor / contact / time-step …
```

**完全な対称にはならないし、してはいけない。** 2点の非対称は説明できる形で残す。

- **`celestial/` に積分機構が無い。** 天体の運動は個体ごとに閉じた式で解けるので
  `physics/celestial-motion.ts` が持つ。積分は個体を跨ぐ(重力・接触)ので game 側に要る。
- **`dynamic/` に「組んで返すもの」が無い。** 顔ぶれを決めるのは `game/stages/` である。

**覆されたら:** `simulation/` の名前を残す判断なら、手順10は `simulation/dynamic-entity/` へ
畳む形に変わる(移動先が変わるだけで、書き換えるファイル数は同じ)。

### 決定3. `solar-system/` は `celestial/` の下に残す

`game/` 直下や `src/` 直下へ出しても、`celestial-entity/` の全クラスを import する事実は
変わらないので、import パスが伸びるだけで依存は1本も減らない。

ただし**手順5で `celestial/` 直下から `solar-system/` への import を 0 にする** ので、
その後は「上位が下位を知らない」状態になり、出そうと思えばいつでも出せる。出すかどうかは
その時点の好みで決められる。

**覆されたら:** 手順5の後に `git mv` 1回と import の一括書き換えを足すだけで済む。

### 決定4. `memos/` も全部直す。ただし**いま解決する名前だけ**を直す

CODING-RULE 1.10 の全文検索対象(`src` `tests` `DEVELOP` `CLAUDE.md` `.claude` `memos`)を
そのまま採る。`memos/*/archived/` `done/` も含めて全員を直す —
**記録は git が持っており、次に memos を読む人が旧名で混乱する損のほうが大きい**(ユーザー判断)。
`tests/dist/` だけは `npm run test:build` が毎回消して作り直す生成物なので触らない。

**ただし一括置換をそのまま当ててはいけない。** `memos/` が指す
`src/game/{celestial,simulation,game-entity}/*.ts` のパスは 40 種あり、**そのうち 22 種は
既に死んでいる** — `environment-scene.ts` `celestial-registry.ts` `sphere-view.ts`
`sun-view.ts` `earth-view.ts` `point-body.ts` `sphere-body.ts` `asteroid-field.ts`
`ring-lod.ts` `celestial-appearance.ts` `celestial-view.ts` `point-field.ts`
`simulation/contact.ts` `collision.ts` `attractor-window.ts` `entity-id.ts`
`future-celestial-bodies.ts` `game-entity/vessel.ts` `vessel-frame.ts` `blueprint.ts`
`ammo.ts` — いずれも過去の再編で消えたファイルを指している。

これを機械的に置換すると `game/simulation/contact.ts` が `game/dynamic/contact.ts` になり、
**同じく存在しないのに現役のパスに見える** ものが増える。旧名のままなら「古い記述だ」と
分かるので、置換したほうが悪い。

**したがって手順13の規則はこうする。**

- **識別子(`GameEntity` / `EntityManager` / `BodyClassToggles` …)は無条件に置換する。**
  型名は当時も今も同じものを指しており、パスのような曖昧さが無い。
- **パスは `HEAD` に実在するものだけ置換する。** 実在しないパスは触らない。
- **どちらとも取れる記述(フォルダ名だけの言及など)は、周囲の文が現役の構造を説明している
  ときだけ直す。**

**覆されたら:** 「死んだパスも一律に置換する」なら手順13の規則が1行になり、作業量は減るが、
上の理由でこちらは薦めない。

---

## 達成目標

全手順の実施後、次をすべて満たす。判定はコマンドの出力で行う。

| # | 目標 | 判定 |
| --- | --- | --- |
| 1 | `GameEntity` が消滅 | `grep -rn "\bGameEntity\b" src tests tools DEVELOP .claude CLAUDE.md memos` が 0 件 |
| 2 | `EntityManager` が消滅 | 同上で `\bEntityManager\b` が 0 件 |
| 3 | 旧フォルダが消滅 | `src/game/game-entity/` と `src/game/simulation/` が存在しない |
| 4 | 新フォルダが存在 | `src/game/dynamic/dynamic-entity/` と `src/game/dynamic/dynamic-system.ts` が存在する |
| 5 | 天体個体のフォルダが存在 | `src/game/celestial/celestial-entity/` が存在する |
| 6 | 上位が下位を知らない | `grep -rn "solar-system" src/game/celestial/*.ts` が 0 件 |
| 7 | 同義別語 `body` の解消 | `grep -nE "\bbodies\b\|\bbodyOf\b\|\bstarBody\b" src/game/celestial/celestial-system.ts` が 0 件(`celestialBodiesAt` など physics 由来の複合語は残ってよい) |
| 8 | 描画予算の判断が game に無い | `grep -rn "MAX_OCCLUDERS\|MAX_PLANET_LIGHT_SLOTS\|MIN_OCCLUDED_FRACTION\|AMBIENT_STRONG\|AMBIENT_WEAK" src/game/` が 0 件 |
| 9 | `planet-light.ts` が game に無い | `src/game/celestial/planet-light.ts` が存在しない |
| 10 | 死んだ二重呼出規約が消滅 | `NearbySystemTracker` の `new` が `src/game/` に1箇所(`map-pickables.ts`)だけ |
| 11 | 過剰 export の解消 | 手順12のスクリプトが報告する「他ファイルから参照されない export」が、意図して公開契約に残したもの以外 0 件 |
| 12 | 型と回帰テストが green | `npm run typecheck` と `npm run test`(全層)が通る |
| 12b | `memos/` に旧名が残らない | `grep -rnE "\bGameEntity\b\|\bEntityManager\b\|\bBodyClassToggles\b\|\bMapEntityKind\b\|game/game-entity\|game/simulation\|celestial/(body\|map)-visibility\|celestial/planet-light" memos` が 0 件 |
| 12c | `memos/` に**新しく作られた**死んだパスが無い | 手順13の判定スクリプトが報告する「`HEAD` に存在しない `src/...` パス」が、手順13の着手前と**同じ 22 種のまま**(1 種も増えていない) |
| 13 | 描画パスが不変 | `npm run render-lab:shot` の 35 枚が手順1着手前の PNG と byte 一致 |
| 14 | 絵が不変 | `npm run dev` で日食・土星の環の影・地球照・マップの参照軌道線が着手前と同じに見える |

**目標13は「描画パスが変わっていないこと」しか言えない。** render-lab は自前でシーンを組んで
`SunOcclusion.setOccluders()` を直接呼ぶので、`CelestialSystem` を1行も通らない。**選定そのものが
正しく移ったことは目標14と、手順2・3で作る一時的な同値テストでしか確かめられない。**

---

## 手順

### 手順10. `simulation/` → `dynamic/`、`EntityManager` → `DynamicSystem`

**目的.** 積分側の集合クラスを `CelestialSystem` と対になる名前にし、積分機構を個体と同じ
`dynamic/` の下へ集める。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/` | `src/game/simulation/` の 18 ファイルを `git mv` する |
| `.../entity-manager.ts` → `src/game/dynamic/dynamic-system.ts` | `export class EntityManager` → `export class DynamicSystem` |
| `.../arc-bodies.ts` → `.../arc-celestial-bodies.ts` | 無標の `body` を接辞から外す(CODING-RULE 2.2)。中の `FutureCelestialBodyProvider` は既に有標なので変えない |
| `.../substep-bodies.ts` → `.../substep-celestial-bodies.ts` | 同上 |
| `src/game/game.ts:141,157-221 ほか` | `this.entities` フィールドを `this.dynamicSystem` へ改名し、`celestialSystem` と対で読めるようにする |
| `EntityManager` を参照する 36 ファイル(98 箇所) | 識別子を差し替える |
| `simulation/` を import する 50 ファイル | パスを直す |
| `src/game/dynamic/sim-epoch.ts` → `src/game/sim-epoch.ts` | `simulation/` の中から誰も import しておらず(利用は `hud/` `plan/` `save/` `stages/` の7ファイル)、内容も暦の元期定数で積分機構ではない。積分側のフォルダから出す |
| `.claude/skills/overview/SKILL.md:28` / `.claude/skills/CODE-SNAPSHOT.md:26,56` | 名前を直す |

**達成条件と検証**

- `grep -rn "\bEntityManager\b" src tests tools DEVELOP .claude CLAUDE.md` が 0 件。
- `src/game/simulation/` が存在しない。
- `grep -rnE "\b(arc|substep)-bodies\b" src tests tools` が 0 件。
- `npm run typecheck` / `npm run test`(全層)が通る。
- `npm run dev` — 敵の湧き・弾・破片・基地の生成と消滅、時間加速、予測軌道線が着手前と同じに
  動くことを見る。

---

### 手順11. `CelestialSystem` の `body` を `entity` へ揃える

**目的.** `CelestialSystem` が `CelestialEntity` の配列を `bodies` と呼び、`bodyOf` で引いている。
**`body` と `CelestialEntity` が同義別語になっている**うえ、同じクラスの
`celestialBodiesAt(t)` は physics の `CelestialBody` を返すので、`bodies` と
`celestialBodies` が別物という読みづらさが生まれている。個体は `entity`、physics の値は
`celestialBody` に固定する。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-system.ts` | `bodies`→`entities`、`bodiesById`→`entitiesById`、`bodyOf`→`entityOf`、`starBody`→`starEntity`。`celestialBodiesAt` / `celestialBodyAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt` / `defs` / `motions` は physics の値を返す口なのでそのまま |
| `src/game/celestial/solar-system/solar-system.ts` ほか構築側 | `new CelestialSystem(bodies, …)` のローカル名を `entities` へ |
| `celestialSystem.bodyOf(` を呼ぶ全ファイル | `entityOf(` へ |

`memos/` はここでは触らない — 改名がすべて確定してから手順13でまとめて1回だけ通す。

**達成条件と検証**

- `grep -nE "\bbodies\b|\bbodyOf\b|\bstarBody\b" src/game/celestial/celestial-system.ts` が 0 件。
- `grep -rn "\.bodyOf(" src tests tools` が 0 件。
- `npm run typecheck` / `npm run test`(全層)が通る。

---

### 手順12. 他ファイルから参照されない export を絞る

**目的.** モジュールの公開面が実際の利用より広い。`export` されているのに他のどのファイルからも
参照されない識別子が、`celestial/` `simulation/` `game-entity/` 合計で 100 以上ある(うち 94 は
`solar-system/` の天体 Def 定数)。CODING-RULE 1.11 は公開範囲を「外部へ約束するかどうか」で
決めよと言うので、**約束する意図があるものは残し、それ以外を落とす。**
**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/solar-system/{inner-planets,mars-system,jupiter-system,saturn-system,uranus-system,neptune-system,dwarf-planets,small-bodies}.ts` | 同一ファイル内でしか使われない天体 Def 定数(94 個)から `export` を外す。**`SUN` / `EARTH` / `MOON` / `JUPITER` / `MARS` / `SATURN` など、他ファイル(`point-field.ts`・`tools/render-lab/cases.ts`・`tools/export-lagrange-orbits.mjs`)が引くものは残す** |
| `src/game/celestial/solar-system/point-field.ts` | `SizeDistribution` / `ResonanceDistribution` / `PointFieldDef` / `ASTEROID_SEED` / `POINT_FIELD_DEFS` の `export` を、`tests/game/point-field.test.ts` が引くものだけに絞る |
| `src/game/celestial/orbit-guide/orbit-guide-kind-ids.ts:95` | `buildCombinedId` の `export` を外す |
| `src/game/celestial/orbit-guide/orbit-guide-catalog.ts:11` | `zeroVelocityMu` の `export` を外す |
| `src/game/celestial/planet-distance.ts:9,11` | `NearestPlanet` / `findNearestPlanet` の `export` を外す(外から使うのは `targeter.ts` が引く `nearestPlanetDistance` と `mapPlanetFadeOpacity` だけ) |
| `src/game/map/display-toggles.ts` | `applyBodyClassToggle` 由来の関数の `export` を、UI が呼ぶものだけに絞る |
| `src/game/dynamic/entity-state-at.ts:13` | `trajectoryStateAt` の `export` を外す |
| `src/game/dynamic/dynamic-entity/{ammo-pickup,base,bullet,detached-booster,enemy,parts,rcs-fuel-pickup}.ts` | `*Init` 型・`BaseDockSlot` / `BaseState` / `Shooter` / `BulletType` / `HullPart` / `BASE_THRUST` のうち、**セーブの形を表す型は残し**(`save-data.ts` から辿れる契約)、コンストラクタ引数のためだけの型から `export` を外す |

**判定スクリプト**(この手順の検証にも使う)—

```bash
for f in $(find src/game/celestial src/game/dynamic -name '*.ts'); do
  grep -ohE "^export (const|function|class|abstract class|type|interface|enum) [A-Za-z_][A-Za-z0-9_]*" "$f" \
  | sed 's/.* //' | while read -r n; do
    c=$(grep -rlE "\b$n\b" src tests tools --include=*.ts --include=*.mjs 2>/dev/null \
        | grep -v "tests/dist" | grep -v "^$f$" | wc -l)
    [ "$c" -eq 0 ] && echo "$f :: $n"
  done
done
```

**達成条件と検証**

- 上のスクリプトの出力が、意図して公開契約に残したもの(セーブの形を表す型など)だけになる。
  残したものはそのファイルの先頭コメントに理由を1行で書く。
- `npm run typecheck` / `npm run test`(全層)が通る。

---

### 手順13. `memos/` の旧名を一掃する

**目的.** `memos/` の 71 ファイルが、この計画で消える名前を持っている。次に memos を読む人が
旧名で現在のコードを探して見つからない、という混乱を避ける。**改名がすべて確定した後に
1回だけ通す** — 手順ごとに通すと、同じ 71 ファイルを4回書き換えることになる。

**この手順はコードを1行も変えない。** 型検査も回帰テストも、この手順の前後で同じ結果になる。

**着手前に必ず取り直す基準値.** 判定スクリプト(下)を**先に**走らせ、「`HEAD` に存在しない
パス」の一覧を控える。**この数が増えていないこと**がこの手順の合格条件そのものである
(達成目標 12c)。

```bash
# memos が指す game/ 側のパスのうち、HEAD に存在しないもの。
# 範囲をこの計画が触るフォルダに絞る — src/ 全体で測ると、この計画と無関係な陳腐化
# (着手時点で 105 種。render/ physics/ や過去に消えた game/ の他フォルダ)まで数え、
# 22 の増減が埋もれて読めなくなる。
# この計画自身は「これから作るパス」を書いているので数えない。
grep -rhoE "src/game/(celestial|simulation|game-entity|dynamic|map)/[a-z0-9./-]*\.ts" \
     --include='*.md' --exclude='refactor_celestical2.md' memos \
  | sort -u | while read -r p; do [ -f "$p" ] || echo "STALE $p"; done
```

**この計画の着手前(`afbb5ab4`)の値は 22 種**で、決定4に列挙したものと一致する。ただし
**手順5 が `src/game/celestial/point-field-view.ts` を実在させる**ので、手順13 に着手する
時点では **21 種**に減っているはずである(このパスを現役として書いている memos が4ファイル
あり、手順5 で自動的に正しくなる)。**だから着手直前に取り直す** — 着手前に控えた 22 を
そのまま当てると、正しく減ったぶんで落ちる。

**変更が必要な箇所**

範囲は 71 ファイル。分布は `memos/mikanixonable/done/` 29、`memos/mikanixonable/` 直下 9、
`memos/mikanixonable/軽量化/` 7、`memos/hedalu244/` 直下 7、`memos/mikanixonable/archived/` 5、
`memos/mikanixonable/recture/` 4、`memos/hedalu244/better_graphics/` 3、
`memos/mikanixonable/suspended/` 2、`memos/arx-ein/audio-restructure/` 2、その他 3。

| 対象 | 何をするか |
| --- | --- |
| 識別子 — `GameEntity`(22 ファイル)・`EntityManager`(24)・`BodyClass*`(3)・`MapEntityKind`(1)・`bodyOf`(1) | **無条件に一括置換する。** 決定1の対応表のとおり |
| パス — `HEAD` に実在する 18 種(`game-entity/game-entity.ts` `simulation/entity-manager.ts` `simulation/predictor.ts` `celestial/planet-light.ts` `celestial/{body,map}-visibility.ts` `celestial/orbit-guide-*.ts` `celestial/ring-view.ts` ほか) | 新しいパスへ置換する |
| パス — `HEAD` に無い 22 種(決定4に列挙) | **触らない。** 旧名のままなら「古い記述」と読めるが、置換すると現役に見える死んだパスが増える |
| フォルダ名だけの言及(`game/simulation` `game-entity/` など) | 周囲の文が**現役の構造**を説明しているときだけ直す。過去の設計判断を述べている文はそのまま |
| `memos/hedalu244/refactor_game.md:64-72`(論点4) | 生きているバックログ。新しい名前・パスへ直し、`System` / `Manager` の非対称は解消済みなのでその一文を落とす。手順6でマップ表示ポリシーが `game/map/` へ出たぶん `game/celestial/` の game 依存が1つ増えた事実も、判断材料として書き足す |
| `memos/hedalu244/module_restructure.md` | 「残っている宿題」の `const.ts` の記述を、手順4で `CELESTIAL_SHELL_RADIUS` が抜けたぶん更新する |
| このファイル(`memos/hedalu244/refactor_celestical2.md`) | 実施済みの計画なので、`refactor_celestical.md` と同じ形の**完了記録**へ書き換える |

**範囲外に手を出さない。** 調べた結果、`memos/` はこの計画と無関係に陳腐化したパスを
**105 種**持っている(`render/` `physics/` や、過去に消えた `game/` の他フォルダ)。
どれもこの再編では動かないので**触らない。** 直すなら別の作業として切り出す
(そのときも「実在するものだけ直す」規則は同じ)。

**配り方.** 71 ファイルの機械的な置換なので、サブエージェントへ配る。**ディレクトリで分けて
範囲を重ねない** — `memos/mikanixonable/done/`(29)、`memos/mikanixonable/` のそれ以外(23)、
`memos/hedalu244/` + `memos/arx-ein/`(13)の3つに割れる。**「触らないパス 22 種」の一覧を
指示に必ず含める** — これが無いと各エージェントが良かれと思って死んだパスを書き換える。

**達成条件と検証**

- `grep -rnE "\bGameEntity\b|\bEntityManager\b|\bBodyClassToggles\b|\bMapEntityKind\b" memos` が 0 件。
- `grep -rn "game/game-entity\|game/simulation" memos` の残りが、**決定4に列挙した死んだパスを
  含む行だけ**になる。
- 上の判定スクリプトの出力が、着手前と同じ 22 種(1 種も増えていない)。
- `npm run typecheck` が通る(memos はビルドに入らないので当然通るが、**巻き添えで `src/` を
  触っていないことの確認**として打つ)。
- `git diff --stat -- src tests tools` が空であること。

---

## 見積り

**単位は「触るファイル数」**(移動するファイル + import か識別子を書き換えるファイル)。
`afbb5ab4` 時点の grep から導出する。行数ではなくファイル数で測るのは、この計画の作業量が
**一括置換の適用範囲**でほぼ決まるため。

| 手順 | 導出 | 触るファイル |
| --- | --- | --- |
| 1 | celestial-system + focus-markers + map-pickables + game.ts | 4 |
| 2 | 新規1 + 削除1 + celestial-system + 一時テスト1 | 4 |
| 3 | 新規1 + celestial-system + 一時テスト1 | 3 |
| 4 | ambient-source + stars + sun-light + map-camera + const + celestial-system | 6 |
| 5 | point-field + point-field-view + celestial-system + solar-system | 4 |
| 6 | 新規3 + 削除2 + entity-def + import 側 11 + テスト1 | 18 |
| 7 | 移動7 + import 側 18(重複除く) | 20 |
| 8 | 移動7 + import 側 25(重複除く) | 27 |
| 9 | 移動21 + import 側 67 + `.claude` 2(重複除く) | 78 |
| 10 | 移動19 + import 側 50 + `.claude` 2(重複除く) | 60 |
| 11 | celestial-system + 構築側9 + 呼び出し側(`bodyOf` 参照) | 14 |
| 12 | solar-system 8 + その他 10 | 18 |
| 13 | memos の該当 71(done 29 / mikanixonable 直下 9 / 軽量化 7 / hedalu244 直下 7 / archived 5 / recture 4 / better_graphics 3 / suspended 2 / arx-ein 2 / その他 3) | 71 |

合計 **約 327 ファイル・のべ 13 commit**(1手順 1 commit)。手順9・10・13 の3つで全体の
6 割を占め、どれも機械的な一括置換なので**サブエージェントへ配れる**。ただし
**手順9 と手順10 は同時に配らない**(`entity-manager.ts` が `game-entity/*` を import して
いるので範囲が重なる)。手順13 は3ディレクトリへ割って同時に配れる。

**手順13 だけは検証コストがほぼ 0** — memos はビルドにもテストにも入らないので、
`npm run test`(全層)を回す必要がない。ファイル数のわりに安い手順である。

検証の実時間は `npm run test`(全層)が 1 回あたり `test:build`(`tsc -p tsconfig.test.json`)を
含むため支配的。手順9・10・11・12 は全層を回すので、**その4回ぶんが検証コストの大半**になる。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| render-lab は `CelestialSystem` を1行も通らない(自前でシーンを組んで `setOccluders` を直接呼ぶ)。手順2〜4の選定移動を「35 枚 byte 一致」で通したと誤認する | 選定の順序や閾値が変わっていても気付かないまま先へ進む。絵に出るのは日食・環の影という特定の構図だけなので、後から原因を切り分けにくい | 手順2・3。**一時的な同値テストと `npm run dev` の目視が本体の検証で、render-lab は補助**という位置付けを守る |
| `npm run render-lab:shot` は毎回 `memos/mikanixonable/protein-motion-baseline.json` を無条件に書き換える | ユーザー所有の memos が撮影の副作用で汚れる。`git stash` が黙って失敗する原因にもなる | 手順8・13(目標13)。撮影の後は必ず `git status` を見て、このファイルを `git checkout --` で戻す |
| `tools/export-lagrange-orbits.mjs:58-60` と `tools/export-moon-features.mjs:18` が `game/celestial/solar-system/*` をパス文字列で読む。`tools/compile-source.mjs:40` のコメントも同じパスを持つ | 手順7・8でフォルダを動かすと焼き込みが実行時に落ちる。`npm run typecheck` も `npm run test` も通るので、**気付くのは焼き込みを走らせたときだけ** | 手順7・8。パス文字列は型検査に映らないので、`grep -rn "game/celestial\|game/simulation\|game-entity" tools/` を各手順の最後に必ず打つ |
| 焼き込みアセットの再生成は、`physics/` 側が byte 一致でも 1e-13 規模の差を出すことがある(実行環境の違いに由来) | 差分だけ見て「再編で壊した」と誤診し、直さなくてよいものを直しに行く | 手順7・8。**再生成物は commit しない。** 焼き込みは「落ちずに走り切るか」だけを見る |
| `MapVisibilityPolicy` を `game/map/` へ出すと、`celestial-system.ts` が `game/map/` を import する形になり、`game/celestial/` の game 依存が1つ増える | `refactor_game.md` 論点4 の「`src/celestial/` へ出す」案がさらに遠のく | 手順6。**この計画は `src/celestial/` へ出すことを目標にしていない。** 遠のく事実を論点4へ書き足して、判断材料として残す |
| `BodyClassToggles` のキー名(`planetVisible` 等)は表示設定として `localStorage` に載りうる | 型名だけを変えるつもりでキー名まで変えると、ユーザーの表示設定が既定へ戻る | 手順6。**キー文字列は1つも変えない。** 変えるのは型名・関数名・フィールド名だけ |
| `arc-bodies` / `substep-bodies` の改名で、`FutureCelestialBodyProvider` を `implements` している側との対応が読めなくなる | 型の実装関係が分かりにくくなるだけで壊れはしないが、後から追う人が迷う | 手順10。改名後のファイル先頭コメントで、その `Provider` を満たすのが誰かを1行で述べる |
| 手順12 で `export` を外した識別子が、実は `tools/*.mjs` から**動的に**読まれている(`loadSourceModules` はモジュール名の文字列でロードする) | `npm run typecheck` も `npm run test` も通り、焼き込みだけが実行時に `undefined` で落ちる | 手順12。判定スクリプトの検索対象に `--include=*.mjs` を必ず含める(上の script はそうしてある)。加えて `node tools/export-moon-features.mjs` を1回走らせて通ることを見る |
| 手順9・10 をサブエージェントへ同時に配ると、`entity-manager.ts` が `game-entity/*` を import しているため両者が同じファイルを触る | 競合して片方の変更が消える | 手順9・10。**手順9 を commit してから手順10 を出す。** 同時に配らない |
| 一時的な同値テストを消し忘れる | 正本がコード自身しかないテストが残り、次のリファクタで「壊れたテスト」として扱われる | 手順2・3。commit する前に `git status` で `tests/` に新規ファイルが無いことを見る |
| `memos/` の一括置換が、**既に死んでいる 22 種のパス**まで書き換える | `game/simulation/contact.ts` が `game/dynamic/contact.ts` になる。どちらも存在しないが、後者は**現役に見える**ぶん質が悪い。型検査もテストも memos を見ないので、**誰も気付かない** | 手順13。着手前に判定スクリプトで死んだパスの一覧(22 種)を控え、実施後に**同じ 22 種のまま**であることを当てる。サブエージェントへ配るときは、この一覧を指示に含める |
| `memos/` の置換が巻き添えで `src/` を触る(サブエージェントが「ついでに」直す) | コードの変更が memos の commit に紛れ、後から差分を追えなくなる | 手順13。commit 前に `git diff --stat -- src tests tools` が空であることを見る |
| 手順13 で `memos/mikanixonable/` を書き換える | このフォルダは通常「指示があったときだけ書き換える」領域。今回はユーザーが明示的に許可した範囲だが、次回以降の既定に戻す必要がある | 手順13。**この許可はこの計画1回限り。** 完了記録にその旨を1行残す |
| `main` へ送る前に全層テストを回し忘れる | CI が落ちて `release` の更新が止まり、公開版が古いまま取り残される | 全手順の後。`npm run typecheck` と `npm run test`(全層)を通してから PR を出す |

---

## 検査で見つけた、この計画の範囲外のもの

実施中に見つかったが、この再編では動かさないもの。**別の作業として切り出す判断はユーザーのもの。**

- **`render/` が `game/` を import している 9 箇所。** 内訳は `protein-*.ts` の 8 件
  (`game/protein/` の型を `import type` で引く。コンパイル後は消えるので実行時の依存は無い)と、
  `render/title-scene.ts` が `game/theme` の色定数を値として引く 1 件。
  CODING-RULE 1.3 の層の向き(`game/` が両方に依存し、`render/` は `game/` を知らない)に
  反するが、**どれもタンパク質表示とタイトル画面の話で、天体・積分側の再編とは交わらない。**
  値 import の `title-scene.ts` 1 件だけは、色の所有者を `render/` 側へ移せば消える。
- **`memos/` がこの計画と無関係に持つ、死んだパス 105 種**(`render/` `physics/` や、過去に
  消えた `game/` の他フォルダ)。手順13 では触らない。
- **`point-entity.ts` / `sphere-entity.ts` に残る `graphics.rings` 2 箇所。** 手順3 の
  達成条件は「`graphics.rings` が `game/celestial/` から 0 件」と書いていたが、**これは条件の
  書きすぎだった。** この 2 箇所は「環の影を落とす 1 体を選ぶ」判断ではなく、**個体が自分の
  環メッシュを描くかどうか**を設定から決めているだけで、`graphics.lodBias` を個体が読むのと
  同じ種類のもの。選定を render へ移す動機(スロット本数と密結合)が当たらないので、
  そのままにした。
- **`AMBIENT_STRONG` / `AMBIENT_WEAK` は export のまま残した。** 手順4 は「export しなくする」
  と書いていたが、`tools/render-lab/{lab,main}.ts` が環境光を手で設定するために直接引いており、
  非公開にすると描画実験環境が固まる。**達成目標8 は `src/game/` から消えることだけを求めて
  いるので、そちらは満たしている。**
- **手順6 の改名表に誤りがあった。** 計画は `bodyClassDisplayMode` / `nextBodyClassDisplayMode` /
  `applyBodyClassDisplayMode` / `applyBodyClassToggle` の `bodyClass` を `celestialClass` へ
  置換すると書いていたが、**これらは天体クラスと個体種別の両方を含む表(`keyof MapDisplayToggles`)
  を受ける**ので、`celestialClass` に改名すると嘘の名前になる。実際には
  `mapDisplayModeOf` / `nextMapDisplayMode` / `applyMapDisplayMode` へ改めた。天体クラスだけを
  受ける `bodyClassVisible` / `bodyNameVisible` は計画どおり `celestialClassVisible` /
  `celestialNameVisible`。
- **`applyBodyClassToggle` は呼び出し元が1つも無い死にコードだった**ので、手順6 で移す代わりに
  削除した(手順12 の「過剰 export」ではなく、関数ごと不要)。
- **`alwaysFullyVisibleIds` は `map/visibility-policy.ts` へ移した。** 計画では天体の木の問い合わせ
  (B)側に残す想定だったが、実装は表示トグルで絞り込む処理を含んでおり、残すと
  `celestial/` → `map/` の逆向き依存が生まれる。移した結果、**実行時の `celestial/` → `map/`
  依存は 0** になった(残るのは `sync` の引数型としての `import type` 1件のみ)。
