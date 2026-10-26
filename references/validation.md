# 已執行驗證（2026-10-26）

這是本次 Windows 本機遷移的驗證摘要，不是對任意角色素材的品質保證。角色原圖、模型與完整私有報告未上傳到公開倉庫。

## 舊路徑隔離後

- 新 runtime 的 `doctor --require-exporter --forbid-root <old-root>` 通過，從已安裝 Skill junction 執行也通過。
- 隨附的 19 層合成 PSD 能建立新專案、通過驗證並渲染 10 張 PNG。
- 既有私有專案的 127 張材質、source、history、evidence 驗證通過；重新匯出的 MOC 與使用者已認可版本 SHA-256 完全相同。
- 新匯出以官方 Cubism Core 讀回：82 個姿態、16 張 atlas 渲染圖、0 failures；最大位置誤差 0.3845 px 以內，未放寬 0.55 px 門檻。
- 新 VTS 套件的 model3 引用有效，追蹤 preset 的其他欄位逐項相同，正常／追蹤遺失待機動畫均可封裝。
- 引擎實際 WebGL 預覽測試退出碼 0，原效能門檻通過；保存三張模型畫布 PNG 與 SHA-256。先前出現的頸部疑慮由實際畫布複查，使用者確認本次正常。

另一位代理也使用公開合成 fixture 獨立完成建模、匯出、官方 Core／atlas 驗證和 VTS 試用封裝；其素材沒有閉眼／張口補件，套件未設定追蹤映射，不把它稱作完整角色成品。

## 程式檢查

- 引擎原單元測試：53 個檔案、334 項通過。
- 最後工具檢查：Python 8 項通過，1 項因 Windows 未提供檔案 symlink 建立權限略過；目錄 junction fixture 通過。Node 工具測試 12 項通過。
- CLI child process 回歸測試另有 3 項，涵蓋完整 stdout 排空後解析、UTF-8 分塊和失敗診斷；TypeScript CLI 編譯通過。

本次補上實際驗收發現的兩個工具問題：等待 child `close` 後解析 JSON；由 exporter metadata／CDI3 驗證待機參數 ID，支援標準 model3 沒有自訂 `Parameters` 欄位的情況。

## 證據界線

這次驗證了新流程、離線 Core／atlas 和引擎預覽。未為遷移重新啟動 VTube Studio，亦未以 Cubism Editor 開啟另存 CMO3；匯出仍明列 `awaiting-visual-review`。機器上的預覽 FPS 不能當成 VTS 實機效能。
