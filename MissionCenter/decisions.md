# Decisions

- 2026-10-26｜依使用者指示，本輪允許直接提交並上傳 `main`，不保留分支。
- 2026-10-26｜CodeRabbit 上傳授權已由使用者提供；只涵蓋本輪必要、可公開審查程式碼，不涵蓋角色圖、個人角色資料、VTS preset、生成圖片、模型或 runtime cache。
- 2026-10-26｜完整 review 一次，只有修正後確有需要才進行一次 focused re-review；遵守每小時 3 次、每次 150 檔額度。
- 2026-10-26T09:06:57Z｜review-1 啟動：150 unique files、1,319,318 bytes；來源 9b038c6、逐檔 SHA 一致，排除 binary/private/lockfiles 與無關大型文件。
- 2026-10-26T09:12:22Z｜review-1 `review_completed`、exit 0；150 reviewed files、9 issues（2 major、7 minor）、0 errors。MissionCenter 僅記總量；raw report 不作公開引用，等 root 提供可安全引用的 findings/dispositions 摘要後再完成 MC-002 passport。
- 2026-10-26｜issue 3/4 的 int16 overflow 經 root 確認為真問題；改用 int32，相關 7/7 驗證通過。issue 6 setup path 為 false positive，兩種 equality 比較皆 true。其他 findings 仍核實或處理中，不能標 MC-003 Done。
- 2026-10-26｜README 兩個本地文件查證獨立於 Rabbit：鎖定 NumPy METADATA 要求 `Requires-Python >=3.12`；`inspect --panels` 未帶 `--roi` 時 exit 1，補上後 exit 0 並產生 PNG。
- 2026-10-26｜使用者明確授權 README 公開展示「透明原圖、大頭照、完成品」三張圖，這是僅適用該三張展示圖片的例外；不擴及完整模型、VTS 設定或其他角色私有資料。文案需呈現實際補繪、綁定、驗收過程，不稱完全無人工一鍵完成。圖片來源及成品仍待 root 核對。
- 2026-10-26｜review-2 已完成，exit 0、15 files、2 minor，兩項皆指新 export-path helper，仍待 disposition／驗證；本輪不再進行第三次 CodeRabbit review。
- 2026-10-26｜root 回報 build、Node 17/17、Python 10 pass/1 skip、image 7/7、vendor 9 files/53 tests 與 19-layer smoke 10 PNG 通過；搬移 export 的真 Core integration 尚在執行。
- 2026-10-26｜官方 digest 演算法已由 GitHub 公開、版本匹配的 v0.5.2 source 確認：[canonical_task_digest 實作](https://github.com/Gale0418/Codex-Mission-Center/blob/v0.5.2/rust/mission-center-core/src/lib.rs)，release target commit `389619a88a473678fc16ef7562d19689cca202dc`。固定欄位順序為 id、title、kind、parent、priority、assignee、dependencies（以 `, ` 串接）、next_action、verification、estimate、tags（以 `, ` 串接）、notes；前綴為 `mission-center-task:1.0\0`，每欄以 UTF-8 byte 長度十進位、冒號、UTF-8 bytes、NUL frame，最後 SHA-256；status 排除。依 parser alias 計算後，Rust transition 已成功驗證 MC-002 passport 並 Review→Done。
- 2026-10-26｜MC-002 僅驗收 review 紀錄與 9 項 finding dispositions，屬非感知性的審查證據整理；Completion Critic Council 依低風險非感知工作 skip，實作修正與整合仍由 MC-003 驗證，不以本 passport 代替。
- 2026-10-26｜最終 MC-003 驗證摘要：Node 20/20、Python 10 pass/1 skip（junction pass）、vendor 9 files/53 tests、六個 workspace build、19-layer smoke 10 PNG、搬移後官方 Core 77 poses／14 frames／0 failures／最大誤差 0.49328 px 以內、VTS runtime references valid、final doctor ready=true。critic_lite advisory 無 P0/P1，屬 advisory，不是測試結果。
- 2026-10-26T09:53:23Z｜首次公開發布已完成，commit `e6504fd8bf4d4457e8526543130bd5b56e1110f4` 推送至 `main`；GitHub ref 獨立讀取同 SHA，README 與三張授權 PNG 的 metadata/blob SHA 核對吻合，工作樹乾淨且只有 `main` 分支並與 `origin/main` 同步。後續僅提交最終 MissionCenter receipts／closeout 是收據同步，不是重做程式或圖片發布。
