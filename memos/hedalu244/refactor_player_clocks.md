# 自機の時計の取り違え

`Player.behave` は wall `dt` と `simDt`(= `dt` × ワープ倍率)の両方を受け取り、`simDt` を
`updateTorque` へ渡す。その先で2つの量が進んでいるが、**どちらも取るべき時計が逆になっている。**

| 進めるもの | 今の時計 | あるべき時計 |
|---|---|---|
| `rotationHoldTime`([player-throttle.ts](../../src/game/player/player-throttle.ts))→ RCS 出力ランプ | sim | **wall**。「キーを何秒握ったか」という操作感の量。今は ×4 ワープでランプが4倍速く完了する |
| RCS 燃料消費(`updateTorque`) | sim | sim |
| 推進燃料消費(`buildThrust`) | **wall** | **sim**。推力は `simDt` ぶん積分されるので、wall で消費すると燃料あたりの Δv がワープ倍率で変わる |

`Player.stepEnvironment` が「wall `dt` から分離し、各 substep 終端の値を使うことで warp 依存を
防ぐ」ために存在するのと同じ理由が、燃料にもそのまま当てはまる。

## 手順

1. `rotationHoldTime` を wall `dt` で進める。これで `updateTorque` から sim 時計が消え、
   `behave` が受け取る `simDt` も要らなくなる。
2. 燃料消費を substep 側(`stepEnvironment` と同じ位置)へ移す。`consumeFuel` は**残燃料比で
   推力・角加速度を絞る**返り値を持つので、移すには「指令値」と「実効値」の分離が要る —
   `behave` が出すのは指令で、実際に出る推力は substep が燃料残量から決める形にする。
