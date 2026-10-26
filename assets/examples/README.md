# README 展示圖片

這三張圖依使用者明確要求公開，用於展示本次製作過程；檔案均直接複製，未改動像素、縮放或去背。`sha256.json` 保存公開檔案的 SHA-256。

| 檔案 | 階段與來源 | 尺寸／透明度 |
| --- | --- | --- |
| `source-reference-transparent.png` | 最初分層專案保留的 `source/reference.png` 合成參考。 | 4096×4096，RGBA，含透明背景。 |
| `approved-portrait.png` | 使用者確認的大頭照，後續五官與髮型的視覺基準。 | 1086×1448，RGB，淺色背景。 |
| `finished-r32.png` | r32 官方 Cubism Core 幾何讀回及匯出 atlas 的離線中立渲染；該次原生檢查涵蓋 82 個姿態、16 張渲染圖，0 failures。 | 2048×2048，RGBA，含透明背景。 |

完成圖不是 VTube Studio 視窗截圖。圖片不包含可供執行的模型檔、個人 VTS preset 或完整專案；CLI 驗證、離線渲染與 VTS 實機結果仍分別記錄。
