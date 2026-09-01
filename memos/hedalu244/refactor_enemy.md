# enemy 周辺のリファクタリング — 細切れモジュールの回収と kind 分岐の多態化

## 目的

`src/game/dynamic/dynamic-entity/` の敵まわりが、2つの問題を同時に抱えている。

**1つめ — 責務を持たない細切れモジュールが 6 本ある。** `enemy-kind.ts` (43) /
`enemy-marker.ts` (35) / `enemy-save.ts` (29) / `enemy-render.ts` (27) / `enemy-formation.ts` (21) /
`enemy-sun-glare.ts` (17) は、いずれも `enemy.ts` からしか(型を除いて)呼ばれず、`Enemy` から
1回だけ委譲されるだけで独立した責務を果たしていない。`enemy.ts` を短くする意図で切り出されたと
見えるが、実際には減っていない — 委譲する側のメソッドと `import` 行が、切り出した行数とほぼ同じだけ
残る。結果として、`enemy.ts` は 528 行のまま、読むべきファイルが 7 本に増えた。

**2つめ — `EnemyKind` による分岐が `Enemy` 1クラスに同居している。** `enemy.ts` 内に
`proteinRuntime` が 30 箇所、`enemyKind` が 13 箇所現れ、コンストラクタ・衝突判定・被弾処理・
接触ダメージ・`sync`・射撃・`dispose`・シリアライズのほぼ全メソッドが「タンパク質型か否か」で
二又に割れている。**タンパク質型に固定すると通らない行が全メソッドに散らばっており、逆も同じ** —
これは長さの問題ではなく、本質的に違う2つのものが1つの型に同居しているという診断結果である。
細切れモジュールは、この分岐を外へ出そうとして失敗した副産物でもある(`enemy-render.ts` の中身は
種別の `switch` そのもので、分岐は `enemy.ts` に残ったままになっている)。

**一方で、`drifting` と `stage0` の違いは定数だけで、どちらかに固定したときに通らなくなる行は
1行も無い。** 同じ `EnemyKind` の値でも、こちらは分けるべきものではない。「kind があること」が
問題なのではなく、**kind で切り替わっているものが振る舞いなのかデータなのか**が問題である。

**修正後に期待される状態:**

- 敵は `Enemy`(抽象基底) / `MetalEnemy`(金属機体) / `ProteinEnemy`(タンパク質)の3クラスで
  表され、種別による実行時分岐はセーブからの復元(タグ → 具象クラス)1箇所だけになる。
- 復元は、既にステージが使っている「**静的側インターフェース + クラス辞書**」の形
  (`stage-dictionary.ts` / `StageClass`)へ揃える。読み込み機構はタグからクラスを引くまでを担い、
  そこから先の復元は各クラスのコンストラクタが持つ。
- `enemy-*.ts` は `enemy-dictionary.ts` の 1 本だけになり、各モジュールが 500 行以内かつ独立した
  責務を持つ。
- 同じ失敗を繰り返さないよう、`DEVELOP/CODING-RULE.md` に「長いモジュールはまず原因を診断する
  (多態にすべきかどうかもその診断の1項目)」「短すぎるモジュールの増殖は長すぎるモジュールと
  同格の違反」「多態の保存と復元の形」を明記する。

## 決めたこと

以下は自分で決めた。根拠と、覆したときに変わる手順を併記する。

**(1) 金属機体側のクラス名は `MetalEnemy` にする。**
`ShipEnemy` は使わない — `Ship` は `Enemy` の基底クラス名なので、`ShipEnemy extends Enemy extends Ship`
という並びが読めない。モデルの設計記録から採る:

- `tools/export-models.mjs` 547〜576 行(`buildEnemyShip`)は、ガンメタルのコアに `F0_STEEL` の
  `metalness: 1` リングとフィン 4 枚・ランプを付けた機体。642〜733 行(stage0 敵 A/B/C)は
  `core` / `ligand` / `bond` / ring で組んだ配位錯体だが、bond と ring はやはり `F0_STEEL` の金属。
- `DEVELOP/SPEC/PROTEIN.md` 26 行 —「リボンの表面は滑らかな陰影の、**金属的でない**マットな材質と
  する」。**仕様書自身が、タンパク質を金属との対比で定義している。**
- `MetalEnemy` / `ProteinEnemy` は「機体が何でできているか」で対になり、コードの差
  (固定メッシュ + パーツ式被弾 / 揺らぐ構造 + 部位式被弾)とも一致する。

`RigidEnemy` は退けた — `SPEC/PROTEIN.md`「表示形態を変えても、衝突形状は静止したリボン形状を
使い続ける」の通り、タンパク質側の衝突形状も剛体なので区別にならない。`HardEnemy` は難易度に読める。
→ 覆すなら手順 4 のクラス名とファイル名だけが変わる(構造は変わらない)。

**(2) 具象クラスは 2 つにする。3 つにはしない。**
現行の `EnemyKind` は `drifting` / `stage0` / `protein` の3値だが、`drifting` と `stage0` の違いは
メッシュ(`buildEnemyShip` / `buildStage0EnemyShip(typeIndex)`)と主慣性モーメント
(`v3(1,1.1,1.05)` / `v3(1,1,1)`)の2定数だけである。**どちらの値に固定しても、通らなくなる行が
1行も無い** — 切り替わっているのはデータであって振る舞いではない。ここを別クラスにすると、
**まさに今回潰そうとしている「責務の無い小さなモジュール」を新しく作ることになる。**
分岐の実体は「パーツ式の被弾モデルか、部位式(`ProteinCombatState`)の被弾モデルか」の1軸で、
`enemy.ts` の分岐 43 箇所はすべてこの軸に対応している。データの差は `MetalEnemy` のフィールド
(`typeIndex: number | null`)で持つ。
→ 覆すなら手順 4 が変わる(`MetalEnemy` を `DriftingEnemy` / `Stage0Enemy` に割る)。

**(3) 復元は `stage-dictionary.ts` と同じ形にする。`EnemyKind` union は消す。**
「多態で表したものを保存し、タグから復元する」口は、このリポジトリに既にある —
`StageClass`(`stage.ts` 72〜92 行)が静的側インターフェースとして `id` と構築シグネチャを宣言し、
`stage-dictionary.ts` が `STAGE_CLASSES` と `findStageClass(id)` を持ち、
`Stage.stageClass`(139〜143 行)が `this.constructor` から自分の静的側を引く。**技術的な障害は
無く、Enemy 側にこの形を実装するだけでよい。** 制約は2つだけで、どちらも Stage が既に解いている:

- **辞書は独立したモジュールでなければならない。** 基底のモジュールに置くと
  `enemy.ts → protein-enemy.ts → enemy.ts` の実行時循環になり、`class ProteinEnemy extends Enemy`
  の評価時に `Enemy` が TDZ で `ReferenceError` になる。呼び出し元(`dynamic-system.ts`)に
  `switch` を直書きすると、分岐が呼び出し元へ戻る。
- **復元のコンストラクタ・シグネチャは全具象で揃っていなければならない。** 具象ごとに異なるのは
  「新規生成」の引数だけなので、`init` を union にして、復元の腕
  (`{ saved, simTime }`)を全具象で共通にする。

セーブの互換は問わないので、`EnemyKind` は型ごと削除する。**種別タグは
`EntitySaveData.kind` を使う** — 現在 `'player' | 'enemy' | 'ammo' | 'rcs-fuel' | 'booster'` が
入っているが、**書かれるだけでどこからも読まれていない**(各実体は `save.enemies` のように配列で
分かれて復元されるため)。ここを具象クラス名のタグに使えば、新しいフィールドを足さずに済み、
将来 Player / Base などへ同じ機構を広げるときも `kind` がそのまま使える。
`'enemy'` を `'metal-enemy' | 'protein-enemy'` に置き換える。
→ 覆すなら手順 4 が変わる(`enemyKind: string` を別フィールドとして残す)。

**(4) 一般化した復元機構を他の実体へ広げるのは、このブランチのスコープ外。**
Player / Base / Bullet / AmmoPickup / RcsFuelPickup / DetachedBooster の復元経路には触らない。
`EntitySaveData.kind` の union に敵の2値を入れる以外、それらのセーブ形式も変えない。
Enemy 側を上記の形にしておけば、後から同じ形を横へ広げられる。
→ 覆すなら手順が 1 つ増える(全実体の `kind` を具象タグ化し、`dynamic-system.restoreFromSave` を
辞書引きへ統一する)。

**(5) CODING-RULE の改定は 1.2 と 1.6 への小節追加だけにする。新しい節は立てない。**
1.2 への追記は「関数を切り出すな」ではなく「**まず原因を診断しろ**」という形にする —
独立した意味を持つ手続きが直に書かれている場合は切り出すのが正解であり
(`player-throttle.ts` 267 行 / `player-fire.ts` 419 行がその例)、今回の enemy のように
「本質的に違うものが1つの型に同居している」のは診断結果の別の1種である。

**多態にすべきかどうかも、独立した規則ではなく診断の1項目として書く。** `kind` フィールドが
あること自体は違反ではない — 外部形式のタグとして必要だし、`drifting` / `stage0` のように
振る舞いを伴わない区別にも使う。判断は**その値を固定したときに通らなくなる行がどれだけあるか**で
下すものなので、診断の側にしか置き場所が無い。

復元機構の形(静的側インターフェース + クラス辞書)は診断ではなく手順なので、`1.6 データ構造`
の小節として置く。**新しい節を立てないので、1.7 以降の節番号の繰り下げと、その相互参照の
追随作業が丸ごと不要になる。**
→ 覆すなら手順 1 が変わる。

**(6) 旧セーブの `pdb-5i4r` 読み替えは削除する。**
互換は問わないという判断に従い、`LegacyPdb5i4rEnemyKind` / `normalizeEnemyKind` /
`proteinDisplayFromLegacyColorMode` と、後者を検査している
`tests/game/protein-combat-state.test.ts` の該当ケースを消す。
`proteinDisplayFromLegacyColorMode` の参照は `enemy-kind.ts` とそのテストだけなので、消せる。
→ 覆すなら手順 4 で読み替えを `enemy-dictionary.ts` の復元経路へ残す。

**(7) `isFormationEnergyAvailable` はモジュールレベルの関数として `protein-enemy.ts` に残し、
export する。** 陣形の供給条件は `DEVELOP/SPEC/COMBAT.md`「タンパク質陣形」に正本があるので、
`tests/game/protein-formation.test.ts` は残す価値がある(CODING-RULE 4.1「期待値の正本がコードの
外にあるもの」)。テストのために構造を歪めはしないが、この関数は素直な純関数なので、
`ProteinEnemy` の private メソッドにせず module scope の export で持つ。
→ 覆すならテストを削除し、`ProteinEnemy` の private メソッドにする。

## 達成目標

全手順の実施後に、次がすべて満たされていること。

1. `ls src/game/dynamic/dynamic-entity/enemy-*.ts` が `enemy-dictionary.ts` の 1 本だけを返す
   (現在 6 本)。
2. `grep -c 'proteinRuntime' src/game/dynamic/dynamic-entity/enemy.ts` が 0(現在 30)。
3. `grep -rn 'EnemyKind' src tests` が 0 件。種別で振る舞いを選ぶコードが
   `enemy-dictionary.ts` の外に存在しない。
4. `src/game/dynamic/dynamic-entity/` の敵関連モジュールが、いずれも 500 行以内。
5. `grep -rn 'setProteinDisplay\|proteinHudSnapshot\|proteinSiteMarkers\|proteinRuntime' src tests` が
   `protein-enemy.ts` 内と、`instanceof ProteinEnemy` で絞り込んだ呼び出し側だけになる。
   `Enemy`(基底)に `protein` を名前に含む public メンバーが 0 個。
6. `Enemy` の静的側が `EnemyClass` として宣言され、`enemy-dictionary.ts` が
   `ENEMY_CLASSES` と `findEnemyClass(kind)` を持つ。`dynamic-system.ts` の敵復元が、
   具象クラス名を1つも書かずに辞書引きだけで書けている。
7. `DEVELOP/CODING-RULE.md` に、(a) 長いモジュールの原因を診断する手順(多態にすべきかどうかの
   判断を含む)、(b) 短すぎるモジュールの増殖の禁止、(c) 多態の保存と復元の形の3つがある。
   `##` 見出しの並びは改定前と同じで、節番号を動かしていない。
8. `npm run typecheck` と `npm run test`(全層)が通る。
9. `npm run dev` でクリエイティブステージを開き、タンパク質敵の生成・表示形態の切り替え・
   陣形生成・撃破が変更前と同じに見える。セーブ → ロードで敵が同じ姿・同じ HP で戻る。

---

## 手順

### 手順 4. `Enemy` を抽象基底へ分け、`MetalEnemy` / `ProteinEnemy` と `enemy-dictionary.ts` を置く

**目的.** 本題。`enemy.ts` に 43 箇所ある種別の分岐をクラスの違いへ置き換え、復元を
`stage-dictionary.ts` と同じ「静的側インターフェース + クラス辞書」の形へ揃える。
分岐が消えるのと同時に、`enemyKind.display` を実行時に書き換えていた状態
(`setProteinDisplay` が `this.enemyKind.display` を破壊的に更新している)も消える —
表示設定の正本が `ProteinEnemy` のフィールドになる。**セーブ形式は変わる**(互換は問わない判断)。

**新しいモジュール構成と署名.**

```ts
// enemy.ts — 敵に共通する識別・色・陣形所属・バースト射撃 AI・マーカー・撃破演出

// 敵クラスの静的側。セーブからの復元はここから読む(stage.ts の StageClass と同じ形)。
export interface EnemyClass {
  // セーブへ書く具象タグ。EntitySaveData.kind の値。
  readonly kind: EnemySaveData['kind'];
  // 復元に fetch 済みアセットが要るなら、その id。要らなければ null。
  pendingAssetId(saved: EnemySaveData): ProteinAssetId | null;
  new (init: EnemyRestore, worldSfx: WorldSfx, fx: EffectsSystem, scene?: THREE.Scene): Enemy;
}

// 復元の腕。全具象で共通でなければならない(EnemyClass の構築シグネチャがこれを要求する)。
export type EnemyRestore = { readonly saved: EnemySaveData; readonly simTime: number };

// 新規配置の腕。具象ごとに固有の項目(typeIndex / assetId・display)を足して使う。
export type EnemyPlacement = {
  readonly name: string;
  readonly state: KinematicState;
  readonly q: Quat;
  readonly w: Vec3;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly waveId?: number;
  readonly id?: string;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
};

export abstract class Enemy extends Ship {
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly waveId?: number;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
  fireEnabled: boolean;

  protected constructor(
    init: EnemyPlacement | EnemyRestore,
    renderObject: THREE.Object3D,
    inertia: Vec3,
    radius: number,
    maxHp: number,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    scene?: THREE.Scene,
  );

  // 自身のクラス。復元タグはここから読む(Stage.stageClass と同じ形)。
  get enemyClass(): EnemyClass;
  get kind(): EnemySaveData['kind'];

  // 射撃が今できるか。金属機体は常に true、タンパク質は行動の有効判定を見る。
  protected abstract canFire(enemies: readonly Enemy[]): boolean;
  // プラズマ弾の発射位置とダメージ。タンパク質は攻撃部位から撃つ。
  protected abstract muzzlePosition(): Vec3;
  protected abstract plasmaDamage(): number;
  // 被弾ダメージの適用。金属機体はパーツへ、タンパク質は部位へ。
  protected abstract applyBulletDamage(damage: number, impactPoint: Vec3): void;
  // 接触ダメージ。ダメージが発生したら true。
  protected abstract applyContactDamage(damageSpeed: number): boolean;

  markerItem(role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem;
  behave(simTime: number, player: Player, entities: DynamicSystem, simSpeed: SimSpeedManager, celestialSystem: CelestialSystem): void;
  despawn(simTime: number, activeStage: Stage): void;
  collideWithEntity(other: DynamicEntity, contact: Contact, activeStage: Stage): void;
  collideWithCelestialBody(body: CelestialMotion, contact: Contact, activeStage: Stage): void;
  // 共通項目 + this.kind を返す。具象は super.serialize() へ自分の項目を足して override する。
  serialize(): EnemySaveData;
}
```

```ts
// metal-enemy.ts — 金属機体の敵。固定メッシュ + Ship のパーツ式被弾モデル
export type MetalEnemyPlacement = EnemyPlacement & {
  // null なら型番を持たない漂流機体。数値なら stage00 ウェーブ敵の機体テンプレート番号。
  readonly typeIndex: number | null;
};

export class MetalEnemy extends Enemy {
  static readonly kind = 'metal-enemy';
  static pendingAssetId(_saved: EnemySaveData): null;
  constructor(init: MetalEnemyPlacement | EnemyRestore, worldSfx: WorldSfx, fx: EffectsSystem, scene?: THREE.Scene);
  override serialize(): MetalEnemySaveData;
}
```

```ts
// protein-enemy.ts — タンパク質の敵。部位式の被弾モデル・リボン衝突形状・ゆらぎ描画
export type ProteinEnemyPlacement = EnemyPlacement & {
  readonly assetId: ProteinAssetId;
  readonly display: ProteinDisplaySettings;
};

export class ProteinEnemy extends Enemy {
  static readonly kind = 'protein-enemy';
  static pendingAssetId(saved: EnemySaveData): ProteinAssetId | null;  // (saved as ProteinEnemySaveData).assetId
  constructor(init: ProteinEnemyPlacement | EnemyRestore, worldSfx: WorldSfx, fx: EffectsSystem, scene?: THREE.Scene);

  get display(): ProteinDisplaySettings;
  setDisplay(display: ProteinDisplaySettings): void;              // 旧 setProteinDisplay
  get hudSnapshot(): ProteinHudSnapshot;                          // 旧 proteinHudSnapshot
  siteMarkers(displayPos: Vec3): readonly ProteinSiteMarker[];    // 旧 proteinSiteMarkers
  get motionMetrics(): { cpuMs: number; uploadBytes: number; lod: ProteinMotionLod };

  override sync(fo: FloatingOrigin, displayTime: number, viewer?: Viewpoint, proteinVibrationEnabled?: boolean): void;
  override testCustomSphereCollision(...): CustomCollision | null;
  override testCustomSweptSphereCollision(...): CustomCollision | null;
  override usesCustomSphereCollision(): boolean;
  override serialize(): ProteinEnemySaveData;
  override dispose(): void;
  // パーツを持たない。HP の正本は combat 側。
  protected override initDefaultParts(): void;
  override get hp(): number;
  override get maxHp(): number;
}

// 陣形の供給条件。SPEC/COMBAT.md「タンパク質陣形」が正本なのでテストを持つ。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly { readonly alive: boolean; readonly formationId?: string; readonly formationRole?: FormationRole }[],
): boolean;
```

```ts
// enemy-dictionary.ts — 敵クラスの一覧と、タグからの引き当て(stage-dictionary.ts と同じ形)
export const ENEMY_CLASSES: readonly EnemyClass[] = [MetalEnemy, ProteinEnemy];
export function findEnemyClass(kind: string): EnemyClass | null;
```

```ts
// save-data.ts — 種別タグは EntitySaveData.kind をそのまま使う。EnemyKind は消す。
export interface EntitySaveData {
  kind: 'player' | 'metal-enemy' | 'protein-enemy' | 'ammo' | 'rcs-fuel' | 'booster';
  // 以下は現状のまま
}
export interface EnemySaveData extends EntitySaveData {
  kind: 'metal-enemy' | 'protein-enemy';
  // 以下は現状から enemyKind と protein を除いたもの
}
export interface MetalEnemySaveData extends EnemySaveData {
  kind: 'metal-enemy';
  typeIndex: number | null;
}
export interface ProteinEnemySaveData extends EnemySaveData {
  kind: 'protein-enemy';
  assetId: ProteinAssetId;
  display: ProteinDisplaySettings;
  protein: ProteinSaveData;
}
```

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/enemy.ts` | `abstract class Enemy` へ。protein 関連(30 箇所)と種別分岐(13 箇所)を抜き、上記の抽象メンバー・`EnemyClass` / `EnemyPlacement` / `EnemyRestore` へ置き換える。`EnemyKind` / `normalizeEnemyKind` / `inertiaForEnemyKind` / `proteinAssetIdForEnemyKind` / `isFormationEnergyAvailable` / `buildEnemyRenderObject` をここから出す |
| `src/game/dynamic/dynamic-entity/metal-enemy.ts` | **(新規)** `buildEnemyShip` / `buildStage0EnemyShip(typeIndex)` の選択、慣性 `v3(1,1,1)`(型番あり) / `v3(1,1.1,1.05)`(漂流)、パーツ式の被弾(`applyDamageToParts` / `applyCollisionDamage`)、`static kind` / `static pendingAssetId` |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts` | **(新規)** `ProteinRuntime` / `ProteinRibbonCollisionGeometry` / `createProteinMotionBinding` の保持、部位式の被弾と致死判定、`sync` の LOD、攻撃部位からの発射、`display` の正本、`isFormationEnergyAvailable`、`static kind` / `static pendingAssetId` |
| `src/game/dynamic/dynamic-entity/enemy-dictionary.ts` | **(新規)** `ENEMY_CLASSES` と `findEnemyClass` |
| `src/game/save/save-data.ts` 22〜30・134〜152 行 | `EntitySaveData.kind` の union を差し替え、`EnemySaveData` から `enemyKind` / `protein` を外し、`MetalEnemySaveData` / `ProteinEnemySaveData` を足す。`EnemyKind` の `import type` を削除 |
| `src/game/dynamic/dynamic-system.ts` 13〜14 行 | `findEnemyClass` の import を足す |
| `src/game/dynamic/dynamic-system.ts` 102〜105 行 | `const cls = findEnemyClass(data.kind); if (!cls) continue; this.spawnEnemyWhenReady(cls.pendingAssetId(data), () => new cls({ saved: data, simTime }, worldSfx, this.effects, scene));` |
| `src/game/dynamic/dynamic-system.ts` 561〜568 行 | `enemy.proteinRuntime` の走査を `enemy instanceof ProteinEnemy` + `enemy.motionMetrics` へ |
| `src/game/stages/spawner/enemy-generator.ts` 34〜41・43〜68 行 | `generateFreeEnemy` を廃し、`generateDriftingEnemy` → `new MetalEnemy({ …, typeIndex: null }, …)`、`generateProteinEnemy` → `new ProteinEnemy({ …, assetId, display }, …)`。`att` の組み立てをやめ、`q` / `w` だけ渡す(慣性はクラスが持つ) |
| `src/game/stages/spawner/enemy-generator.ts` 75〜97 行 | `proteinFormationSpawns` の 3 つの `build` を `new ProteinEnemy(...)` へ |
| `src/game/stages/spawner/enemy-generator.ts` 150〜172 行 | `generateApproachingEnemy` → `new MetalEnemy({ …, typeIndex }, …)` |
| `src/game/stages/creative-stage.ts` 95〜97 行 | `enemy.enemyKind.kind === 'protein' && …` を `enemy instanceof ProteinEnemy` + `enemy.display` へ |
| `src/game/stages/creative-stage.ts` 130〜132 行 | `applyProteinDisplay` を `if (enemy instanceof ProteinEnemy) enemy.setDisplay(display)` へ |
| `src/game/hud/panels/target-panel.ts` 7・64 行 | `target instanceof Enemy ? target.proteinHudSnapshot : null` を `target instanceof ProteinEnemy ? target.hudSnapshot : null` へ。import 差し替え |
| `src/game/targeter.ts` 4・181〜185・228〜242 行 | `syncProteinSiteMarkers` の引数型を `ProteinEnemy` へ。ループの `if (!(tgt instanceof Enemy)) continue;` を `ProteinEnemy` へ。`enemy.proteinSiteMarkers` → `enemy.siteMarkers`。import 追加 |
| `src/game/protein/protein-display.ts` 55〜68 行 | `proteinDisplayFromLegacyColorMode` を削除(参照が消えるため) |
| `tests/game/protein-combat-state.test.ts` 28・420〜437 行 | `proteinDisplayFromLegacyColorMode` の import とテストケースを削除 |
| `tests/game/protein-formation.test.ts` 3 行 | import 元を `../../src/game/dynamic/dynamic-entity/protein-enemy` へ |

**達成条件と検証.**

- `npm run typecheck` が通る。
- `npm run test`(全層)が通る。
- `grep -c 'proteinRuntime' src/game/dynamic/dynamic-entity/enemy.ts` が 0。
- `grep -rn 'EnemyKind' src tests` が 0 件。
- `grep -rn 'setProteinDisplay\|proteinHudSnapshot\|proteinSiteMarkers' src tests` が 0 件。
- `grep -n 'MetalEnemy\|ProteinEnemy' src/game/dynamic/dynamic-system.ts` が
  `motionMetrics` の走査(561〜568 行)だけを返す — 復元経路に具象クラス名が出てこないこと。
- `wc -l src/game/dynamic/dynamic-entity/{enemy,metal-enemy,protein-enemy,enemy-dictionary}.ts` が
  すべて 500 以下。
- `npm run dev` でクリエイティブステージを開いて目視:
  1. 「敵を配置」で金属機体の敵が出る → 撃つと火花・ガスパフが出て、HP が減って撃破できる。
  2. 「陣形を生成」でタンパク質 3 体(5I4R / ルビスコ / ATP シンテターゼ)が出る。
     部位マーカー(3km 以内)に略号と HP が並ぶ。
  3. 表示形態のセレクタを切り替えると、既に出ている 3 体すべての見た目が変わる。
  4. ATP シンテターゼを先に破壊すると、5I4R がプラズマを撃たなくなる。
  5. セーブ → タイトルへ戻る → ロードで、3 体が同じ表示形態・同じ部位 HP で戻る。
- ステージ 00 のウェーブ敵が、機首をプログレードへ向けたまま回転せずに飛んでくること
  (慣性を `v3(1,1,1)` にしている効果)。

---

### 手順 5. コメントと規約の点検

**目的.** 手順 3〜4 でコメントが大量に移動する。移動先で意味が通らなくなったもの
(「Enemy の見た目を組み立てる」のようにファイル分割を前提にしていた説明、`this` の指す先が
変わった説明)と、分割によって不要になったもの(委譲を説明していたコメント)を落とす。
併せて手順 1 で書いた規約に、新しい 4 モジュールが従っているかを当てる。

**変更が必要な箇所.**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/enemy.ts` | 移入したコメントの主語を直す。`EnemyClass` の各メンバーに、なぜ静的側で宣言するのかを書く(`StageClass` と同じ意図) |
| `src/game/dynamic/dynamic-entity/metal-enemy.ts` | 慣性の非対称(ジャニベコフ効果)の説明はここへ残す。`typeIndex` が null のときの意味を書く |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts` | `initDefaultParts` の無効化と、HP の正本が `combat` である理由は**残す**(非自明) |
| `src/game/dynamic/dynamic-entity/enemy-dictionary.ts` | 辞書を独立モジュールに置く理由(基底 → 具象 → 基底の循環)をファイル先頭に書く |

**達成条件と検証.**

- `npm run typecheck` と `npm run test`(全層)が通る。
- `npm run smoke:browser` が通る(起動と基本操作で実行時例外が出ないこと)。
- 4 モジュールのそれぞれについて、ファイル先頭コメント 1 行で責務が言えること。
- 「達成目標」の 1〜9 を 1 つずつ当てて、すべて満たされていること。

**手順 3・4 の目視検証をここへまとめる。** 手順 3 は挙動不変で、手順 4 の目視項目に完全に
含まれるため、`npm run dev` は最後に 1 回だけ通す。クリエイティブステージを開いて:

1. 「敵を配置」で金属機体の敵が出る → 撃つと火花・ガスパフが出て、HP が減って撃破できる。
2. 「陣形を生成」でタンパク質 3 体(5I4R / ルビスコ / ATP シンテターゼ)が出る。
   部位マーカー(3km 以内)に略号と HP が並ぶ。
3. 表示形態のセレクタを切り替えると、既に出ている 3 体すべての見た目が変わる。
4. ATP シンテターゼを先に破壊すると、5I4R がプラズマを撃たなくなる。撃破直後に部位マーカーが
   残らない。
5. セーブ → タイトルへ戻る → ロードで、3 体が同じ表示形態・同じ部位 HP で戻る。
6. 敵マーカー(名前・距離・HP 三角形・画面外方位三角形)が変更前と同じに出る。
7. ステージ 00 のウェーブ敵が、機首をプログレードへ向けたまま回転せずに飛んでくる。

---

## 見積り

**行数(現状の `wc -l` と、移動する実体行から導く).**

| 時点 | 敵のモジュール数 | 行数 |
| --- | --- | --- |
| 現状 | 7 | 528 + 43 + 35 + 29 + 27 + 21 + 17 = **700** |
| 手順 2 後 | 5 | `enemy.ts` ≈ 528 + 32(`enemy-kind` の実体)+ 14(`enemy-formation` の実体)− 2(import 2 行)+ 3(新規 import)= **575** |
| 手順 3 後 | 1 | `enemy.ts` ≈ 575 + 77(4 本の実体 17+24+25+11)− 4(import)+ 6(移入に伴う import 追加)= **654** ← 基準超過。手順 4 とセットで解消する |
| 手順 4 後 | 4 | `enemy.ts` ≈ 300 / `protein-enemy.ts` ≈ 215 / `metal-enemy.ts` ≈ 90 / `enemy-dictionary.ts` ≈ 20 = **625**。`save-data.ts` +18 |

`enemy-dictionary.ts` の 20 行は `stage-dictionary.ts` の 18 行と同じ規模である。行数は小さいが、
「タグから具象を引く」という責務を持ち、かつ構造上ここにしか置けない(基底へ置くと循環)。
CODING-RULE 1.2「どんなに行数が少なくても、責務を持っているのであれば単独のモジュールとして
維持すべき」に当たる。

**総行数は 700 → 625 で、ほとんど減らない。これは想定どおりで、目的ではない。**
減るのは「読むべきファイル数」(7 → 4)と「種別分岐の箇所数」(43 → 1)であり、達成目標は
そちらで判定する。行数を減らすことを目的にすると、手順 3 で作った 654 行を「また切り出そう」と
する — それが今回直している失敗そのものである。

**分岐の箇所数.**

| 指標 | 現状 | 手順 4 後 |
| --- | --- | --- |
| `enemy.ts` 内の `proteinRuntime` 出現 | 30 | 0 |
| `enemy.ts` 内の `enemyKind` 出現 | 13 | 0 |
| `src/` 全体で種別を見て振る舞いを選ぶ箇所 | 4 ファイル | 1 ファイル(`enemy-dictionary.ts`) |

**触るファイル数.** 手順 1: 1(`CODING-RULE.md` のみ。節番号を動かさないので参照追随は無い)。
手順 2: 7(うち 2 は削除)。手順 3: 6(うち 4 は削除)。手順 4: 18(うち 3 は新規)。手順 5: 4。
**延べ 36 ファイル、実体は 22 ファイル。**

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `ProteinEnemy` の `hp` / `maxHp` getter が `super()` 実行中に読まれる。`Ship` のコンストラクタは `this.hp = hp; this.maxHp = hp; this.initDefaultParts();` を走らせ、その時点で `this.runtime` はまだ未代入 | 生成時に `Cannot read properties of undefined` で即例外。タンパク質敵が 1 体も出ない | 手順 4。`initDefaultParts()` を「パーツを持たない」override にし、setter を無視する形にすれば、super の中で getter を読む経路が無くなる。**この 2 つを同時に入れること。**片方だけだと落ちる。検証は手順 4 の目視 2 |
| `initDefaultParts()` を無効化すると `ProteinEnemy.parts` が空配列になる | `Ship.applyDamageToParts` / `updateOverallHp` / `refreshFromParts` は空配列で早期 return するので安全。`ship.parts` を触るのは `docking.ts`(260・297 行)と `base-view-parts-tab.ts` だが、いずれも `Player` のドッキング経路で、敵は到達しない | 手順 4。`grep -rn '\.parts\b' src/` で敵が到達しうる経路が無いことを再確認する |
| `EnemyClass` の構築シグネチャに具象のコンストラクタが代入できない。具象は `MetalEnemyPlacement \| EnemyRestore` を受けるが、インターフェースは `EnemyRestore` だけを渡す | `ENEMY_CLASSES` の型注釈で型エラー。`as` で潰すと辞書が型安全でなくなる | 手順 4。union を受ける側は狭い型を受け入れられるので通るはずだが、通らなければ**復元専用の static factory**(`static restore(saved, simTime, …): Enemy`)を `EnemyClass` に置く形へ切り替える。`new (...)` に固執しない |
| `static pendingAssetId` を `EnemyClass` に置くと、タンパク質固有の関心が全具象の契約に載る | `MetalEnemy` 側が意味の無い `null` を返すだけの宣言を持つ。`StageClass.picksStartEpoch` と同じ形(全ステージが自分について宣言する)なので許容するが、第3の具象が増えたときに再検討が要る | 手順 4。レビューで「基底から外そう」とするなら、`dynamic-system` が具象を知ることになる点とセットで判断する |
| `EntitySaveData.kind` の union を差し替えたとき、`kind: 'enemy'` を書いていた箇所が残る | 型エラーで止まるので無言では壊れない。ただし `save-transfer.ts` / `save-slots.ts` が `kind` を素通しでコピーしている場合、旧セーブが読み込み時に静かに落ちる可能性がある | 手順 4。`grep -rn "kind: 'enemy'" src` が 0 件、`grep -rn '\.kind' src/game/save/` で読み取りが無いことを確認する |
| `EnemyKind` を消したことで、`display` の正本が `ProteinEnemy` のフィールドへ移る。`serialize()` が生成時の値を返してしまう | セーブ → ロードで表示形態が生成時のものへ巻き戻る。クリエイティブステージで切り替えてから保存した設定が消える | 手順 4。検証: 手順 4 の目視 5(切り替え → セーブ → ロード) |
| `saved.display` / `saved.assetId` はセーブ由来の未検証値である。`isProteinDisplaySettings` の検査を落とす | 壊れたセーブで表示設定が不正なまま構築され、描画時に落ちる | 手順 4。`ProteinEnemy` の復元側で `isProteinDisplaySettings` を通し、外れたら `DEFAULT_PROTEIN_DISPLAY` へ倒す |
| `targeter.ts` 182 行の `if (!(tgt instanceof Enemy)) continue;` を `ProteinEnemy` へ狭め忘れる | 金属機体に `siteMarkers` が無く型エラー。`as` で潰すと実行時に落ちる | 手順 4。`npm run typecheck` |
| `targeter.ts` の部位マーカーは「生死にかかわらず全タンパク質敵を辿る」ループになっている。絞り込みを `alive` にすり替える | 撃破直後に部位マーカーが画面に残り続ける | 手順 4。検証: タンパク質敵を撃破し、部位マーカーが即座に消えること |
| `enemy-dictionary.ts` を `enemy.ts` に置く / `dynamic-system.ts` に `switch` を直書きするほうが速い、と手順 4 の途中で判断する | 前者は `enemy.ts → protein-enemy.ts → enemy.ts` の実行時循環で `class ProteinEnemy extends Enemy` が TDZ の `ReferenceError`。後者は分岐が呼び出し元へ戻る | 手順 4。「決めたこと (3)」で塞いである |
| 慣性 `v3(1,1.1,1.05)` が `MetalEnemy`(漂流)と `ProteinEnemy` の 2 箇所に書かれる | 重複実装に見えるが、別々の物体の物理量なので統一しない(CODING-RULE 1.5「個別に調整されうる要素」) | 手順 4。レビューで「まとめよう」としないこと |
| 手順 3 で `enemy.ts` が 654 行になった状態で止める | CODING-RULE 1.2 の 500 行基準を破ったまま残る。しかも「長いから切り出そう」という、今回直している動機を再生産する | 手順 3〜4。**手順 3 と手順 4 は続けて実施する** |
| 一般化した復元機構を、この場で Player / Base / Bullet などへ広げたくなる | 手順 4 が commit できない規模に膨らみ、挙動の変わる範囲が敵の外へ出る | 手順 4。「決めたこと (4)」で塞いである。広げるなら別ブランチ |
| `npm run typecheck` がヒープ不足で落ちる | 変更の是非と無関係に赤くなる | 全手順。既知の環境事情なので、ヒープを広げて再実行する |
| main へ送るとき、触った層だけのテストで済ませる | CI が全層を回すので、通らないものを送ると `release` の更新が止まる | 手順 5 の後。`npm run typecheck` と `npm run test`(全層)を必ず通す |
