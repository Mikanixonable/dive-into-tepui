# リファクタリング計画

対象: `src/` 全体(合計 ~8,700 行)。最大の課題は `game.ts`(3,356 行)への責務集中と、
`const.ts` があるにもかかわらず `game.ts` 内に残る多数のマジックナンバー(~170 箇所)。

事前調査の結果:
- コメントアウトされた死にコード・TODO/FIXME・`as any` は **ほぼ存在しない**(良好)。
- `planner.ts` / `mapview.ts` は既に `game.ts` から分離済みで、Ctx スナップショット注入
  パターンが確立している。以降の分割はこのパターンを踏襲する。
- 自動テストは未整備。物理 (`src/physics/*.ts`) は純関数なので tsc → node で検証可能。

各ステップは独立して完結させ、ステップごとに `npm run typecheck` + 実プレイ確認
(`npm run dev`)を行ってからコミットする。**挙動変更は一切行わない。**

---

## ステップ 1. 死にコードの棚卸し(小・低リスク) — ✅ 完了 (2026-07-19)

コメントアウトされたコードは見つからなかったため、代わりに「使われていないコード」を整理する。

- `src/physics/{bodies,integrator,physics.worker}.ts` — N-body ワーカー一式は現在未使用。
  CLAUDE.md の方針どおり **削除せず**、`src/physics/nbody/`(または同等)に隔離して
  「cislunar フェーズ用・現在未使用」であることをディレクトリ単位で明示する。
- `npx ts-prune` 相当の手検査で、export されているが未参照のシンボルを洗い出して削除
  (ships.ts / hud.ts の公開 API が候補)。

## ステップ 2. マジックナンバーの定数化(中・低リスク) — ✅ 完了 (2026-07-19)

`game.ts` に散在する ~170 箇所の数値リテラルを精査し、**ゲームプレイ調整に関わるもの**を
`const.ts` へ移す(数学的な係数 0.5・単位変換などは対象外)。主な候補:

- `spawnMagPickup(minDist = 1250, maxDist = 2500)` などのデフォルト引数
- ステージ 0/00 のウェーブ生成・タイマー関連の数値
- エフェクト(フラッシュサイズ、破片サイズ範囲、SFX クールダウン)関連
- 敵 AI / プラズマ弾のパラメータ

命名は既存の `const.ts` の規約(SCREAMING_SNAKE + 日本語コメントで単位を明記)に合わせる。
`hud.ts` / `planner.ts` / `audio.ts` にも同様の掃き出しを行うが、描画レイアウト専用の
数値はファイルローカル定数に留める(const.ts をレイアウト値で汚さない)。

## ステップ 3. game.ts の責務分割(大・中リスク) — 本丸 — ✅ 完了 (2026-07-19)

実績: belt.ts(272行)/ stages.ts(436行)/ combat.ts(586行)/ environment.ts(189行)/
markers.ts(489行)を切り出し、game.ts は 3,356 → 1,811 行。resolvePhysicalCollisions と
syncRender 系(軌道線・カメラ・シーン変異)は密結合のため game.ts に残置(計画どおり)。

3,356 行の `Game` クラスを、planner/mapview と同じ「Ctx 注入・game.ts を import しない」
方式でモジュールへ切り出す。1 モジュール = 1 コミットで段階的に:

1. **ベルト物理** (`belt.ts`, ~250 行): `updateBeltPhysics` / `shiftBeltNodes` /
   `beltPos`・`beltTwist` 等の状態とスクラッチ変数(`beltQInv`...)。自己完結度が最も高く、
   最初の切り出しに最適。
2. **ステージ演出** (`stages.ts`, ~350 行): `makeEnemySpecs` / `makeStage0Specs` /
   `updateStage0Timer` / `updateStage00` / `spawnStage00Wave` 等。ステージ追加時の
   変更箇所をここに閉じ込める。
3. **武器・被弾** (`combat.ts`, ~400 行): `fireGun` / `firePlasma` / `checkBulletHits` /
   `segmentHit` / `applyHit` / `destroyShip` / `spawnDebris` / `spawnFragments` /
   `solveLeadTime`。
4. **環境・熱** (`environment.ts`, ~150 行): `makeEnvAccel` / `updateThermal` /
   `checkThermalLimits` / `updateAltitudeAlarm` / `updateEphemeris`。
5. **HUD マーカー同期** (`markers.ts`, ~400 行): `updateMarkers` / `updateNodeMarkers` /
   `updateBoardMarkers` / `updatePipOverlay` / `updateHudPanels` / `project`。
6. 残る `game.ts`(目標 ~1,200 行)は「入力→状態遷移→ simulate → syncRender」の
   オーケストレーションに専念する。

各切り出しで CLAUDE.md の該当セクションを更新する。

## ステップ 4. hud.ts の整理(中・低リスク) — ✅ 完了 (2026-07-19)

実績: `hud/dom.ts`(静的 DOM/スタイル構築、旧 constructor 本体)と `hud/markers.ts`
(`MarkerManager`: マーカー管理)にファイル分割。`hud.ts` はパネル更新・トースト・
ヘルプ・設定・終了画面と、`MarkerManager` への委譲メソッドのみを残し 876 → 約 400 行。
公開 API(メソッド名・シグネチャ)は不変のため呼び出し側(game.ts 等)への diff はゼロ。
テーマ値は引き続き `theme.ts` のみ参照。

## ステップ 5. 物理関数の回帰テスト整備(中・低リスク) — ✅ 完了 (2026-07-19)

実績: `tsconfig.test.json`(CommonJS, outDir `tests/dist`、gitignore 済み)+
`tests/physics/*.test.ts`(vec3 / orbital / attitude / atmosphere / ephemeris、
計 23 ケース)+ 極小ランナー `tests/physics/harness.ts` を追加。
`npm run test:physics` = `tsc -p tsconfig.test.json && node tests/dist/tests/physics/index.js`。
追加 devDependency なし(素の `node:assert/strict`)。往復系(ケプラー要素⇄状態、
真近点角⇄位置・速度)は機械精度の理論値で検証、RK4 1周誤差・J2 の RAAN 回帰率・
大気密度テーブル境界の連続性は現状実装を実測してその値を基準値として固定
(理論値ではなく回帰検知が目的)。23/23 パス。

リファクタの安全網として、既存の検証手順(CLAUDE.md 記載: `src/physics/*.ts` を tsc で
CommonJS にコンパイルして node で assert)を `npm run test:physics` としてスクリプト化する。
対象: orbital.ts のケプラー往復精度、J2 の RAAN 回帰率、attitude.ts のエネルギー保存、
atmosphere.ts の密度テーブル境界。ステップ 3 以降の各コミット前に必ず実行。

## ステップ 6. 仕上げ(小) — ✅ 完了 (2026-07-19)

実績: `tsc --noUnusedLocals --noUnusedParameters` はリポジトリ全体で 0 件(既存 tsconfig で
有効済み、目視確認でも削除対象なし)。`game.ts` の import ブロックのみ、physics 系
(`orbital`/`ephemeris`/`predict`/`attitude`/`vec3`)を一箇所にまとめ、game 内モジュール
(`planner`〜`entities`〜`input`...)をその後に続ける並びに再編(three → physics → game内 →
render)。CLAUDE.md はアーキテクチャ節を通読し、`game.ts` の説明が旧構成(HUD マーカー
所有・updateThermal/makeEnvAccel の所在)のままだった箇所と、N-body ワーカー一式の
パス(`src/physics/{bodies,integrator,physics.worker}.ts` → 実際は `src/physics/nbody/`)
を修正。three.js のバージョン更新は行わず `three-shims.d.ts` は据え置き。

- import の整理(未使用 import 削除、`game.ts` の巨大 import ブロックの再編)。
- `three-shims.d.ts` — three.js を更新する場合は upstream 型の有無を確認(今回は据え置き可)。
- CLAUDE.md のアーキテクチャ節を最終構成に合わせて更新。

---

## 順序の根拠とリスク管理

- ステップ 1–2 は挙動に触れない準備作業で、ステップ 3 の diff を小さくする。
- ステップ 5(テスト)は本来早いほど良いが、物理コードは今回ほぼ触らないため、
  分割作業(ステップ 3)と並行で整備すれば足りる。分割前倒しでも可。
- ステップ 3 は 1 モジュールずつコミットし、各回で実プレイ(発射・ベルト挙動・
  マップモード・ステージ 0/00)を目視確認する。
- `dev.md` は人間専用のため一切編集しない。
