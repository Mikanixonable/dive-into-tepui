# モジュール構成の見直し — 着手可能な是正の実施リスト

## 何のための文書か

モジュール構成の全体調査(2026-08-28)のうち、**ユーザー判断が済んでいて個別に着手できる
是正だけ**を扱う。天体まわりの再編(見た目カタログ・レジストリ構造・solar-system.ts の分割・
参照線・FutureCelestialBodies)は判断待ちの大きな検討として
`refactor_celestial_structure.md` へ移した。ここには残さない。

**`33748733` 時点のコードから引いた事実を含む。正本ではない。** 食い違ったらコードを信じる。

## 決定事項(ユーザー判断、2026-08-28)

- **汎用データ構造は `src/math/` を新設して移す。** `util` / `lib` は意味が限定されず将来
  濫用されるため採らない。math は最も基本的なフォルダであり、
  **math が他フォルダ(physics / game / render)を import することは禁止。**
  vec3 も math へ移す(math 内モジュールが physics を import する事態を避けるため)。
- **定数は利用箇所と同居させる。** フォルダ集約ファイルではなく、使うモジュールの側へ。
- **テストは減らしてよい。** 今はとにかく多い。
- **見送り(今回はやらない)と決めたこと**:
  - nan-watchdog の責務を EntityManager へ回収する案(検査の価値はフレーム位相の記録に
    あり、呼び出しは orchestrator に残るため。将来のさらなる構造化の時に再考)
  - simulation facade の新設(simulator / predictor / entity-manager は既に
    `game/simulation/` に同居済み。facade はたらい回し層になる)
  - `export-models.mjs` の複製解消(three / three/webgpu 非互換という実制約。
    コメントに意図が明記されており、実害が出るまで触らない)

---

## 着手順

### 第1群 — 即着手(独立・機械的)

**1. `base-collision.ts` を physics から出す**
physics で唯一 `three/webgpu` と `render/base-station-model` を import している
(`base-collision.ts:2-5`)。ゲーム固有形状(基地ステーション)の多段 LOD 衝突なので
`game/simulation/` の接触系の隣が候補。これで physics の THREE 非依存が回復する。

**2. `src/math/` の新設と汎用データ構造の移住**
対象(指名済み): `vec3` / `projection` / `max-heap` / `spatial-grid`。
追随が自然なもの: `random`(vec3 が randVec で import している)、`deque`、`optimize`。
`state-queue` は KinematicState に型が固定されるため physics に残す。
移動時は tests/ の import と `tsconfig.test.json` を追随させる
(tests は src を直接コンパイルしている)。

**3. テスト登録の自動化 + 部分実行フィルタ**
現状: `tests/physics/index.ts` が import 74行 + `register()` 呼び出し73行を手で同期
(1ファイルだけ副作用 import 方式で作法が2通り。同期を忘れるとそのテストは黙って走らない)。
harness(34行)に名前フィルタを1つ足して部分実行を可能にする。
コンパイル前に outDir(`tests/dist/`)を掃除する(削除済みテストの残骸が積もっている)。

**4. 小物の掃除**
- 未参照 export の削除: `const.ts` の `GUIDE_GROUP_HUE` / `guideKindShade`(ファイル内でしか
  使われない)、`protein-render-bindings.test.ts:219` の `runRegisteredProteinRenderTests`
- `const.ts:5` の physics 再エクスポート解消(経由して使うのは `wave-attack.ts` 1箇所だけ。
  他8ファイルは physics から直接 import しており、同じ値に入口が2系統ある)
- 元期の3分散の統合: `SIM_EPOCH_TDB`(const.ts)→ `SIM_EPOCH_SEC`(hud/utils.ts)→
  `SIM_EPOCH_JD_TDB`(sim-epoch.ts)と1概念が3ファイルに割れている
- `tools/fetch-pdb-5i4r-atoms.mjs` の削除(protein-builder に置換済みの旧経路。
  npm script から呼ばれていない)

**5. `nan-watchdog.ts` → `game/simulation/` へ移動**
ファイル移動のみ。所有(Game)と呼び出し箇所(game.ts の位相境界4箇所 +
simulator.ts のサブステップ境界4箇所)は変えない。

**6. FloatingOrigin の生成を CameraSystem へ**
現状: `game.sync():531` が毎フレーム `cameraSystem.activeCameraPos` から作って
`cameraSystem.sync(fo)` へ渡し返している(生成材料の持ち主に渡し返す逆転)。
camera が組み立てて公開し、game.sync は受け取って配るだけにする。
速度基準 v(自機由来の別 concern)は引数で camera へ渡す形を保つ。
ファイルも `game/camera/` へ。値オブジェクトを引数で配る規律は変えない。

**7. `celestial-registry.ts` の改名**
physics の `CelestialRegistry`(静的事実の表)との語の混雑解消。
`celestial-appearance` 系の名前へ。天体再編(refactor_celestial_structure.md)とは
独立の低リスク変更として先行してよい — 天体まわりで先に動かすのはこれだけ。

**8. 生成物の目印の統一**
src 配下の生成 TS 2つ(`render/pipeline/lighting/ltc-table.ts`、
`game/protein/protein-asset-catalog.generated.ts`)の命名を `.generated.ts` へ寄せる。
`src/assets/luts/` の URL エンコードされたファイル名もこのとき直す。

### 第2群 — 規模が大きい(基準は決定済み、他作業にはブロックされない)

**9. protein JSON を tsc の型付けから外す**
現状: `resolveJsonModule` 経由で約72MB のアセット JSON
(`atpSynthase6n2yStructure.json` 39MB ほか)を test:physics のたびに tsc が型付けする。
`--max-old-space-size=8192` の原因。実行時 fs 読み込みか薄い d.ts へ切り替える。

**10. テストコマンドの層分割**
`test:physics` を physics だけに絞り、game / render / math 系は別コマンドへ。
9 と同時にやると tsconfig を二度触らずに済む。CI では全部回す。
CLAUDE.md の「physics/ を触ったときだけ test:physics」の運用が名実ともに正しくなる。

**11. game/ 直下平置き(28ファイル・7,174行)の群化**
フォルダ移動のみ。名前は任されたので次の案で進める:
- `map-pickable` / `map-pickables` / `map-context-actions` / `orbit-pickable` /
  `orbit-pickables` → `game/map/`
- `orbit-line` / `trajectory-line` / `entity-line-manager` → `game/lines/`
- `docking` / `docking-guide` → `game/docking/`
- `sim-epoch` / `sim-speed-manager` → `game/simulation/`
- `save-data.ts` → `game/save/` と統合(中身を見て向きを決める)

**12. const.ts の解体(利用箇所との同居)**
現状: 342 export のうち 83%(283個)は単一フォルダからしか参照されない。
参照元は 100% game 層(89ファイル)。physics / render は既に「概念の所有者が持つ」方式で
一貫しており、これに合わせる。単一参照の定数は使うモジュールの側へ移す。
複数フォルダ参照(57個)の置き場はその後に決める。
11 のフォルダ移動を先に済ませると移動先が安定する。
決めた置き場規則は `DEVELOP/CODING-RULE.md` へ1行足す(現状、色以外の置き場規則は
どこにも書かれていない)。

**13. 無駄なテストの削減**
根拠のない「実装出力の丸ごと固定」を削除、または根拠付きへ書き換える。候補:
- `hud-layout.test.ts:11,27,34` — ピクセル座標の裸の deepEqual(導出の記述なし)
- `map-scale.test.ts:8` — 同上
- `protein-ribbon-collision.test.ts:21-38` — 三角形数 + SHA-256 の characterization、
  `:159` の二分探索打ち切り桁の直書き
- `protein-combat-state.test.ts:399` — `rotation.z === 0.47` の裸のマジックナンバー
- `protein-motion-controller.test.ts:176-177` — 定数の写し(トートロジー)
対照として根拠明記の良例(blackbody / halo / thermal / satellite-orbit / shape)は残す。

**14. CODING-RULE の更新**
`const.ts` の解体に伴う定数の置き場規則、新設する `math/` のインポート規則、生成物の目印の統一、を、同種の問題が再発しないように `DEVELOP/CODING-RULE.md` へ追記。

---

## 移した論点への参照

天体まわり(見た目データの分散・レジストリ構造の再設計・solar-system.ts の分割・
参照線の持ち主・FutureCelestialBodies・src/celestial/ 新設の検討)は
`refactor_celestial_structure.md` を正本として再検討する。
