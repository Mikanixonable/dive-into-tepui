# 章06: 天体表示系のレビュー

単独実行可。他章に依存しない。

## 対象ファイル
- `src/game/celestial/`: environment-scene.ts / celestial-registry.ts / celestial-body.ts / sphere-body.ts / point-body.ts / sun-body.ts / earth-body.ts / ring-view.ts / ring-lod.ts / point-field.ts / point-field-view.ts / body-class.ts / body-visibility.ts
- `src/render/`: ring.ts / celestial-surface.ts / celestial-grid.ts / stars.ts / earth.ts / sampled-line.ts / orbit-line.ts / radiator-hinge.ts(新設 — CLAUDE.md 未記載なら文書齟齬として報告)
- `src/physics/ring-optics.ts`

## 手順
1. `git log --oneline HEAD~200..HEAD -- src/game/celestial src/render` で該当コミットを把握。
2. 観点:
   - **WebGPU 制約**: `LineLoop`/`Points` 不使用、geometry/attribute の**差し替え禁止**(in-place 書き換え + `setDrawRange`)、additive は `transparent: true`。ring.ts の4ビルダーと ring-view の LOD 切替がこの規約を守るか。
   - **registry 網羅性**: `CELESTIAL_BODIES` が `SolarSystemId` に対し exhaustive(コンパイルで担保)。`fallbackCelestialView` の適用漏れ。表示名の重複定義(日本語名が celestial-registry 以外に直書きされていないか — `physics/` 内は特に禁止)。
   - **ring**: sibling-not-child 規約(スピン位相を継承しない — Adams ring arcs が静止するか)、扁平天体でリングだけ非扁平スケール、`ringVisualForm` を真位置の metersPerPixel で評価。
   - **point-field**: 決定論(`mulberry32`、`Math.random` 禁止)、1/8 round-robin 更新と `sync` の全 instanceMatrix 書き換えの分離、太陽中心キャッシュの ECI 化がフレーム毎か。
   - **body-visibility**: 「map / list / picker の三者が同じ `visibleBodyIds` を読む」一元性 — 別ルートで独自フィルタしている消費者がないか。
   - **shading 規約**: 天体はシーンライティング不参加(`sunDirection` uniform 自前シェーディング)。`NIGHT_AMBIENT` 共有。
   - `render/` から `game/` への import 禁止(`grep -rn "from '\.\./game\|from '\.\./\.\./game" src/render/`)。
3. update/sync: `EnvironmentScene.update`(点群の位置再導出)と `sync`(transform のみ)の分離。

## 検証
- `npm run typecheck`
- `npm run test:physics`(ring.test.ts / point-field.test.ts / shape.test.ts が含まれる)

## 出力
`findings/06-findings.md` にタグ付きで列挙。規約違反・明白なバグは修正可。見た目の仕様疑義は報告のみ。
