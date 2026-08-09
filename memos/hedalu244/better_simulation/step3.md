### Step3 引力がありかつ重力を受ける存在の追加

実装済み(`memos/hedalu244/for_agent.md` §4 が実行手順、実装結果は `CLAUDE.md`/`DEVELOP/OWNERSHIP.md`/`DEVELOP/CALLSTACK.md`/`DEVELOP/SPEC.md` に反映済み)。

- **無数の小惑星を追加してもパフォーマンス的に爆発しない**: `game/game-entity/asteroid.ts` の `Asteroid`(質量1つから重力定数と衝突半径を導く)が既存の積分経路にそのまま乗り、`game/simulation/gravity-attractors.ts` が解析天体の重力窓と生存中の重力天体を毎ステップ1回だけ合流させ、`physics/attractor.ts` の `relevantAttractors` が実際の寄与(静的な影響半径の見積りではない)でその位置に無視できる天体を落とす、という位置依存の絞り込みまでを実装した。**空間インデックス(spatial hash)は実測していないため要否が判断できておらず、`physics/spatial-grid.ts` は存在しない** — `step4.md` が判断手順(絞り込み導入後に大量配置で実測 → 悪化があれば実装、なければ打ち切り)を持つ。
- **太陽が存在しない3連星系といった自由な星系**: 質量が比較可能な複数天体が相互に複雑な軌道を描く状況(閉じた解析解を持たない真の多体問題)は `Asteroid` どうしの相互重力がそのまま担い、現実の太陽系とは異なる天体構成・原点で進行するステージは `Ephemeris` が天体レジストリ・ECI 原点・主星の解決をインスタンスごとに持てるようになったことで表現する(`game/stages/stage-debug-alt-system.ts` が両方を実演するデバッグ専用ステージ)。既定レジストリでの既存挙動・GUI の選択肢は一切変わらない。
- **命名の再検討**(`game/celestial/` の見た目クラス群を `CelestialEntity` 系へ寄せるか)は見送った — 統合の前提(解析天体を状態を持つ側へ作り替えること)自体を採らなかったため、改名が意味を持つ前提が発生しなかった。
