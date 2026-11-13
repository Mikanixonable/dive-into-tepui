# ゲームループ改善の実装計画(4本)

作成日: 2026-11-14 / コードのスナップショット: `bbe81c893`(作業ツリーに `src/game/flash-presenter.ts`・
`src/render/billboard.ts` の未 commit の変更あり)

| 計画 | 中身 | 依存 |
| --- | --- | --- |
| [01-reward-loop.md](01-reward-loop.md) | 撃破ドロップを近くで落とすほど拾える形へ / 鹵獲品を積んだ補給艇 / 授与を褒める | なし。最初に着手 |
| [02-kill-impact.md](02-kill-impact.md) | 撃墜と自機喪失の一瞬の止め / 逆光の散布界をボアサイトで見せる | なし |
| [03-wave-pacing.md](03-wave-pacing.md) | 波の組成表 / ボス波(タンパク質陣形)と息抜きの波 / 敵の型ごとの射撃の性格 | なし(ボス波の報酬は補給の台本投入で完結させた) |
| [04-retry-and-onboarding.md](04-retry-and-onboarding.md) | 撤退して再出撃 / 詰みの検知 / 自己ベストと結果画面 / 最初の3分 | なし |

01 と 03 はどちらも `src/game/stages/stage-utils/wave-attack.ts`・`stage00.ts`・`run-events.ts` を
触るので、並行させず 01 → 03 の順に進める。02 と 04 は `game-presentation.ts`・`run-event-presenter.ts`
を他と共有するが、触る箇所が分かれているので順不同でよい。

すべて `/write-plan` の形式で、着手は `/run-plan`。各計画の手順 1 は SPEC の更新
(`/modify-feature`、`docs(spec):` の単独 commit)。

**対象外**: 撃破の爆発の段階・敵マーカーの命中表示・効果音の優先順位は、SPEC が `bbe81c893` で
定まり、別の作業で実装中なので、どの計画にも入れていない。
