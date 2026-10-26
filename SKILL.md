---
name: vtuber-tailor
description: "在 VTuberTailor 中從 2D 角色原圖或分層素材製作、檢查與修復可動角色，處理 Live2D 式拆件、遮擋補繪、source asset／nativeCore／atlas 驗證、品質檢查與 VTube Studio（VTS）交付。當任務涉及 2D VTuber 角色素材、骨架／圖層、原圖保真、QA 或 VTS 套件時使用；一般插畫編修或無角色素材的圖像生成不適用。"
---

# VTuberTailor

以原始角色素材為視覺權威，使用本倉庫的包裝腳本操作自包含的 `vendor/puppetloom` 引擎，產出可追溯、可搬移且能由證據支持的 2D VTuber 角色。先盤點使用者指定的範圍與素材，再依需要讀取下列參考，不要把單一角色的尺寸、座標、版本或絕對路徑寫成通用假設。

## 工具入口

- 從倉庫根目錄執行 `./scripts/tailor.ps1`。先用 `./scripts/tailor.ps1 engine capabilities --json` 確認引擎能力與版本；其他子命令、參數及輸出以 `./scripts/tailor.ps1 <command> --help` 為準，不猜測未確認的 CLI。
- 包裝腳本提供 `setup`、`doctor`、`engine`、`inspect`、`compare`、`register`、`verify-native`、`package-vts`、`smoke`；`engine` 子命令透傳引擎 CLI。依本次任務選用最小必要命令，不把 smoke 或其他檢查當成視覺驗收。
- 任務只涉及來源素材時讀 [references/source-art-and-parts.md](references/source-art-and-parts.md)；涉及建模、比對或視覺檢查時讀 [references/production-and-qa.md](references/production-and-qa.md)；涉及舊專案遷移、可攜性或 VTS 時讀 [references/migration-and-vts.md](references/migration-and-vts.md)。

## 共通不變條件

- 原圖是造型、臉部錨點、比例及材質的權威。鎖定眼睛、瞳孔、眉、鼻、嘴、臉緣等臉部錨點；只在目標確實要求時變更，並用來源疊圖核對。
- 優先由原像素拆件；需要補遮擋時，以 `image` 補足原圖未畫出的部分，不以拉伸、複製可見像素或色差選取挖洞假裝完成。任何 Python 或其他程式化圖像編修，都必須有本次使用者對該編修方式與範圍的明確授權；過往任務的允許不是永久授權，也不可推廣成所有使用者的預設。
- source asset 依公開 API／CLI 建立與修改，並遵守 current revision guard。canonical 專案資料不可手改；immutable reference 為每個素材各自綁定，frame 的 sourceRect 必須和其 source 對齊。
- 把資料驗證、Core／atlas 離線畫面與 VTS 實機結果分開陳述。若 Editor 尚未另存、VTS 未實際目視或擷取失敗，直接標明狀態與證據邊界，不推論通過。

