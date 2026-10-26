param(
  [Parameter(Mandatory=$true)][string]$MocPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$PoseInputPath,
  [Parameter(Mandatory=$true)][string]$CorePath
)
$ErrorActionPreference = 'Stop'
$MocPath = [IO.Path]::GetFullPath($MocPath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$CorePath = [IO.Path]::GetFullPath($CorePath)
if (-not (Test-Path -LiteralPath $MocPath -PathType Leaf)) { throw "MOC3 not found: $MocPath" }
if (-not (Test-Path -LiteralPath $CorePath -PathType Leaf)) { throw "Live2D Cubism Core DLL not found: $CorePath" }
$mocBytes = [IO.File]::ReadAllBytes($MocPath)
if ($mocBytes.Length -gt [UInt32]::MaxValue) { throw 'MOC3 exceeds the C API 32-bit size argument.' }
if ([Text.Encoding]::ASCII.GetString($mocBytes, 0, [Math]::Min(4, $mocBytes.Length)) -ne 'MOC3') { throw 'Input does not have a MOC3 header.' }

$escapedCore = $CorePath.Replace('"', '\"')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VtsCubismCore {
  [DllImport(@"$escapedCore", EntryPoint="csmGetVersion", CallingConvention=CallingConvention.Cdecl)] public static extern UInt32 GetVersion();
  [DllImport(@"$escapedCore", EntryPoint="csmGetLatestMocVersion", CallingConvention=CallingConvention.Cdecl)] public static extern Int32 GetLatestMocVersion();
  [DllImport(@"$escapedCore", EntryPoint="csmGetMocVersion", CallingConvention=CallingConvention.Cdecl)] public static extern UInt32 GetMocVersion(IntPtr address, UInt32 size);
  [DllImport(@"$escapedCore", EntryPoint="csmReviveMocInPlace", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr ReviveMocInPlace(IntPtr address, UInt32 size);
  [DllImport(@"$escapedCore", EntryPoint="csmGetSizeofModel", CallingConvention=CallingConvention.Cdecl)] public static extern UInt32 GetSizeofModel(IntPtr moc);
  [DllImport(@"$escapedCore", EntryPoint="csmInitializeModelInPlace", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr InitializeModelInPlace(IntPtr moc, IntPtr address, UInt32 size);
  [DllImport(@"$escapedCore", EntryPoint="csmUpdateModel", CallingConvention=CallingConvention.Cdecl)] public static extern void UpdateModel(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmReadCanvasInfo", CallingConvention=CallingConvention.Cdecl)] public static extern void ReadCanvasInfo(IntPtr model, IntPtr size, IntPtr origin, IntPtr pixelsPerUnit);
  [DllImport(@"$escapedCore", EntryPoint="csmGetParameterCount", CallingConvention=CallingConvention.Cdecl)] public static extern Int32 GetParameterCount(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetParameterIds", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetParameterIds(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetParameterValues", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetParameterValues(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableCount", CallingConvention=CallingConvention.Cdecl)] public static extern Int32 GetDrawableCount(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableTextureIndices", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableTextureIndices(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableConstantFlags", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableConstantFlags(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableIds", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableIds(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableOpacities", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableOpacities(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableDrawOrders", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableDrawOrders(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableRenderOrders", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableRenderOrders(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableVertexCounts", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableVertexCounts(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableVertexPositions", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableVertexPositions(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableVertexUvs", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableVertexUvs(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableIndexCounts", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableIndexCounts(IntPtr model);
  [DllImport(@"$escapedCore", EntryPoint="csmGetDrawableIndices", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr GetDrawableIndices(IntPtr model);
}
"@

$allocMoc = [Runtime.InteropServices.Marshal]::AllocHGlobal($mocBytes.Length + 63)
$mocAddress = [IntPtr]::new((([long]$allocMoc + 63) -band (-bnot [long]63)))
$allocModel = [IntPtr]::Zero
try {
  [Runtime.InteropServices.Marshal]::Copy($mocBytes, 0, $mocAddress, $mocBytes.Length)
  $mocVersion = [VtsCubismCore]::GetMocVersion($mocAddress, [UInt32]$mocBytes.Length)
  $latestMocVersion = [VtsCubismCore]::GetLatestMocVersion()
  if ($mocVersion -eq 0 -or $mocVersion -gt $latestMocVersion) { throw "MOC3 version $mocVersion is unsupported by this Core (latest $latestMocVersion)." }
  $moc = [VtsCubismCore]::ReviveMocInPlace($mocAddress, [UInt32]$mocBytes.Length)
  if ($moc -eq [IntPtr]::Zero) { throw 'csmReviveMocInPlace rejected the MOC3.' }
  $modelSize = [VtsCubismCore]::GetSizeofModel($moc)
  if ($modelSize -eq 0) { throw 'csmGetSizeofModel returned zero.' }
  $allocModel = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$modelSize + 15)
  $modelAddress = [IntPtr]::new((([long]$allocModel + 15) -band (-bnot [long]15)))
  $model = [VtsCubismCore]::InitializeModelInPlace($moc, $modelAddress, $modelSize)
  if ($model -eq [IntPtr]::Zero) { throw 'csmInitializeModelInPlace rejected the revived MOC.' }
  $parameterCount = [VtsCubismCore]::GetParameterCount($model)
  $drawableCount = [VtsCubismCore]::GetDrawableCount($model)
  if ($parameterCount -lt 0 -or $drawableCount -lt 0) { throw 'Core returned invalid model counts.' }
  [VtsCubismCore]::UpdateModel($model)
  $canvasSizePtr = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
  $canvasOriginPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
  $pixelsPerUnitPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  [VtsCubismCore]::ReadCanvasInfo($model, $canvasSizePtr, $canvasOriginPtr, $pixelsPerUnitPtr)
  $canvas = [pscustomobject]@{
    width=[Runtime.InteropServices.Marshal]::PtrToStructure($canvasSizePtr,[type][single])
    height=[Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($canvasSizePtr,4),[type][single])
    originX=[Runtime.InteropServices.Marshal]::PtrToStructure($canvasOriginPtr,[type][single])
    originY=[Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($canvasOriginPtr,4),[type][single])
    pixelsPerUnit=[Runtime.InteropServices.Marshal]::PtrToStructure($pixelsPerUnitPtr,[type][single])
  }
  $parameterIdsPtr = [VtsCubismCore]::GetParameterIds($model)
  $parameterValuesPtr = [VtsCubismCore]::GetParameterValues($model)
  $drawableIdsPtr = [VtsCubismCore]::GetDrawableIds($model)
  $opacitiesPtr = [VtsCubismCore]::GetDrawableOpacities($model)
  $drawOrdersPtr = [VtsCubismCore]::GetDrawableDrawOrders($model)
  $renderOrdersPtr = [VtsCubismCore]::GetDrawableRenderOrders($model)
  $textureIndicesPtr = [VtsCubismCore]::GetDrawableTextureIndices($model)
  $constantFlagsPtr = [VtsCubismCore]::GetDrawableConstantFlags($model)
  $vertexCountsPtr = [VtsCubismCore]::GetDrawableVertexCounts($model)
  $positionsTable = [VtsCubismCore]::GetDrawableVertexPositions($model)
  $uvTable = [VtsCubismCore]::GetDrawableVertexUvs($model)
  $indexCountsPtr = [VtsCubismCore]::GetDrawableIndexCounts($model)
  $indicesTable = [VtsCubismCore]::GetDrawableIndices($model)
  $ptrSize = [IntPtr]::Size
  $parameterIds = for ($i = 0; $i -lt $parameterCount; $i++) { [Runtime.InteropServices.Marshal]::PtrToStringAnsi([Runtime.InteropServices.Marshal]::ReadIntPtr($parameterIdsPtr, $i * $ptrSize)) }
  $parameters = for ($i = 0; $i -lt $parameterCount; $i++) {
    [pscustomobject]@{ id=$parameterIds[$i]; value=[Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($parameterValuesPtr, $i * 4), [type][single]) }
  }
  $parameterDefaults = @($parameters | ForEach-Object { [single]$_.value })
  $poseDefinitions = if ($PoseInputPath) { Get-Content -Raw -LiteralPath $PoseInputPath | ConvertFrom-Json } else { @([pscustomobject]@{ id='neutral'; parameters=[pscustomobject]@{} }) }
  $poses = foreach ($pose in $poseDefinitions) {
    for ($i = 0; $i -lt $parameterCount; $i++) {
      [Runtime.InteropServices.Marshal]::StructureToPtr($parameterDefaults[$i], [IntPtr]::Add($parameterValuesPtr, $i * 4), $false)
    }
    foreach ($property in $pose.parameters.PSObject.Properties) {
      $index = [array]::IndexOf($parameterIds, [string]$property.Name)
      if ($index -lt 0) { throw "Pose '$($pose.id)' references unknown Core parameter '$($property.Name)'." }
      [Runtime.InteropServices.Marshal]::StructureToPtr([single]$property.Value, [IntPtr]::Add($parameterValuesPtr, $index * 4), $false)
    }
    [VtsCubismCore]::UpdateModel($model)
    $poseParameters = for ($i = 0; $i -lt $parameterCount; $i++) {
      [pscustomobject]@{ id=$parameterIds[$i]; value=[Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($parameterValuesPtr, $i * 4), [type][single]) }
    }
    $drawables = for ($i = 0; $i -lt $drawableCount; $i++) {
      $vertexCount = [Runtime.InteropServices.Marshal]::ReadInt32($vertexCountsPtr, $i * 4)
      $indexCount = [Runtime.InteropServices.Marshal]::ReadInt32($indexCountsPtr, $i * 4)
      $positions = [Runtime.InteropServices.Marshal]::ReadIntPtr($positionsTable, $i * $ptrSize)
      $uvs = [Runtime.InteropServices.Marshal]::ReadIntPtr($uvTable, $i * $ptrSize)
      $indices = [Runtime.InteropServices.Marshal]::ReadIntPtr($indicesTable, $i * $ptrSize)
      $positionValues = [single[]]::new($vertexCount * 2)
      $uvValues = [single[]]::new($vertexCount * 2)
      $indexValues = [UInt16[]]::new($indexCount)
      [Runtime.InteropServices.Marshal]::Copy($positions, $positionValues, 0, $positionValues.Length)
      [Runtime.InteropServices.Marshal]::Copy($uvs, $uvValues, 0, $uvValues.Length)
      for ($j = 0; $j -lt $indexCount; $j++) { $indexValues[$j] = [Runtime.InteropServices.Marshal]::ReadInt16($indices, $j * 2) -band 0xffff }
      [pscustomobject]@{
        id=[Runtime.InteropServices.Marshal]::PtrToStringAnsi([Runtime.InteropServices.Marshal]::ReadIntPtr($drawableIdsPtr, $i * $ptrSize))
        opacity=[Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]::Add($opacitiesPtr, $i * 4), [type][single])
        order=[Runtime.InteropServices.Marshal]::ReadInt32($drawOrdersPtr, $i * 4)
        drawOrder=[Runtime.InteropServices.Marshal]::ReadInt32($drawOrdersPtr, $i * 4)
        renderOrder=[Runtime.InteropServices.Marshal]::ReadInt32($renderOrdersPtr, $i * 4)
        textureIndex=[Runtime.InteropServices.Marshal]::ReadInt32($textureIndicesPtr, $i * 4)
        constantFlags=[Runtime.InteropServices.Marshal]::ReadByte($constantFlagsPtr, $i)
        vertexCount=$vertexCount; indexCount=$indexCount
        positions=$positionValues; uvs=$uvValues; indices=$indexValues
      }
    }
    [pscustomobject]@{ id=$pose.id; parameters=$pose.parameters; coreParameters=@($poseParameters); layers=@($drawables) }
  }
  $result = [ordered]@{
    status='loaded'; corePath=$CorePath; coreVersion=[VtsCubismCore]::GetVersion(); latestMocVersion=$latestMocVersion; mocVersion=$mocVersion
    mocPath=$MocPath; mocBytes=$mocBytes.Length; mocSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($mocBytes)).ToLowerInvariant(); mocHeader=[Text.Encoding]::ASCII.GetString($mocBytes,0,4)
    modelBytes=$modelSize; canvas=$canvas; parameterCount=$parameterCount; parameters=@($parameters); drawableCount=$drawableCount; poses=@($poses)
    contentTest='Core revived MOC, instantiated model, applied requested parameter values, updated it, and read drawable opacity, positions, UVs and indices.'
  }
  $json = $result | ConvertTo-Json -Depth 8
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
  [IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false))
  ([pscustomobject]$result) | Select-Object status,coreVersion,latestMocVersion,mocVersion,mocPath,mocBytes,parameterCount,drawableCount,@{n='poseCount';e={$_.poses.Count}},contentTest | ConvertTo-Json
} finally {
  if ($canvasSizePtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($canvasSizePtr) }
  if ($canvasOriginPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($canvasOriginPtr) }
  if ($pixelsPerUnitPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($pixelsPerUnitPtr) }
  if ($allocModel -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($allocModel) }
  if ($allocMoc -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($allocMoc) }
}
