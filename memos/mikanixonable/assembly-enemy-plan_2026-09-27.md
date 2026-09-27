# 組み立て型の敵(assembly-enemy) 実装計画

基準コミット: `d07b80647`(作成時点の HEAD)。

## 目的

新しい敵種別「組み立て型の敵」を追加する。外観はタイトル画面
(`src/launcher/title-scene.ts`)の図案と同系: プラスチック風の光沢を持ち、端が半球の
円柱(カプセル)が緩やかに折れ曲がったり枝分かれした構造。ものによっては結び目理論の
結び目(torus knot 等)を全体または局所的に持つ。個体は部品の組み合わせで成り、
**見た目の部品がそのまま破壊可能な部位**になる。

## 決定済み(ユーザー回答)

- **被弾モデル**: 見た目の部品 = 破壊可能な部品。各部品が個別 HP を持ち、壊れると
  その部品が失われる。
- **形状生成**: 手続き生成(seeded)。個体ごとに seed から形状を組み立てる。
- **出現場所**: CREATIVE の物体配置/敵生成パネルとデバッグステージのみ。
  波状攻撃・既存ステージには混ぜない(後述「未確定の案」)。
- **名称**: 「組み立て型の敵」。コード上の kind は `'assembly-enemy'`、具象クラスは
  `AssemblyEnemy`。

## 既存構造から分かっていること(調査結果)

- 敵は抽象基底 `Enemy`(`src/game/dynamic/dynamic-entity/enemy.ts`)を継ぐだけで、
  EnemyInspection・マーカー・ターゲッティング・敵一覧パネル・残存機カウントが自動で
  効く。具象は `MetalEnemy`(部品式被弾)と `ProteinEnemy`(integrity+機能部位)の2種。
- 種別追加で触る箇所: `SerializedEnemy.kind` union と `SERIALIZED_ENEMY_KINDS`
  (enemy.ts)、`SerializedDynamicEntityFields.kind` union(dynamic-entity.ts)、
  `entity-dictionary.ts`(union + `ENTITY_CLASSES`)。**どれか欠けると復元時に
  静かに敵が消える**(materialize は未知 kind をスキップ)。
- 判定形状は `EnemyCollisionShape`(`enemy-motion.ts`)に `testSphereCollision` /
  `testSweptSphereCollision` を差し込む形。`null` なら半径の球。
  `ProteinSphereCollisionGeometry`(`src/game/protein/protein-sphere-collision.ts`)は
  入力が球列+倍率だけの**完全に汎用な実装**で、回転補間つき掃引(すり抜けなし)まで
  完成済み。
- 弾を含む全接触は `entity-contact-physics.ts` が TOI 昇順で解く。広域判定は
  `entity.radius` を外接球として使うので、**radius には形状の外接半径を入れる**
  (ProteinEnemy と同じ)。
- 被弾部位の特定は `applyBulletDamage(damage, impactPoint, events)` の着弾点を
  ローカル座標へ戻して最近接部位を引く(protein-enemy.ts の `siteIdAt` と同じ手)。
  なお `Contact` には `selfModuleId` 欄があり compound 円柱経路では「どの部品に
  当たったか」が届くが、custom shape(球列)経路には乗らない。拡張は可能だが
  共有の接触解決コードを触ることになるので、第1弾は着弾点からの最近接探索で済ませる。
- 「被弾ごとに小さな欠片が3個飛散」(COMBAT.md)はコード上未実装らしい
  (`DebrisPiece.create` の呼び出しは薬莢・マガジン・切断面・撃破のみ)。
- 描画は完全な遅延シェーディング。G バッファは normal/roughness/baseColor+metalness/
  emissive のみで **clearcoat チャンネルは無い**。`MeshPhysicalMaterial` の clearcoat は
  `toStandardNodeMaterial` で静かに捨てられる(既に船モジュールでそうなっている)。
  プラスチック光沢は `MeshStandardNodeMaterial { metalness: 0, roughness: 0.1〜0.3 }` の
  誘電体鏡面(F0=0.04 の GGX/LTC)で出す — 太陽球光源・天体照・影・赤熱(thermal
  emissive)は全て既存経路に自動で乗る。
- 手続きジオメトリの先例: `belt-hardware-view.ts`(CatmullRomCurve3+TubeGeometry)、
  `protein-ribbon.ts`(BufferGeometry 組み立て)。`TubeGeometry`/`CapsuleGeometry`/
  `TorusKnotGeometry` は通常の BufferGeometry としてそのまま使える。
  個体所有メッシュは `userData.ownsGeometry/ownsMaterial = true` を印す作法。
- seeded RNG は `src/math/random.ts` の `mulberry32` がある。
- `EnemyFireController`/`EnemyReactions` は port 注入で具象非依存 — 偏差射撃・
  バースト・同時発砲上限・撃破演出(`shipExploded`+`enemyDestroyFragments`)は共通。
- render-lab(`tools/render-lab/`)にケースを足せば本番の照明経路そのままで撮影できる
  (`npm run render-lab:shot`)。
- `src/launcher/` は組み立て層で render/ から import 不可。title-scene.ts の形状生成は
  module-private かつ forward 前提の材質を持つので、**共有せず新規に書く**(形状モデルが
  部品単位を持つ必要があり、要件が違う)。

## 設計

### 形状モデル(定義層・THREE 非依存)

`src/game/assembly/assembly-shape.ts` に置く。生成・直列化・判定・描画の全員が読む
共通の語彙で、値は seed から決定論的に再生成できる。

```ts
// 部品1個。中心線はローカル座標の折れ線。closed なら両端が接続する閉ループ(結び目)。
interface AssemblyPartDef {
  readonly index: number;         // 部品番号(直列化・被弾・表示のキー)
  readonly role: 'core' | 'emitter' | 'structure';
  readonly kind: 'tube' | 'knot';
  readonly centerline: readonly Vec3[];  // 生成器が平滑化済みの折れ線
  readonly radius: number;               // 管半径 [m]
  readonly closed: boolean;
  readonly parent: number | null;        // 取り付く親部品の index(枝分かれ)
}
interface AssemblyShape {
  readonly seed: number;
  readonly archetype: 'branched' | 'wholeKnot';
  readonly parts: readonly AssemblyPartDef[];
  readonly outerRadius: number;   // 外接半径 [m]、contact radius に使う
}
```

生成器 `generateAssemblyShape(seed, rand=mulberry32(seed))`:
- archetype を乱数で決める(全体結び目の個体は一部だけ)。
- **branched**: 主鎖を緩やかなランダムウォーク(1ステップごとの方向転換に上限)で生成し、
  Catmull-Rom 相当の平滑化で折れ線へ。主鎖は節で2〜4部品に分割。0〜3本の枝を主鎖上の
  点から生やす(枝も緩やかに曲がる)。低確率で局所結び目部品(小型 torus knot の
  閉ループ)を主鎖へ付ける。
- **wholeKnot**: (p,q) torus knot のパラメトリック曲線
  `r(φ)=((R+r·cos qφ)cos pφ, (R+r·cos qφ)sin pφ, r·sin qφ)` を閉ループとしてサンプルし、
  弧で2〜3部品に分割(分割部の端面は隣の管が覆う)。付属の枝を0〜2本。
- 結び目の種類: (2,3) trefoil、(2,5)、(2,7)、(3,4) 等の torus knot 族。
  **figure-eight(4_1)は torus knot でない**ため別パラメータ式が要る — 第1弾では
  torus knot 族のみとし、figure-eight は未確定の案へ(後述)。
- role の割り当て: `emitter` を必ず1個(開放端を持つ部品を優先)、`core` を中央寄りの
  部品へ1個、残り `structure`。
- 寸法: 生成後に外接半径へ正規化して、目標外接半径 40〜70 m(金属敵の
  67〜94 m より一回り小さい)を乱数で決める。管半径は外接半径の 1/12〜1/8。

### 被弾モデル(`src/game/assembly/assembly-combat-state.ts`)

各部品に HP を持つ。ProteinCombatState 式の二層:

- **部品 HP**: 命中は着弾点(ローカル化)に最も近い中心線を持つ部品へ入る。
  部品 HP が尽きるとその部品は**失われる**(表示から消える・以後当たらない)。
- **integrity**: 全体 HP は別プールで、あらゆる命中・接触が削る。尽きれば撃破。
- **機能**: `emitter` 部品の喪失で射撃停止(`canFire` false)。`core` 部品の破壊は
  integrity へ大きなダメージ(あるいは即撃破 — 数値は仕様で決める)。
- 失った部品の判定形状への反映はしない — 判定形状は生成時の形で固定
  (PROTEIN.md「衝突形状は構造の隙間を埋めてよい」と同じ方針。見た目より広い判定は
  既存種も許容している)。
- 直列化は `{ seed, parts: [{ hp }] , integrity }` — seed から形状を再生成し、
  HP 列だけで状態を戻す。形状そのものは保存しない(seed が正本)。

### 接触形状(`src/game/assembly/assembly-collision.ts`)

**採用案: 球列の再利用。** 各部品の中心線折れ線を球の数珠つなぎで覆い、
`ProteinSphereCollisionGeometry` と同じアルゴリズムで判定する。
`ProteinSphereCollisionGeometry` は既に汎用なので、**中性の置き場
`src/game/dynamic/sphere-chain-collision.ts` へ `SphereChainCollisionGeometry` として
移設**し、protein 側は import を更新するだけの小さな移動にする(種別固有の名前を
別種別から引く歪みを避ける)。球列自体に部品番号は持たせない —
どの部品に当たったかは `applyBulletDamage` へ届く着弾点からの最近接部品探索で
決める(protein の `siteIdAt` と同じ手で、接触解決コードを触らずに済む)。

球列の作り方: 各折れ線を管半径以下のピッチで舗装し、球半径=管半径(曲がり目は
球の重なりで自然に埋まる)。閉ループは折れ線を閉じて舗装。

### 敵実体(`src/game/dynamic/dynamic-entity/assembly-enemy.ts`)

`Enemy` を継ぐ `AssemblyEnemy`:

- `create(placement + { seed }, idAllocators, scene)` — seed から形状を生成、
  球列と View を組んで `super(...)` へ。
- `spawnGate()` は `null`(外部アセットを待たない)。
- 抽象の実装: `canFire` = emitter 部品が生存、`muzzlePosition` = emitter 部品の
  先端(ローカル→ワールド)、`plasmaDamage` = `PLASMA_BULLET_DAMAGE`、
  `applyBulletDamage` = 着弾点→部品へ割り振り+integrity、
  `applyImpactDamage` = `collisionDamageFraction` で integrity へ。
- 慣性: 形状から計算する(各部品を点荷重として惯性テンソルの対角成分を積算)。
  個体ごとに非対称になり、漂う姿勢の個性になる(`driftingAttitude` と組む)。
- `serialize()` は `{...serializeEnemyFields(), kind:'assembly-enemy', seed, combat}`。

### 表示(`src/render/dynamic/dynamic-entity/assembly-enemy-view.ts`)

`DynamicView<AssemblyVisualSource>` を継ぐ。`AssemblyVisualSource` は
`DynamicRenderSource` に `{ destroyedParts: readonly number[] }` を足す
(部品の消え具合は毎フレームの宣言として受け、`syncModel` で mesh.visible を切る)。

- 部品ごとに `THREE.Mesh`: 開放管は `CatmullRomCurve3`+`TubeGeometry`+両端の半球
  (`SphereGeometry` 半球)、閉ループは `TubeGeometry(closed=true)` で端不要。
  ジオメトリ組み立ては `src/render/assembly-geometry.ts`(仮)へ分け、
  「折れ線+半径+閉フラグ → メッシュ」にして View を薄く保つ。
- 材質: `MeshStandardNodeMaterial`(metalness 0、roughness 0.15〜0.3)。部品の色は
  中性色(乳白・灰・煙色)を基調に、emitter・core は個体のアクセント色 — 
  title-scene の配色思想をゲームの材質で写す。`makeThermallyEmissive` +
  `markLitOpaque` + `markShadowCaster` を印す。個体は少数(手動スポーンのみ)なので
  個体所有ジオメトリでよく、InstancedPool は使わない。
- 部品喪失の瞬間: 新しい出来事 `assemblyPartBroken`(部位位置の state を持つ)を
  記録し、flash-presenter で閃光へ写す。**失われた部品を実デブリとして飛ばす案は
  不採用(第1弾)**: `applyBulletDamage` は registry を受け取らないため、
  updateBehavior 内での遅延スポーンが要り、欠片が「その部品の形」を持てない
  (DebrisPiece は共有の欠片形状)制約もある。SPEC の被弾欠片3個飛散は現在未実装
  らしく、この変更で新設しない(未確定の案へ)。

### 生成経路

- `enemy-generator.ts` に `generateAssemblyEnemy(name, state, seed, accent, orbitLineColor,
  scene, idAllocators)` を追加(漂う姿勢 = `driftingAttitude()`)。
- **CREATIVE**: `stage-controls-panel.ts` の `EnemyShapeDefinition` union に
  `{ family: 'assembly'; kind: 'assembly' }` を足し、`STAGE_CONTROL_ENEMY_SHAPES` に
  1項目追加(個体差は seed なので項目は1つでよい)。`manual-spawn.ts` の分岐に
  assembly 生成を足す。タブの family 区分に 'assembly' を追加。
- **デバッグステージ**: `stage-debug.ts` に「組み立て型の敵をスポーン」ボタンを足し、
  自機前方へ1体出す(manual-spawn と同じ要領で前方距離・同速度)。`spawnEnemyWave`
  (generateWave 経由・金属敵のみ)は変えない。

### 仕様

`/modify-feature` の手順どおり、実装に先立って SPEC を更新する(単独 commit `docs(spec):`):

- 新規 `DEVELOP/SPEC/ASSEMBLY.md`: 出現(手動配置のみ・実体化に待ちなし)、
  表示(プラスチック光沢・部品構成・結び目)、被弾モデル(部品 HP + integrity・
  部位喪失)、判定形状(球列で覆う・部品喪失で縮まない)、直列化(seed が正本)、
  未確定の案(figure-eight・波への投入・実デブリ分離・HUD 部品一覧)。
- `DEVELOP/SPEC/COMBAT.md`「敵機」節に1行: 「組み立て型の敵の構成・被弾・表示は
  ASSEMBLY.md に定める」。

## 採否した案

| 軸 | 採用 | 不採用(理由) |
| --- | --- | --- |
| 接触形状 | 球列(ProteinSphereCollisionGeometry を中性化して再利用) | カプセル集合(sweptSphereCapsuleContact を回転分割ループへ嵌める — 見た目忠実度は最高だが新規150〜250行+集合ラッパ。球列で曲がり目は埋まり精度は十分)/ 平端 compound cylinder(関節で隙間が出る)/ 単一球(結び目で外接球が巨大すぎ) |
| 被弾の帰結 | 部品 HP + integrity の二層 | 部品 HP 合計のみ(全部品を壊すまで死なず退屈)/ 中核部品のみ撃破(狙い所は面白いが integrity と矛盾して複雑) — core 高ダメージで「狙い所」の効果は残す |
| 部品喪失の見せ方 | mesh 消失 + 閃光出来事 + 既存の被弾欠片 | 実デブリとして分離(欠片が部品の形を持てない・registry 未到達のため遅延スポーンが要る。未確定の案へ) |
| 材質 | MeshStandardNodeMaterial(roughness 低め・metalness 0) | MeshPhysicalNodeMaterial+clearcoat(遅延パイプラインにチャンネルが無く静かに捨てられる。拡張は G バッファ+BRDF の大掛かりな変更) |
| 形状の共有 | title-scene と共有せず新規 | 移植・共有(launcher→render の向きが逆・部品単位/判定との整合が無い) |
| 結び目 | torus knot 族(2,3)(2,5)(2,7)(3,4)等 | figure-eight 等の非 torus knot(別パラメータ式が要る。未確定の案へ) |
| 出現 | CREATIVE パネル + debug ステージ | 波状攻撃・既存ステージ(ユーザー決定) |

## 実装ステップ

1. **SPEC**: `DEVELOP/SPEC/ASSEMBLY.md` を書き、COMBAT.md の「敵機」節へ1行足す。
   commit: `docs(spec):`。検証: なし(文書のみ)。
2. **形状モデル+生成器**: `src/game/assembly/assembly-shape.ts`。
   検証: `npm run typecheck` + テスト(seed 決定論・外接半径・role 割当)。
3. **球列ジオメトリの中性化**: `ProteinSphereCollisionGeometry` を
   `src/game/dynamic/sphere-chain-collision.ts` へ `SphereChainCollisionGeometry` として
   移し、protein 側の import とテストの import を更新する純粋な移動。
   検証: `npm run typecheck` + `npm run test:game`(既存 protein 衝突テストが通ること)。
4. **被弾モデル**: `assembly-combat-state.ts`。検証: typecheck + 単体テスト。
5. **接触形状**: `assembly-collision.ts`(折れ線→球列ビルダ + EnemyCollisionShape
   アダプタ)。検証: typecheck + 球・掃引・回転のケースを test:game に追加。
6. **実体+直列化**: `assembly-enemy.ts`、kind union 3箇所、entity-dictionary。
   検証: typecheck + serialize/deserialize の回りで test:game。
7. **View**: `assembly-geometry.ts` + `assembly-enemy-view.ts`(部品メッシュ・
   材質・消え反映・熱発光配線)。検証: typecheck + `npm run test:render`。
8. **render-lab ケース**: 組み立て型の敵を置くケースを `tools/render-lab/` の
   CASES へ追加し、`npm run render-lab:shot -- assembly-enemy` で撮影して目視。
9. **生成経路**: enemy-generator / CREATIVE パネル / debug ステージ。
   検証: typecheck + test:game。
10. **閃光出来事**: `assemblyPartBroken` を run-events + flash-presenter へ。
    検証: typecheck。

## 落とし穴

- kind の登録漏れ(3箇所)で復元時に敵が静かに消える → ステップ6の直列化
  往復テストで塞ぐ。
- `radius` は常に**生成時の外接半径**で固定する(部品喪失で縮めると広域判定と
  食い違う)。
- `applyBulletDamage` には registry が来ない — 実デブリ生成は出来事経路か
  updateBehavior 遅延が必要(第1弾は行わない)。
- `dispose` 時に個体所有 geometry/material へ `ownsGeometry/ownsMaterial` の印が
  要る(漏れるとリーク)。
- コンストラクタが `Serialized*` を受けると lint 規則に抵触 → `deserialize` は
  static で placement へ展開してから private constructor を呼ぶ既存パターンに従う。
- `SerializedEnemy` に必須項目を足すと同版の旧記録で deserialize が壊れる →
  増やす項目は全て optional + 既定値で補う。
- 生成器は `mulberry32(seed)` 以外の乱数源を使わない(Math.random 禁止) —
  直列化の seed 再生成が破れるため。
- 遅延パイプラインで THREE の Light や MeshPhysicalMaterial の clearcoat に
  依存した見た目を書かない。

## 未確定の案(計画書内の記録・決定事項ではない)

- figure-eight knot 等非 torus knot の追加、結び目部品を「絡まった部位」として
  戦闘上の意味(狙いにくい高 HP 部位)へ結び付けること。
- 失われた部品を実デブリとして分離させること(部品形状を持つデブリ種別か、
  遅延スポーン経路が要る)。
- 波状攻撃・通常ステージへの投入(種別の混ぜ方は COMBAT.md の波仕様の拡張が要る)。
- 敵プロパティウィンドウ/ターゲットパネルへの部品一覧表示(protein の
  combatReadout 相当)。
- タイトル画面との形状モチーフ共有(launcher の図案を新形状モデルへ寄せる再設計)。
