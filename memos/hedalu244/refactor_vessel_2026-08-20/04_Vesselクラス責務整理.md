# Vessel クラス責務整理計画

## 1. 現状の責務マッピング(実測)

`src/game/vessel/vessel.ts`(1260行)の内訳:

- **識別・設計解決**(100-276行、いずれも**モジュールレベルの自由関数**で `Vessel` クラスの外にある): `initialShipState`/`progradeAttitude`/`resolveDesign`/`VesselIdentity`/`resolveIdentity`/`serializeAssembly`。`this` に一切依存しない純粋関数で、`VesselInit`/`VesselDeps` 等の型定義もここに同居。コンストラクタ(421-508行)がこれらを呼ぶだけ。
- **セーブ/リストア**: `restoreShip`/`restoreHostile`/`restoreBase`/`restorePlan`(511-583行、private)、`serializeAsShip`/`serializeAsHostile`/`serializeAsBase`/`serializePlan`(1168-1245行)。いずれも `this.inventory`/`this.assembly`/`this.plan`/`this.ai`/`this.baseState` など多数の private フィールドを直接読み書きする。
- **ドッキングポート解決**(669-786行): `dockPorts` getter は `deriveBaseDockingPorts`(`base-geometry.ts` 経由で re-export)へ委譲、`getHatchWorldPos`/`getSlotWorldPos`/`canCapture` は `base-module.ts` の純粋関数 `portWorldPos`/`portWorldNormal` を呼ぶだけの薄い実装。**既に幾何計算そのものは `base-module.ts`/`base-geometry.ts` 側にあり、Vessel 側との重複は無い。** Vessel に残っているのは「どのポートを選ぶか」「捕獲距離・速度の閾値判定」という、`this.baseState`/`this.state` を要する個体固有の判断と、`placeAtDockSlot`/`attachDockedVesselMesh`(THREE.Object3D への書き込み)。
- **被弾・喪失判定とエフェクト**(913-1052行): `recordLoss`/`attackedByBullet`/`collideWith`/`collideAtRadiator`/`checkLoss`/`impactEffect`/`destroyEffect`/`radiatorBreakEffect`/`applyCollisionDamage`。
- **表示同期**(1054-1149行): `syncVessel`/`markerItem`、および `accentColor`/`markerKey`/`setStructureVisible`。

## 2. 分割方針

**切り出すのは「識別・設計解決」の自由関数群のみ。** 理由:

- これらは既にクラス外の自由関数であり、`this` を持たない。ファイルを移すだけで済み、インターフェース変更が一切不要(最も低リスク)。
- `resolveDesign`/`resolveIdentity` は「`VesselInit` → 設計/位置姿勢/名前」という1つの明確な変換であり、`vessel.ts` から独立した1つの関心事として十分成立する。

**それ以外(セーブ/リストア・ドッキング・被弾喪失・表示同期)は切り出さない。** 理由:

1. **ドッキング**: 実測の通り、純粋な座標変換(`portWorldPos`/`portWorldNormal`)は既に `base-module.ts` にあり重複が無い。Vessel 側に残る `canCapture` 等は `this.baseState`/`this.state` という個体状態そのものを読む判断で、切り出すと関数が `Vessel` 相当の構造的インターフェースを要求することになり、`ctx` 引数禁止(rule 6)・薄いラッパー化の名目で複雑さが増えるだけで実益が薄い。
2. **被弾・喪失判定**: `/refactor-fixed` rule「a と b の接触の帰結は a と b の責務」が明言する通り、`collideWith` 系は **その GameEntity サブクラス自身が持つべき正本の実装**であり、切り出すこと自体がこのルールに反する。
3. **表示同期**: rule 12「マーカーは対象の持ち主が自分の sync の中で出す」により `syncVessel`/`markerItem` は Vessel 自身が持つのが設計意図そのもの。
4. **セーブ/リストア**: 多数の private フィールドを読み書きするため、外へ出すには `private` を大きく `public` へ開放する必要があり、カプセル化が悪化する。CLAUDE.md の「二段初期化を作らない」節が示す通り、復元ロジックはコンストラクタと不可分な処理として当該クラスに留めるのが自然(`Stage` 系も同じ形)。

上記いずれも「クラスとしての Vessel 責務」というプロジェクトの意図的設計(艦艇/基地/敵艦を1クラスに統合)そのものであり、`vessel.ts` の行数だけを理由に分割しない。

## 3. 新規ファイル

`src/game/vessel/vessel-identity.ts` を新設し、以下を移す(いずれも `export`):
`CrewedShipInit`/`BlueprintShipInit`/`OrbitalBaseInit`/`HostileShipInit`/`VesselInit`/`VesselDeps`/`VesselIdentity`(型)、`initialShipState`/`progradeAttitude`/`resolveDesign`/`resolveIdentity`/`serializeAssembly`(関数)、`baseIdAllocator`。
`PLAN_EXECUTION_LABELS`/`planExecutionLabel` は表示ラベルの関心であり識別解決とは無関係なので `vessel.ts` に残す。

`vessel.ts` 側は `import { resolveDesign, resolveIdentity, type VesselInit, type VesselDeps, ... } from './vessel-identity';` として使う。`Vessel` クラス自体の公開 API・コンストラクタシグネチャは無変更。

## 4. 変更手順(段階分割)

1. **Step 1**: `vessel-identity.ts` を新設し、対象の型・関数をそのまま移動(ロジック変更なし)。`vessel.ts` から import に置き換え、不要になった import(`generateRandomName`/`createBlueprint`/`baseAssemblyFromSaveData` 等、識別解決だけが使うもの)も移す。`npm run typecheck` のみで検証。1コミット。
2. **Step 2**(任意・ドキュメントのみ): ドッキング部分について「重複していない」ことをコード上のコメントで一言明記する(例: `dockPorts` getter 付近に「幾何計算は base-module.ts 側」の既存説明が既にあるため、追記が不要なら省略可)。コード変更を伴わないため、Step 1 と同一コミットに含めてよい。

以上で完結。被弾・喪失・セーブ/リストア・表示同期には手を入れない。

## 5. 文書更新箇所

- **CLAUDE.md**: `vessel.ts` の説明段落(`vessel/` セクション冒頭の `vessel.ts` — の項)に、識別・設計解決が `vessel-identity.ts` に分離された旨を反映。新規ファイルとして `vessel-identity.ts` の1文(「`VesselInit` から設計・初期状態を解決する純粋関数群」)を追加。
- **DEVELOP/OWNERSHIP.md**: 状態の所有者は変わらない(`resolveDesign`/`resolveIdentity` は元々どの状態も保持しない純粋関数)ため、更新不要と判断。念のため `Vessel` の生成経路に触れた記述があれば参照ファイル名だけ確認する。
- **DEVELOP/CALLSTACK.md**: 呼び出し順・実行条件に変化はないため更新不要。

## 6. 検証方法

- `npm run typecheck`(必須、常時)。
- `src/physics/` は触らないため `npm run test:physics` は不要。
- ヘッドレス実行検証(`/verify`)はユーザーが明示的に求めない限り不要。

## 7. リスク・自己レビュー

- リスクはほぼゼロ: 移動対象はすべて `this` を持たない自由関数で、シグネチャ・挙動を一切変えない機械的なファイル移動のため、typecheck が通れば実質的に安全と言える。
- **過剰設計になっていないかの自己レビュー**: 当初想定していた「ドッキング座標計算を `docking-geometry.ts` に切り出す」という案は、実コードを読んだ結果**既に base-module.ts 側に存在し重複が無い**ことが判明したため採用しない。被弾・喪失・表示同期・セーブ/リストアも、CLAUDE.md と `/refactor-fixed` が明言する既存の設計意図(1エンティティ1クラス、collideWith は当事者の責務、sync は持ち主の責務)に反するため切り出さない。結果として本計画は「識別・設計解決という既に独立していた自由関数群をファイル分離するだけ」という最小の変更に留まり、`vessel.ts` の行数は大きくは減らない(1260→約1050行程度)が、これは実装の適切さを損なわずに安全に行える範囲を優先した判断である。より大きな分割(基地関連の分離、被弾処理の分離等)は、CLAUDE.md の設計方針そのものを変える提案であり、ユーザーの合意なしに進めるべきではない。
