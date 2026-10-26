# VTuberTailor 維護原則

- 這個 repo 根目錄就是 Skill；保持 `SKILL.md` 簡潔，條件細節按需放 `references/`。
- 角色、生成圖片、模型、個人 VTS preset、封存和 runtime cache 不可加入公開 git。使用合成 fixture 測工具。
- 通用工具不可寫死某個角色的錨點、revision、目錄、VTS 路徑或過去的編修授權。
- 引擎是含修正的 AGPL PuppetLoom snapshot；保留授權、來源與修改標示，變更要更新說明。
- canonical 角色資料只能經公開 engine CLI/API 更動；不可手改 revision/immutable records 來繞過驗證。
- 檢查可見材質與相同姿態的真正 Core/atlas 畫面；資料驗證、離線原生圖和 VTS 實機不可混稱。
- 新／改 helper 執行合成 invariant tests；影響流程時另跑 `smoke`。搬移／刪除依賴目錄前，先封存驗證並隔離舊路徑做實際測試。
