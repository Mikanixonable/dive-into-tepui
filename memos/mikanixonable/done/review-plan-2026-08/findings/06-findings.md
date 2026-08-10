# 章06: 天体表示系のレビュー findings

対象: `src/game/celestial/`, `src/render/{ring,celestial-surface,celestial-grid,stars,earth,sampled-line,orbit-line,radiator-hinge}.ts`, `src/physics/ring-optics.ts`

修正方針: 規約違反・明白なバグのうち安全に直せるものは修正。ファイル移動を要する規約違反(CLAUDE.md/DEVELOP 同時更新が必要)は、他エージェントが両文書を編集中のため**報告のみ**とした。

## [bug] `render/celestial-grid.ts` が `game/` へ依存している(render→game import 禁止違反)

- `src/render/celestial-grid.ts:8-9` — `import { CameraSystem } from '../game/camera/camera-system';` / `import { CELESTIAL_SHELL_RADIUS } from '../game/const';`
- `CelestialGrid.sync(visibility, cameraSystem: CameraSystem)` が `cameraSystem.activeCamera`/`.overviewMode` を直接読んでいる。
- 根拠: CLAUDE.md の `game/celestial/environment-scene.ts` の項が「Moved here from render/ because it already depended on game/camera/, game/floating-origin and game/const — a render/規則違反 this move corrects」と明言しており、まさに同じ依存パターン(`game/camera/*` + `game/const`)が `celestial-grid.ts` に残っている。`grep -rn "from '\.\./game" src/render/` で検出。
- 修正は `game/celestial/` へ移すことで、環境-scene と同様の対応が筋だが、ファイル移動は CLAUDE.md/DEVELOP の同時更新を要し、他エージェントが編集中のため**修正せず報告のみ**とした。

## [bug]/[spec?] `render/orbit-line.ts` / `render/sampled-line.ts` も `game/floating-origin` に依存

- `src/render/orbit-line.ts:8`、`src/render/sampled-line.ts:23` — `import { FloatingOrigin } from '../game/floating-origin';`
- `FloatingOrigin` は `RtoThreeV3`/`VtoThreeV3` という「Vec3→THREE.Vector3 の唯一の橋渡し」を提供する型で、render 側が受け取って呼ぶだけの用途に留まっており、celestial-grid.ts のように `CameraSystem` クラス全体を触るケースとは重さが異なる。ただし CLAUDE.md の move 理由に "game/floating-origin" が名指しされている以上、同じ理屈なら違反として扱われる可能性がある。判断が割れる点なので **[spec?] として報告のみ**(修正しない)。

## [spec?] `src/physics/ring-optics.ts` と `src/render/radiator-hinge.ts` が CLAUDE.md 未記載

- 両ファイルとも実在し、`ring.ts`/`celestial-surface.ts`/`ring-lod.ts` から使われている(`ring-optics.ts` は `ringTransmission`/`henyeyGreenstein`/`ringPixelCoverage`/`ringArcOpticalDepth`/`ringSingleScattering`/`ringPlanetShadow` を提供、テストも `tests/physics/ring.test.ts` にあり)。CLAUDE.md の `src/physics/` 一覧・`src/render/ships.ts` 隣接エントリのいずれにも記載がなく、計画書が予告した「新設 — CLAUDE.md 未記載なら文書齟齬として報告」に該当する。
- CLAUDE.md 編集は他エージェントに委ねられているため報告のみ。
- **2026-08-10 追記(review/celestial-doc-drift ブランチ)**: `ring-optics.ts` は CLAUDE.md へ追記した(`src/physics/ring.ts`/`ring-view.ts`/`celestial-surface.ts` の項も併せて実装に合わせて書き直した)。`radiator-hinge.ts` は本ブランチのスコープ外(天体表示ではなくプレイヤー機体のラジエーター)のため未対応のまま。

## [spec?] `render/ring.ts` / `ring-view.ts` / `celestial-surface.ts` の実装が CLAUDE.md の記述から大きく乖離

- CLAUDE.md は `render/ring.ts` を「4つの純粋な mesh builder(createTexturedRing/createAnnulusRing/createRingLine/createTorusRing)」とだけ説明していたが、実装は物理ベースレンダリング(TSL シェーダによる Beer-Lambert 透過・単一散乱・惑星による太陽光遮蔽)を伴う `RingVisual { object, sync }` を返す設計に置き換わっている。
- さらに `celestial-surface.ts` に環が惑星本体へ落とす影(`setRingShadowSystem`、最大32帯)という新機能が入っているが、CLAUDE.md の `celestial-surface.ts` エントリにはこの言及が一切なかった。
- `ring-lod.ts` も CLAUDE.md は「annulus/line の二値切替」としていたが、実装は `ringLod` によるクロスフェード(annulusWeight/lineWeight、0.75〜1.25px で線形補間)に発展している。
- 挙動自体は `ring.test.ts`(ring-lod のクロスフェード込み)で緑になっており実装側にバグは見当たらないが、文書との乖離が大きかった。
- **2026-08-10 追記**: 上記3ファイルの CLAUDE.md 記述を実装に合わせて全面的に書き直した(`ring-optics.ts` の物理モデル、`setRingShadowSystem` の影、`ringLod` のクロスフェードを反映)。

## [spec?] `celestial-registry.ts` の登録天体数が CLAUDE.md の「27 body」から大幅に増加

- CLAUDE.md は `SOLAR_SYSTEM` を「27 bodies」と繰り返し明記していたが、`celestial-registry.ts`/`body-class.ts` には現在 101 体(恒星1・`kind:'planet'` 49・`kind:'satellite'` 51)の天体が登録されている。`Record<SolarSystemId, …>` の網羅性チェックにより型は整合しており(`npm run typecheck` green)、コード上のバグは無い。
- 追加調査: 49の`planet`種のうち41体(元の準惑星・大型小惑星・彗星核9体+後発の32体)が `solidPlanetEntry`(単色球・`PLANET_VIS_DIST`)で描画され、51の`satellite`種のうち6体(フォボス/イオ/エウロパ/ガニメデ/カリスト/タイタン)のみ実写テクスチャ、残り45体は単色。環を持つ天体も木星・土星・天王星・海王星に加えクワオアー(QUAOAR_RINGS)・カリクロー(CHARIKLO_RINGS)の計6体まで拡大している(`tests/physics/ring.test.ts` はこの2体をまだ検証対象に含めていない)。
- **2026-08-10 追記**: CLAUDE.md の `celestial-registry.ts`/`solar-system.ts` エントリを実際の構成(101体の内訳、環を持つ6天体)に合わせて書き直した。個々の天体名を全部列挙するのではなく、種別ごとの構成・出典・表示方式の説明にとどめた。`ring.test.ts` が quaoar/chariklo 未対応である点はテスト側の課題として残る(本ブランチはコード変更なしのため対応せず)。

## [spec?] `src/render/stars.ts` の実装が CLAUDE.md の記述と矛盾

- CLAUDE.md は「stars as tiny world-space triangles (WebGPU points are 1px; THREE.Points size doesn't work)」と説明していたが、実装 (`createStars`) は `8k_stars.jpg` を貼った `SphereGeometry` (BackSide) であり三角形の集合ではない。テクスチャ方式へ置き換わったことが文書に反映されていなかった。
- **2026-08-10 追記**: CLAUDE.md を実装(テクスチャ球殻)に合わせて書き直した。WebGPU の Points 制約自体は `render/ring.ts`/asteroid point-field などの点群描画では依然として有効な制約なので、その旨は残した。

## [bug→修正済み] `EarthBody.phase0` がセーブ/ロードで再現されなかった実装漏れ

`Ephemeris` の位相オフセット(`phaseOffsets`)は `GameSaveData.phaseOffsets` として明示的にセーブされ、
セッションをまたいでも公転位相を再現するのに対し、`EarthBody.phase0`(地球の自転初期位相)には
同等の永続化経路が存在せず、同じセーブを開き直すたびに自転角だけが違う値から始まっていた。
セーブ内で再現されるべき他の全ての位相と地球の自転位相だけが異なる扱いになっている点に、
意図した設計だと確認できる記述やコミットは見つからなかったため、実装漏れと判断して修正した。

修正内容:

- `EarthBody.phase0` を可変フィールドにし、`spinPhase0()`/`setSpinPhase0()` を追加。
- `Ephemeris.phaseOffsets` は各天体の**公転**位相専用のマップ(`'earth'` キーは地球自身の日心軌道位相に
  既に使われている)なので、地球の**自転**位相をそこへ相乗りさせず、`GameSaveData` に独立フィールド
  `earthSpinPhase0?: number` を追加した。`EnvironmentScene.earthSpinPhase0()`/`setEarthSpinPhase0()` が
  `EarthBody` を探して読み書きし、`SnapshotService.buildSaveData`/`Game.restore` が
  `Ephemeris.getPhaseOffsets()`/`setPhaseOffsets()` と同じ経路(`Game.environment` 経由)で
  読み書きする。
- 後方互換: `earthSpinPhase0` は optional。旧セーブ(このフィールドを持たない)を読んだ場合、
  `Game.restore` は値が存在するときだけ `setEarthSpinPhase0` を呼ぶため、そのゲームセッション開始時に
  `EarthBody` 自身がコンストラクタで既に割り当てた乱数値がそのまま使われる — 「欠落時は新規ランダム値」
  という扱いになる。`bases` フィールドが同様に optional で追加された前例(`data.bases ?? []`)に倣い、
  `SAVE_VERSION` は上げていない(`snapshot-service.ts` の `restore` は `data.version !== SAVE_VERSION` で
  厳密一致を要求するため、`SAVE_VERSION` 自体は「読み込み可否」の粗い互換境界であり、その内側でどの
  optional フィールドがいつ追加されたかは各フィールド自身の undefined チェックで吸収する、という
  既存の運用を踏襲した)。
- `test:physics` へのテスト追加は見送った: `EarthBody`/`EnvironmentScene` は `render/earth.ts`
  (`three/webgpu`)を経由して THREE 依存のため、DOM/THREE 非依存を要求する `tsconfig.test.json` の
  コンパイル対象にできない。`GameSaveData.earthSpinPhase0` 自体は純粋なデータ型なので型としては
  テスト可能だが、往復を検証する意味のあるテストは `EarthBody`/`Game` 側の挙動を要し、これは物理テスト
  の対象範囲外と判断した。

## [refactor] `render/orbit-line.ts` の `snap.hHat`/`snap.pHat` がスプレッド構文で Vec3 を作っている

- `src/render/orbit-line.ts:151-152` — `hHat: { ...el.hHat }, pHat: { ...el.pHat }`
- CLAUDE.md: 「Vec3 は build it with v3()/the helpers, never with a bare object literal」。型チェック上は intersection 型のスプレッドで通ってしまうが(`npm run typecheck` green)、規約の趣旨(`v3()`/既存ヘルパー経由の構築を徹底する)には反する。実害はない(不変値のシャローコピーであり、後続コードは読むだけ)ため、`v3(el.hHat.x, el.hHat.y, el.hHat.z)` へ置き換える程度の軽微な修正候補として報告のみに留めた(スコープ外の隣接コードを広く触るのを避けるため)。

## 確認したが問題なし(参考記録)

- **WebGPU 制約**: `render/ring.ts`(annulus/line/torus/textured の4ビルダー)、`render/celestial-grid.ts`(等緯度線・極マーカー)、`render/orbit-line.ts`、`render/sampled-line.ts` のいずれも `THREE.LineLoop`/`THREE.Points` を使わず、頂点は事前確保した `Float32Array`/`BufferAttribute` への in-place 書き込み + `needsUpdate`/`setDrawRange` で更新している。`celestial-grid.ts` の `setLinePoints` はジオメトリを丸ごと差し替えているが、呼び出しはすべてコンストラクタ内(初回 `scene.add` 前)に限られ、毎フレーム呼ばれないため WebGPU の「差し替え禁止」規約には抵触しない。
- **Additive 素材**: `render/earth.ts` のオーロラ2箇所とも `transparent: true` を伴って `AdditiveBlending` を設定している。
- **ring sibling-not-child / スピン位相非継承**: `sphere-body.ts`/`point-body.ts` はいずれも `scene.add(this.ring.group)` を本体メッシュとは別に呼んでおり、`RingView.sync` は `spinOrientation(axis, 0)`(角度0固定)で環の姿勢を組むため、Neptune の Adams ring arc は本体の自転位相を継承しない。
- **扁平天体でのリング非扁平スケール**: `sphere-body.ts`/`point-body.ts` は本体メッシュへ `axes.x/y/z × k`(3軸独立)を渡す一方、`RingView.sync` へは一様な `scaleFactor` のみを渡しており、環は扁平化を受けない。
- **`ringVisualForm` の真位置評価**: `sphere-body.ts`/`point-body.ts` はいずれも `ring.sync(..., pos, cameraSystem.activeCameraScale, ...)` の `pos` に(戦闘ビューの圧縮位置ではなく)`ephemeris.positionOf` で得た真の ECI 位置を渡しており、`RingView.sync` 内の `metersPerPixelAt(bodyPos)` は真位置で評価される。
- **point-field 決定論**: `point-field.ts` は `mulberry32` のみを使用し `Math.random` は無い(grep で確認)。`point-field.test.ts` の同一シード決定性テストも green。
- **1/8 round-robin と sync の全書き換えの分離**: `point-field-view.ts`(`UPDATE_FRACTION = 8`)の `update()` は一部インスタンスの位置だけ再計算し、`sync()` は毎フレーム全インスタンスの `instanceMatrix` を書き直す(浮動原点が動くため)、という分離が保たれている。
- **太陽中心キャッシュの毎フレーム鮮度**: `PointFieldView.update` は `overviewMode` の間、毎フレーム `ephemeris.positionOf(starId, t)` を呼び直しており、太陽位置のキャッシュが古いフレームにまたがって使い回されることはない。
- **body-visibility の一元性**: `visibleBodyIds`/`bodyIconLabel`/`alwaysFullyVisibleIds`/`isPositionInFocusedSystem`/`sameSystemIds`/`systemMembersAt` の消費者(`map-picker.ts`/`frame-controls.ts`/`focus-markers.ts`/`ship-placer-panel.ts`/`player-markers.ts`)は全て `body-visibility.ts` 経由で、独自に可視性を再判定している箇所は見つからなかった。
- **シーンライティング不参加**: `celestial-surface.ts` はどの天体も `MeshBasicNodeMaterial` + 自前の `sunDirNode` uniform で陰影を計算しており、`EnvironmentScene` の `DirectionalLight`/`AmbientLight` を受けない。天体ファイル群(`sphere-body.ts`/`point-body.ts`/`sun-body.ts`/`earth-body.ts`)もライトを追加していない。
- **update/sync 分離**: `EnvironmentScene.update(t, overviewMode)` は `PointFieldView.update` の呼び出しのみで THREE オブジェクトを直接書き換えず、`sync()`側でメッシュ/ライト/グリッド/参照線/点群 transform をまとめて反映している。

## 検証

- `npm run typecheck` — green
- `npm run test:physics` — **390/390 green**(計画書記載の「391/391」とは件数が異なるが、`ring.test.ts`/`point-field.test.ts`/`shape.test.ts` を含め全項目 `ok`。計画書作成時点との差分と思われ、本レビューで新たに壊したテストは無い)
