# ADR-002: cockpit の有無で ship と物資を分類する

- 日付: 2026-09-16
- 状態: accepted
- 対象計画: vessel-assembly-dock-construction-plan_2026-09-14.md

## 決定

健全な `cockpit` を1個以上持つ接続グラフを、ユーザー向けに `ship` と分類する。健全な cockpit がない、または全 cockpit が不健全な接続グラフは `物資` と分類する。

船と物資は同じ `ShipAssembly`／`ModularShip` の物理・保存単位を共有する。物資は操縦できないが、漂流・保存・ドッキングでき、健全な船から操作された dock を介して建造・修理を受けられる。健全な cockpit が復帰した場合は同じ assembly ID のまま即時に ship へ再分類する。

cockpit や tank の不在、燃料切れ、HP 0 の module instance は、それだけでは船体喪失にしない。module instance が一つでも残る限り物資として存続し、構造上有効なグラフなら cockpit なしでも建造・分離できる。

## 理由

分離後の固体燃料 booster や cockpit を失った船体を、専用の別クラスや一時 debris に変換せず、同じ物理・保存単位で扱うため。これにより、漂流、外部船によるドッキング、cockpit 修理後の復帰を同じ ID とグラフで表現できる。
