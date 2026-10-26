# 製作與視覺 QA

先用 `inspect` 盤點專案、目前 revision、角色部件及素材來源；以公開 API／CLI 在目前 revision 上建立修改，並遵守 current-revision guards。寫入後確認新 revision 和變更範圍符合任務，保護未指定部位及已接受內容。不得手改 canonical project 檔案。

## 分層驗收

- 完整列出存在的所有部件：皮膚、衣物、裙、襪、前髮與後髮等也要納入。不存在的部件標示為不存在，素材不足則指出確切缺口。
- 各部件按 [references/source-art-and-parts.md](source-art-and-parts.md) 進行真 alpha、白／深底、200% 放大、來源疊合檢查；特別看臉部錨點、虹膜與睫毛烘焙細節、髮絲、耳緣 matte、亮膚、部件交界及遮擋處。
- 多位姿檢查必須使用同一來源姿勢／變換，對照 source asset、nativeCore 及 atlas。不可用不同姿勢或不同尺度的圖推斷對齊正確；檢查圖需可追溯至同一 revision。
- 若有工具且任務風險／複雜度值得，安排多位 Luna reviewer 獨立目視 QA，涵蓋不同區域或證據；彙整各自實際看到的問題與分歧。JSON、manifest、數值檢查或 agent 文字結論不等於看過圖片。不要為小型低風險任務硬性召集 reviewer。

## 結果陳述

使用 `compare`、`verify-native` 等命令前依 `--help` 確認參數。分別報告結構／資料驗證、source-to-native／atlas 的離線視覺結果、review 狀態和任何阻礙。離線 Core 圖、預覽 FPS 或 smoke 通過不能代替 VTS 實機畫面與實機效能。擷取工具失敗時記錄錯誤及無法判定的範圍，不要反覆請使用者重試已失敗的截圖；可行時改用另一種證據，但不能把替代證據冒稱實機結果。

如果 Editor 工程沒有在 Cubism Editor 中開啟並另存，清楚標為未經 Editor 另存。不要將「可載入／結構驗證」改寫成 Editor 編輯器驗收。
