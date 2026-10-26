# CodeRabbit 審查與處置｜2026-10-26

## 範圍

CodeRabbit CLI 0.7.6 第一輪以 150 個相同內容的程式／測試／流程文件副本審查，涵蓋 `6bd82de` 與 `9b038c6` 的現有內容及相關舊核心邏輯，總計 1,319,318 bytes。主倉庫維持 `main`；副本用空白基準及 staged diff 呈現選定內容，不修改程式碼來改變審查結果。

已排除角色資料、圖片、模型、runtime、依賴、生成物、鎖檔與無關的大型上游文件。第一輪退出碼 0，回報 `review_completed`、150 reviewed files、9 issues（2 major、7 minor）、0 errors。

## 逐項處置

| # | 級別 | 位置 | 查證與處置 |
| --- | --- | --- | --- |
| 1 | Minor | `vendor/puppetloom/test/runtime-control-service.test.ts` | 成立。測試輸出寫死磁碟位置，改用既有 managed `artifactPath`。 |
| 2 | Minor | `vendor/puppetloom/packages/renderer/src/renderer.ts` | 成立。失敗後 texture workers 仍會領取工作；修為停止領取、關閉遲到 bitmap，等活動 workers 結束再傳出首個錯誤。 |
| 3 | Major | `scripts/inspect_rgba.py` | 成立。亮白 opaque 像素乘 alpha 的 int16 溢位，應為 255 的差異被算成約 2.0039；改用 int32。 |
| 4 | Major | `scripts/compare_overlay.py` | 同樣成立。新增回歸測試並改用 int32，保留原差異定義與透明遮罩。 |
| 5 | Minor | `vendor/puppetloom/apps/cli/src/cli-support.ts` | 成立。Photoshop helper 的 UTF-8 跨 chunk 解碼及 exit/close 時序有誤，改成 decoder 與 close 後解析。 |
| 6 | Minor | `scripts/setup.ps1` | 不採用。實際 `Get-TailorNode` 和 `Join-Path` 產生的完整路徑已相同，直接比較與正規化後比較皆為 true；未重現自我複製，不加無效改動。 |
| 7 | Minor | `scripts/native/verify.mjs` | 成立。搬移匯出後舊絕對路徑造成誤拒絕。改比較原輸出根目錄下的相對路徑，保留不同子目錄與越界拒絕；未採只比 basename 的較弱建議。 |
| 8 | Minor | `scripts/tailor.ps1` | 成立。PowerShell 邏輯運算結合使預設／明示 help 回傳空白；加括號固定條件。 |
| 9 | Minor | `scripts/package_vts.mjs` | 成立。preset 可殘留未複製的圖示／待機檔案引用；未提供對應素材時清空，提供時複製並寫入新引用。 |

## 小範圍複審

第二輪只審查 15 個修正程式與回歸測試檔案，退出碼 0、`review_completed`，提出 2 個 minor，均集中在新的匯出路徑 helper：

- `moc3` 欄位存在但為空值／非字串時，原 guard 會把它當成省略。上游僅讀 JSON、沒有型別 schema，問題成立；新增失敗回歸後，修為只允許真正缺少欄位，其餘不合法值拒絕。
- 所有平台一律忽略大小寫會掩蓋 POSIX 路徑差異。問題成立；Windows 保留原有不分大小寫的契約，其他平台採嚴格比較，補入平台契約測試。POSIX 分支在 Windows 單測中模擬，未宣稱完成 Linux 原生 Core 驗證。

兩輪合計 11 個 issues：10 項修正、1 項以反證拒絕。共使用 2 次審查；第二輪修補後已重跑受影響測試，未再追加第三輪。

## 最終本機驗證

- 六個引擎 workspace 完整 build 通過，包含桌面預覽與 CLI。
- renderer、CLI helper、runtime-control 相關 Vitest：9 個檔案、53 項通過。
- Node 工具回歸：20 項通過。Python：10 項通過，1 項因 Windows 檔案 symlink 權限而略過，目錄 junction 測試通過。
- 新的 19 層合成素材能 create／verify／render，產生 10 張 PNG。
- 實際匯出後搬移整個匯出目錄，再用官方 Core 讀回：77 姿態、14 張 atlas 渲染、0 failures，最大位置誤差 0.49328 px 以內；VTS 套件的 model3 引用驗證通過。這是合成 fixture 的離線驗證，未啟動 VTS。
- `doctor --require-exporter --forbid-root <old-root>` 通過；README 範例三張圖的 SHA-256 與原檔相同，圖示連結和來源標示已查核。

另由協作代理做一次 bounded 唯讀收尾查核，核對已知修補、README 範例及資料公開範圍，未見交付阻斷 P0/P1 或明顯回歸。該代理先前參與兩處影像 QA 修正；這項 advisory 與 CodeRabbit 外部審查、實際測試分開記錄。

另經本地查證修正 README 的 Python 最低版本與 `inspect --panels` 必要參數，這兩項不是 CodeRabbit 提出的 issues。
