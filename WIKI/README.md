<p align="center">
  <img src="../.github/readme/wiki-title.svg" alt="Dive into Tepui 開発 WIKI" width="100%">
</p>

# Dive into Tepui WIKI

この WIKI は、コードベースを **技術・太陽系・軌道・気象・ゲームシステム** の5分野から読むための案内です。現在の実装はコードが原本であり、ここでは個別クラスを網羅せず、各分野の意味・責務・データの流れを短く整理します。

| 記事 | 主題 | 主な入口 |
| --- | --- | --- |
| [技術](01-technology.md) | 状態所有、フレーム、WebGPU、データ基盤、検証 | `src/run/`, `src/render/`, `tools/` |
| [太陽系](02-solar-system.md) | 天体階層、暦、天体モデル、照明・座標系 | `src/game/celestial/`, `src/physics/ephemeris/` |
| [軌道](03-orbits.md) | ECI、数値積分、摂動、マニューバ、CR3BP | `src/physics/`, `src/game/plan/` |
| [気象](04-weather.md) | 気候場、循環、凝結、雲場、光学描画 | `src/render/cloud/`, `src/render/atmosphere.ts` |
| [ゲームシステム](05-game-systems.md) | ステージ、船体、戦闘、UI、保存 | `src/game/`, `src/launcher/`, `src/settings/` |

> [!IMPORTANT]
> ゲームがどう振る舞うべきかは [SPEC](../DEVELOP/SPEC/README.md)、層・状態所有・import の規則は [ARCHITECTURE](../DEVELOP/ARCHITECTURE.md)、コードの書き方は [CODING-RULE](../DEVELOP/CODING-RULE.md) が正本です。

<p align="center">
  <a href="../README.md"><strong>← README</strong></a>
  ·
  <a href="01-technology.md"><strong>技術 →</strong></a>
</p>
