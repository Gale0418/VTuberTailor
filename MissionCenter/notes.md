# Notes

- 第一輪 CodeRabbit review 已完成：exit 0、150 files、9 issues（2 major、7 minor）、0 errors。安全逐項處置表：[Review 摘要](../references/code-review-2026-10-26.md)。
- review-1 八項 finding 已修，一項 false positive 由實測反證拒絕；兩輪總計 11 issues、10 fixed／1 rejected。MC-002 已用官方 v0.5.2 `canonical_task_digest` 與 parser alias 計算 passport digest，正式 Rust transition 已 Review→Done。
- 最終驗證摘要：Node 20/20、Python 10 pass/1 skip（junction pass）、vendor 9 files/53 tests、六個 workspace build、19-layer smoke 10 PNG；匯出資料夾搬移後官方 Core 77 poses／14 frames／0 failures／最大誤差 0.49328 px 以內，VTS runtime references valid；final doctor ready=true。
- review-2 exit 0、15 files/2 minor，兩項皆已修並以回歸測試先失敗後通過；獨立 critic_lite advisory 無 P0/P1。兩次預定 review 已用完，不再跑第三次。
- README 圖片授權僅含透明原圖、大頭照、完成品三張；不含完整模型或 VTS 設定。
- 發布待留證：實際 commit SHA、push 結果／遠端 main 位置、最後工作目錄狀態。
- Digest source：官方公開 GitHub tag `v0.5.2` 的 `rust/mission-center-core/src/lib.rs` 明確實作 `canonical_task_digest`；task parser 只認 canonical `Tags`／`Notes` header，不把目前 `Labels`／`Comments` 算入 digest。MC-002 passport gate 已成功驗證。
- MC-002、MC-003 passport gate 均已由正式 Rust CLI 通過；尚待 root 提供實際 commit/push SHA、遠端 main 證據，發布前不得標 MC-004 或 Epic Done。
