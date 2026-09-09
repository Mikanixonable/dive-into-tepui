# T2: 実GPU境界とEarth materialを完成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**変更対象**: `src/render/earth-surface-gpu-three.ts`（新規）、`src/render/earth-surface-gpu.ts`、
`src/render/earth-surface-material-node.ts`、`src/render/earth-surface-material.ts`、render tests。

1. 色`DataArrayTexture`、地形`DataArrayTexture`、RGBA8ページ表を作るadapterを追加する。Three内部APIが必要ならこのadapter内だけへ隔離する。
2. TSLを、楕円体法線→共通地理UV→ページ表Nearest→現在/親層→sRGB線形化→色/法線/roughness混合→`normalNode`の順で実装する。
   R=255は全球baseを読む。模式図は地形層を読まず幾何法線を使う。
3. 2D array、128層、RGBA8 sRGB線形化、Float16地形線形標本化を起動時に検査する。不成立時はbase-onlyとする。
4. fake backendで、色・地形・ページ表の同一frame公開、非公開層だけの書込み、dispose後の遅着拒否を固定する。
5. 実ブラウザではz=0/1、親子fade、極、±180度、非一様半軸、自転0/90/180度を撮影する。

**検証**: `npm run typecheck`、`npm run test:render`、fake backendテスト。実WebGPUを起動できない場合はbase-onlyを合格とし、実GPU成功とは記録しない。

**困難点**: Three.js公開APIだけでは配列層の非同期更新が足りない可能性がある。内部APIを使う場合はThree.js版とブラウザ版をbaselineへ記録する。
