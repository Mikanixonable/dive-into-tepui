# セッションの課題(優先度順)

最終更新 2026-11-15。セッション全体で今後取り組む課題を優先度順に管理する。
完了したら「完了」へ移して日付と結果を書く。各ラインの詳細は `LOOP-LOG-*.md` と
`memos/mikanixonable/handoff_2026-11-15.md` が正本。

## 実施中

1. **三循環再編(低気圧従属の前線・高気圧・波列)** — gen-dynamics worktree。
   高気圧(weather 0.103→0.099)と前線+WCB(同 0.0992)を実装・devin/dev へ統合済み
   (60f843945)。晴れ間と帯の指摘への対応の主戦場。
2. ~~巻雲教師の拡充~~ → 完了。**巻雲フィードバックループをサブエージェントへ
   委譲中**(agent 1c84ea92、gen-dynamics worktree、3–5 ステップ)。
   型別教師 90 枚を取り込み・共有データ dir へ同期済み。

## 待ち(優先度順)

3. **低気圧の波列配置** — 低気圧を蛇行する偏西風の位相線上へ配置し、高気圧と
   位相を噛み合わせる(設計 cloud-circulation-redesign_2026-11-15.md 第 3 弾)。
4. **熱帯の対流クラスタ(ハドレー)** — 500 km 級の対流塊＋周辺沈降・晴れ間、
   人参形の貿易風流れ(同設計 第 4 弾)。晴れ間の増加に直結。
5. **cloud-cells の環境依存** — 細胞の規模・寿命を海陸・緯度・湿度・時刻・風速の
   関数へ(設計 p-cells-env.md)。現 tree は step-4 状態で best は step-1(index 0.559)。
   サブエージェントの調査報告: 細胞は方向だけの決定的場で寿命なし・海側の環境が
   全般的に悪い(highlat 0.928 / temperate 1.914)。
6. **巻雲の型別フィードバック** — 教師を型別(streak/scaly/veil/anvil)の封筒へ
   整理済み。`p-cirrus-typology.md` で周期粒・流れ筋・間欠性を描画へ。
7. **deepFrac gain=0 の調査** — 監査で深い雲の応答が飽和/欠落している。

9. **sunset-refine の完遂** — worktree に devin/dev マージ済みだが test:render が
   3 件落ち(sun-transmittance 表の範囲外値・夕方の誤差 11%/許容 3%・薄明)。
   変更途中で統合不可。sunset-look のループを再開して直す必要がある。

## 完了(2026-11-15)

- 高気圧の実体(anticyclones) — weather 0.099、devin/dev 統合済み
- 低気圧従属の前線(寒冷/温暖の帯 + WCB) — weather 0.0992、同統合済み
- motion-stage2(雲の動き) — motion 距離 0.546→0.325、devin/dev 統合済み
- 巻雲の延長計量(成分の等価楕円 maxAxis/elongShare) — devin/dev へ cherry-pick 済み
- ARCHITECTURE.md(コード名ベースの基盤案内) — 作成済み
- 巻雲ドラッグ遅れの修正 — PR #176 で main へ送出済み
- 前線帯の効果計測 — 中緯度で 700–1100 km の帯成分を確認。ただし実写封筒を
  上振れする場面あり(LOOP-LOG-cirrus.md)。教師拡充が次の壁
- 巻雲教師の拡充 — 型別教師 90 枚(streak/scaly/veil)を取り込み・共有 dir へ同期
- cloud-optics(光学モデル R(τ,g) 2 流近似) — albedo 106 行全 PASS を確認し
  devin/dev へ統合(47672803d)
- translucent-teacher(半透明雲の教師道具拡張) — tools のみ・parse 確認済み、
  devin/dev へ統合(9db1e19dd)
