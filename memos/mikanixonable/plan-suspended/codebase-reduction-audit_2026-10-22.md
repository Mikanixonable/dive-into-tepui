# コードベース削減監査 — 死骸・重複・非効率の棚卸し

2026-10-22。前回の「ゲームサイクル適合監査」(game-cycle-implementation-audit) が**機能の過剰**を
扱ったのに対し、こちらは**コード衛生**の監査。死んだコード・重複実装・配線されているが実質
機能していない残骸・顕著な非効率を対象とする。

## 方法

- 7つの並列調査(サブエージェント)で src/ 全層・tools/ ・tests/ を export 逆引きで総走査
- 本体側で機械的スキャン: 孤立ファイル検出、重複 basename、TODO/console 残骸、未使用 npm
  依存、未参照アセット
- 報告された大きな候補は本体側で再検証済み(import 参照の完全一致 grep)

## 総量

| 領域 | 削減見込み |
| --- | --- |
| 即座に消せる死骸(src/tools) | ~1,500行 |
| テスト側連動削除 | ~290行 |
| src→tools 移設候補 | ~200行 |
| 条件付き(計画部品) | ~220行 |
| **合計** | **~2,200行** |

src+tools+tests 約13万行に対し約1.7%。複数回の監査・整理を経た結果として、大きな残骸塊は
ほぼ残っていない。以下は削減見込み行数順。

## 1. 即座に消せる死骸(確実)

### 1-1. `tools/cloud-lab/cloud-rendering-explainer.html` — 534行

旧雲経路の行番号つきソース解説 HTML。webpack.cloud-lab.config.js の HtmlWebpackPlugin は
index.html / separate.html のみで、本ファイルはバンドルにもリンクにも載らない。参照は
meteorological-cloud-model-plan-v2 メモのみ。行番号リンクは対象コードの変遷で陳腐化済み。

### 1-2. `src/physics/cylinder-contact.ts` + 対応テスト — 298行+57行

素の円柱(キャップ無し)の接触判定一式。import する本番コードはゼロで
`tests/physics/cylinder-contact.test.ts` のみが参照。実運用は `capsule-contact.ts` と
`capped-cylinder-contact.ts`+`compound-cylinder-contact.ts` へ移行済みで、素の Cylinder を
使う shape が存在しない。

### 1-3. `tests/perf/` の死骸 — 約190行

消えた性能実験(exp1-9, exp11)の孤立ヘルパ。
- `sphere-contact-reference.ts` 全体(80行): 唯一の呼び手 exp11 は削除済み
- `sphere-contact-sweeps.ts` の未使用 export 群(~45行): `G`/`SMALL_RADIUS`/`EARTH_AIR`/
  `MOON`/`SMALL`/`withDrag`/`withThrust`/`circularPeriod`/`beforePerigee`
- `common.ts` の未使用関数群(~65行): `initialLeoState`〜`fmtUs` 等、残る消費者 exp4 は
  定数再 export のみ使用

### 1-4. `src/render/gpu-timings.ts` の `CLOUD_GPU_MEASUREMENTS` — 69行

雲GPU計測の人間向けテーブル。src 内では定義のみで、利用は自分自身の存在を検査する
テストだけ。tools/render-lab は `GPU_PASS_LABELS` を直接使う。

### 1-5. `src/game/dynamic/entity-lifecycle.ts` の port 群と deferred-spawn — 約60行

`EntitySpawnGate`/`PendingEntitySpawn`/5つの port interface/`queuePendingSpawn`/
`markDead`/`deferredSpawns` — 全て外部参照ゼロ(`DynamicSystem` が直接委譲するため口は
素通り)。memos のリファクタリング検討で「Registry と重複、R6 には不要」と採否判断済みの
足場の残骸。`entity-registry.ts` の `SpawnGate` と型まで重複。

### 1-6. `src/game/pickable/entity-inspection.ts` — 59行(全ファイル)

interface 群のみの孤立ファイル。`reduce_implement.md` で「InspectedObject と MenuAction が
同じ役目」として不採用になった port 契約の残骸。import 元ゼロ。

### 1-7. `src/physics/time/index.ts` の TDB⇄UTC 変換一式 — 約110行

`UtcOffsetProvider`/`TdbOffsetProvider`/`AstronomicalTimeOffsetProvider`/`utcToTt` 等。
本番側の消費者は `createJulianDate`/`parseCalendarDate` 等の基礎だけで、TDB 変換を要求する
呼び出しが存在しない。`tests/physics/astronomical-time.test.ts` のみが生かしている。
memos/hedalu244/refactor_modules.md でも削除対象として指摘済み。

### 1-8. `src/game/dynamic/dynamic-presenter.ts` — 19行(全ファイル)

`EntityPresentationState`/`DynamicPresenter` interface のみの孤立ファイル。2026-09 の
リファクタリング計画で追加された未配線の足場。

### 1-9. `tools/protein-builder/annotate-protein-hashes.mjs` — 50行

contentHash 後付けの一括補修スクリプト。生成側が自前で付けるようになったため npm scripts・
CI・他ツールのどこからも呼ばれない(protein-pymol-migration メモにも「npm script からは
参照されない補修用」と明記)。

### 1-10. `src/game/navigation/orbit-slot-source.ts` の2関数 — 約50行+テスト35行

`orbitSlotFromContactElements`/`orbitSlotFromCatalogMember` — 「接触軌道要素/ガイド線から
標識を作る」経路。実際の生成は creative 配置フォーム経由のみで、本番呼び出しゼロ。
`duplicate-form.ts` との raan/argp 逆変換の重複も一緒に消える。

### 1-11. src/render の小物群 — 計約95行

- `field-projection.ts` の `EquirectProjection`(50行): src 内では一度も `new` されず
  tools/cloud-lab 専用。tools 側へ移す候補(移設なら src から -50行)
- `blackbody.ts` の `blackbodyEmissive` CPU版(12行): TSL版が本番、テストのみが参照
- `celestial-surface.ts` の `celestialSurfaceViewport` getter(5行): 呼び出しゼロ、
  reduce_implement.md でも削除対象として既出
- `ship-module-models.ts` の `getShipModuleTemplates`(17行): テスト専用API
- `casing-style.ts` の `CASING_DISPLAY_COLOR`(1行): tools 専用
- export 除去のみの小物(LayerContribution/climateSlope 等): 数行

### 1-12. src/game/ship の小物群 — 計約65行

- `ShipAssembly` 未使用 public API(21行): `constructionConnections`/`removeTail`/
  getter8本/`localTransformOfWorld`
- `restoreCollisionGrace`+公開口(13行): `restore()` が map を直接書き戻すための残り口
- `ShipCapabilities` の `has`/`propellantKg`/`toggleDeployable`(19行、内7行はテストのみ)
- `ShipAutopilot` の `burnCompleted` 機構(6行): 未接続の拡張口
- HUD 側 `CATEGORY_BY_KIND` 複写+不要フォールバック(7行)
- `isModularShipMotion`/`toggleSolarPanel`/`toggleRadiator`/死んだ再 export(6行)

### 1-13. src/game/hud + src/hud の小物群 — 計約35行

- `ValueInput.escapeBehavior` 機構(12行): 全15箇所が option 未指定で分岐到達不能
- `layout-tokens.ts` の死んだ CSS 変数 `--combat-panel-max-h`/`--rail-panel-max-h`(8行):
  読む側ルールが存在しない
- `widgets/index.ts` の未使用 re-export 群(5行): バレル自体は44ファイルが使い生存
- 空 `dispose()`(6行): インターフェース儀礼
- `hud-els.ts` の `chase-reset` 登録(1行): querySelector で直接引かれ登録は形だけ

### 1-14. src/game 小物群 — 計約45行

- `entity-id.ts` の `base`/`booster` アロケータ(12行): 呼び出しゼロ、ブースター分離後の
  個体は `entity` アロケータで採番
- `enemy-inspection.ts` の `proteinInspectionOf`(15行): `hud-panel-presenter` が
  combatReadout を直接取るため未使用
- `engagement-zone.ts` の `engagementZones` 互換入口(7行): 本番は Builder 経路のみ
- `assembly-enemy.ts` の `isAssemblyEnemy`(3行): 他の敵型ガードは使われるのにこれだけ未使用
- `damage-outcome.ts`(5行): DamageOutcomeSink interface のみの孤立
- stage0/stage00 の共通定型文の重複(基底部品化で ~10行)

### 1-15. package.json の死に script — 3行

`test:build`(test:compile のエイリアス)、`test:clean`、`smoke:layout`(suite 無しだと
smoke:browser と同義)。参照ゼロ。

### 1-16. `src/types/` の未使用 module 宣言 — 約10行

`*.cube`/`*.gltf`/`*.jpeg` の import 宣言。実際の import は `*.glb`/`*.png`/`*.jpg` のみ
(cube は require.context 経由で別宣言が担う)。

## 2. 条件付き — 計画済み部品なので仕様判断が要る

| 対象 | 行数 | 条件 |
| --- | --- | --- |
| `physics/impulsive-transfer.ts` | 109 | orbit-navigation-autopilot 提案書が遷移方式部品として計画済み。`biElliptic` は transfer-planner 内の別実装と重複する片割れ |
| `physics/trajectory-correction.ts` | 92 | 同上。射撃法補正は「求解本体は別フェーズ」の先回り実装 |
| `ShipModuleInstance.temperature` フィールド | 15-20 | 書き込み経路が死んでおり常に初期値表示。撤去なら save 形式・検査・表示の連鎖削除 |

この3件は「計画が先行して配線だけが無い」形。オートパイロット計画を進めるなら残り、
棚上げ確定なら消える。

## 3. src→tools 移設候補(削除ではなく置き場修正)

- `physics/cr3bp.ts`(149行): 本番は型 import のみで、実体を呼ぶのは
  tools/export-lagrange-orbits.mjs だけ。tools 側へ移せば src から -140行
- `render/field-projection.ts` の `EquirectProjection`(50行): cloud-lab 専用
- `render/dynamic/metal-f0.ts`(12行): model-builder 専用

## 4. 非効率(削除ではなく改善候補)

- `rcs-effects.ts`/`thrust-effects.ts`: ノズル毎フレームの `new Quaternion`/`new Vector3`
  乱発(ノズル数×60fps)。スクラッチ変数再利用で allocation 削減可能
- `mulberry32(plumeNoiseSeed(...))` を毎フレーム生成: シードから直接値を出す軽量 hash で
  RNG オブジェクト分減らせる
- `SunGlareSpreadScale` 等の per-frame 経路は健全だったとの報告

## 5. 確認したが健全だったもの

- **npm 依存**: 全依存・devDependencies 使用中(font-hackgen は CSS 経由、webpack loader 群は
  4設定ファイルで使用)
- **アセット孤立なし**: `src/assets` 全66ファイルに参照経路あり。LUT 3件は `require.context`
  の動的列挙で生存(ファイル名 grep では出ない)
- **console.log/debugger**: src 内 0件
- **TODO**: 9件とも設計意図の正当なメモ(明るさスケール見直し等)、放置デバッグではない
- **`src/hud/` vs `src/game/hud/` 二層**: 汎用 UI 道具箱とゲーム専用パネルで棲み分け、逆流なし
- **同名ペア**(layout-tokens/alarm-level/viewport): いずれも内容が別物で重複ではない
- **package.json scripts ↔ 実ファイル**: 全件対応、CI 参照経路も健全
- **tests/dist・docs**: gitignore 済みで混入なし
- **stages/**: 全ステージが STAGE_CLASSES 登録済みで選択・復元経路あり
- **physics/math の大物**(sphere-contact の区間ごと解法・relative-motion の CW 行列など):
  意図的保持のコメント付きか内部使用あり

## 注意

- **TEMP-DEBUG の console.debug** が `src/audio/sfx/ui-sfx.ts:26`、`world-sfx.ts:57`、
  `run-events.ts:261` に残っているが、これら3ファイルは現在ワーキングツリーで変更中の
  ユーザー編集ファイル — デバッグ調査の途中と思われるため本監査の対象外とした
- 孤立ファイル検出で真の孤立は3件(entity-inspection/dynamic-presenter/damage-outcome)のみ。
  他の「import されない」ファイルは barrel 経由・テスト harness・Worker ロード等で生存
- `earth-surface-*` は前回コミット(4f2f15454)で削減済みのため対象外
