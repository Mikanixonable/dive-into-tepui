# 宇宙船モジュールのリアル化 & 太陽電池対称化の完了ウォークスルー

## 概要

宇宙船モジュールの外観リアリズム向上および不具合解消のため、以下の課題を解決しました：
1. **太陽電池の配置が左右非対称になる問題の解消**
2. **側面の「役割のわからない板」や「円柱状の突起」の全廃**
3. **実在の宇宙船（ISS、ソユーズ、ジェミニ、マーキュリー、HTV、RL-10エンジン等）に基づくディテールの本格実装**
4. **Blender 5.0.1 headless Python スクリプトによる自動モデリング & GLB 出力パイプラインの構築と統合**

---

## 変更内容

### 1. 太陽電池・ラジエーターの対称性修正
- [`src/game/ship/ship-assembly-transform.ts`](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/ship/ship-assembly-transform.ts):
  - `sideSlotRotation(slot)` を新規導入。
  - 4つの側面スロット（`+x`, `-x`, `+y`, `-y`）すべてにおいて、子モジュールのローカル +X 軸が船尾方向 `(0, 0, -1)` を向く回転クォータニオンを適用。
  - これにより、太陽電池パネルおよびラジエーターが船体中心軸に対して完全な線対称・鏡像対称に展開されるようになりました。

### 2. Blender Headless 自動モデリングスクリプト
- [`tools/model-builder/blender/build-ship-modules.py`](file:///Users/pandeaconica/lab/dive-into-tepui/tools/model-builder/blender/build-ship-modules.py):
  - Blender 5.0.1 の Python API (`bmesh`, `mathutils`) を用いたスクリプトを作成。
  - 全 18 種類の宇宙船モジュール（コックピット、タンク 3/6/12m メイン & RCS、推進器、ブースター、RCS、ドッキングポート、建造ドック、デカプラー、ソーラー基部、ラジエーター基部、装甲、兵装）を `assets-src/ship-modules/*.glb` に生成。
  - **導入されたリアルディテール**:
    - **コックピット**: ソユーズ・マーキュリー風テーパーカプセル、ジェミニ風観察窓フレーム、アブレーションヒートシールド、CBMドッキングフランジ。
    - **タンク**: 外周を走る極低温推進剤配管、サドルクランプ、90度エルボ継手、ドームエンドキャップ、HTV風構造トラス。
    - **推進器 & ブースター**: 放物線（Rao曲線）プロファイルのノズルベル、ベル補強リング、ジンバルアクチュエータ、環状マニホールド配管。
    - **RCS**: 4ノズルクラスター、推進剤バルブ、マウントブラケット。
    - **ドッキング機構**: APAS-95風3枚ガイドペタル、CBMボルトパターン、アライメントピン、`interface-ring`。

### 3. GLB → shipModules.json パイプライン統合
- [`tools/model-builder/ship-modules.mjs`](file:///Users/pandeaconica/lab/dive-into-tepui/tools/model-builder/ship-modules.mjs):
  - `GLTFLoader` による非同期 GLB パーサー (`loadGlbScene`, `applyGlbModel`) を実装。
  - `addKindDetails`, `buildModule`, `buildShipModules` を `async/await` 化。
  - `tests/render/ship-module-asset.test.ts` の契約テスト条件（`tank-band`、`interface-ring`、semantic anchor、展開部品枚数・寸法）を 100% 維持。
- [`tools/model-builder/export-models.mjs`](file:///Users/pandeaconica/lab/dive-into-tepui/tools/model-builder/export-models.mjs):
  - `shipModules: await buildShipModules()` に対応。

---

## 検証結果

### 1. 描画結果の確認 (`npm run render-lab:shot`)
- `.render-lab/shots/modular-ship-combat.png` において：
  - 太陽電池パネルが左右完全に対称に展開されていることを確認。
  - コックピットのなめらかな曲面とジェミニ風窓、アブレーションシールドが確認。
  - タンク外周の配管とクランプ、推進器のノズルベルとジンバルが写実的に描画されていることを確認。
  - 以前存在していた謎の直方体板・円柱突起は完全に除去されたことを確認。

### 2. 回帰テスト & 型検査
- `npm run test:render`: **227 / 227 passed**
- `npm run test:game`: **317 / 317 passed**
- `npm run typecheck`: **エラー 0**
