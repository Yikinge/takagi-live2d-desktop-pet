export const MODEL_ROOT_PATH = '/models/takagi/'
export const CUBISM_CORE_PATH = '/live2d/live2dcubismcore.js'

export type ModelDiagnosticSeverity = 'error' | 'warning'

export type ModelDiagnosticCode =
  | 'core-missing'
  | 'core-invalid'
  | 'model-path-forbidden'
  | 'model3-missing'
  | 'model3-invalid'
  | 'moc3-missing'
  | 'moc3-invalid'
  | 'texture-missing'
  | 'texture-invalid'
  | 'physics-missing'
  | 'motion-missing'
  | 'motion-file-missing'
  | 'expression-missing'
  | 'expression-file-missing'
  | 'optional-asset-missing'
  | 'remote-resource-blocked'
  | 'parameter-name-mismatch'
  | 'parameter-range-mismatch'
  | 'motion-name-mismatch'
  | 'expression-name-mismatch'
  | 'renderer-failed'
  | 'model-ready-timeout'
  | 'model-initialization-failed'

export interface ModelDiagnostic {
  code: ModelDiagnosticCode
  severity: ModelDiagnosticSeverity
  message: string
  blocking: boolean
  asset?: string
  expected?: string[]
  actual?: string[]
}

type ContractAssetKind =
  | 'moc3'
  | 'texture'
  | 'physics'
  | 'motion'
  | 'expression'
  | 'pose'
  | 'user-data'
  | 'display-info'
  | 'sound'

export interface ModelContractAsset {
  kind: ContractAssetKind
  reference: string
  url: string
}

export interface ModelContract {
  modelUrl: string
  modelDirectoryUrl: string
  modelJson: Record<string, unknown>
  assets: ModelContractAsset[]
  motionGroups: string[]
  expressionNames: string[]
}

export interface ModelContractResult {
  contract?: ModelContract
  diagnostics: ModelDiagnostic[]
}

interface Model3Expression {
  Name?: unknown
  File?: unknown
}

interface Model3Motion {
  File?: unknown
  Sound?: unknown
}

interface Model3FileReferences {
  Moc?: unknown
  Textures?: unknown
  Physics?: unknown
  Pose?: unknown
  UserData?: unknown
  DisplayInfo?: unknown
  Expressions?: unknown
  Motions?: unknown
}

const JSON_ASSET_KINDS = new Set<ContractAssetKind>([
  'physics',
  'motion',
  'expression',
  'pose',
  'user-data',
  'display-info',
])

const MAX_REFERENCED_ASSETS = 256

export function isBlockingDiagnostic(diagnostic: ModelDiagnostic): boolean {
  return diagnostic.blocking
}

export function primaryDiagnosticStatus(diagnostics: ModelDiagnostic[]): string {
  const priority: ModelDiagnosticCode[] = [
    'model-path-forbidden',
    'model3-missing',
    'model3-invalid',
    'core-missing',
    'core-invalid',
    'moc3-missing',
    'moc3-invalid',
    'texture-missing',
    'texture-invalid',
    'physics-missing',
    'motion-file-missing',
    'expression-file-missing',
    'remote-resource-blocked',
    'model-ready-timeout',
    'model-initialization-failed',
    'renderer-failed',
  ]
  const blocking = diagnostics.filter(isBlockingDiagnostic)
  const primary = priority
    .map(code => blocking.find(item => item.code === code))
    .find(Boolean)
    ?? blocking[0]
    ?? diagnostics[0]
  return primary?.message ?? '使用预览角色'
}

export function resolveLocalModelUrl(
  reference: string,
  baseHref = window.location.href,
): URL {
  return resolveRestrictedUrl(reference, new URL(baseHref), '模型路径')
}

export function resolveLocalModelAssetUrl(
  reference: string,
  modelUrl: string,
): URL {
  if (hasTraversalSegment(reference)) {
    throw new Error(`资源路径包含不允许的目录跳转：${reference}`)
  }
  return resolveRestrictedUrl(reference, new URL(modelUrl), '模型资源')
}

export async function probeCubismCore(
  signal?: AbortSignal,
): Promise<ModelDiagnostic | undefined> {
  const coreUrl = new URL(CUBISM_CORE_PATH, window.location.href)
  try {
    const response = await fetch(coreUrl.href, {
      cache: 'no-store',
      signal,
    })
    if (!response.ok) {
      return diagnostic(
        'core-missing',
        'error',
        '缺少 Live2D Cubism Core',
        true,
        CUBISM_CORE_PATH,
      )
    }
    const source = await response.text()
    if (!source.trim() || /<!doctype\s+html/i.test(source)) {
      return diagnostic(
        'core-invalid',
        'error',
        'Live2D Cubism Core 文件无效',
        true,
        CUBISM_CORE_PATH,
      )
    }
    return undefined
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    return diagnostic(
      'core-missing',
      'error',
      '缺少 Live2D Cubism Core',
      true,
      CUBISM_CORE_PATH,
    )
  }
}

export async function preflightModelContract(
  modelPath: string,
  expectedMotions: readonly string[],
  expectedExpressions: readonly string[],
  signal?: AbortSignal,
): Promise<ModelContractResult> {
  const diagnostics: ModelDiagnostic[] = []
  let modelUrl: URL

  try {
    modelUrl = resolveLocalModelUrl(modelPath)
  } catch (reason) {
    diagnostics.push(diagnostic(
      'model-path-forbidden',
      'error',
      reason instanceof Error ? reason.message : '模型路径不允许',
      true,
      modelPath,
    ))
    return { diagnostics }
  }

  if (!modelUrl.pathname.endsWith('.model3.json')) {
    diagnostics.push(diagnostic(
      'model3-invalid',
      'error',
      '模型入口必须是 .model3.json',
      true,
      modelUrl.pathname,
    ))
    return { diagnostics }
  }

  let response: Response
  try {
    response = await fetch(modelUrl.href, {
      cache: 'no-store',
      signal,
    })
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    diagnostics.push(diagnostic(
      'model3-missing',
      'error',
      '缺少 Takagi.model3.json',
      true,
      modelUrl.pathname,
    ))
    return { diagnostics }
  }

  if (!response.ok) {
    diagnostics.push(diagnostic(
      'model3-missing',
      'error',
      '缺少 Takagi.model3.json',
      true,
      modelUrl.pathname,
    ))
    return { diagnostics }
  }

  let modelJson: Record<string, unknown>
  try {
    const value = await response.json() as unknown
    if (!isRecord(value)) throw new TypeError('model3 根节点不是对象')
    modelJson = value
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    diagnostics.push(diagnostic(
      'model3-invalid',
      'error',
      'Takagi.model3.json 无法解析',
      true,
      modelUrl.pathname,
    ))
    return { diagnostics }
  }

  const fileReferences = modelJson.FileReferences
  if (!isRecord(fileReferences)) {
    diagnostics.push(diagnostic(
      'model3-invalid',
      'error',
      'model3 缺少 FileReferences',
      true,
      modelUrl.pathname,
    ))
    return { diagnostics }
  }

  const references = fileReferences as Model3FileReferences
  const assets: ModelContractAsset[] = []
  const modelDirectoryUrl = new URL('./', modelUrl)

  const addAsset = (
    kind: ContractAssetKind,
    rawReference: unknown,
    required = false,
  ) => {
    if (typeof rawReference !== 'string' || !rawReference.trim()) {
      if (required) {
        diagnostics.push(missingAssetDiagnostic({
          kind,
          reference: `(invalid ${kind} reference)`,
          url: '',
        }))
      }
      return
    }
    try {
      const url = resolveLocalModelAssetUrl(rawReference, modelDirectoryUrl.href)
      assets.push({ kind, reference: rawReference, url: url.href })
    } catch (reason) {
      diagnostics.push(diagnostic(
        'remote-resource-blocked',
        'error',
        reason instanceof Error ? reason.message : '模型包含不允许的资源 URL',
        true,
        rawReference,
      ))
    }
  }

  if (typeof references.Moc !== 'string' || !references.Moc) {
    diagnostics.push(diagnostic(
      'moc3-missing',
      'error',
      'model3 未声明 moc3',
      true,
    ))
  } else {
    addAsset('moc3', references.Moc, true)
  }

  if (!Array.isArray(references.Textures) || references.Textures.length === 0) {
    diagnostics.push(diagnostic(
      'texture-missing',
      'error',
      'model3 未声明纹理',
      true,
    ))
  } else {
    references.Textures.forEach(texture => addAsset('texture', texture, true))
  }

  if (references.Physics === undefined || references.Physics === '') {
    diagnostics.push(diagnostic(
      'physics-missing',
      'warning',
      '模型未包含 physics3',
      false,
    ))
  } else {
    addAsset('physics', references.Physics, true)
  }
  if (references.Pose !== undefined && references.Pose !== '') {
    addAsset('pose', references.Pose, true)
  }
  if (references.UserData !== undefined && references.UserData !== '') {
    addAsset('user-data', references.UserData, true)
  }
  if (
    references.DisplayInfo !== undefined
    && references.DisplayInfo !== ''
  ) {
    addAsset('display-info', references.DisplayInfo, true)
  }

  const expressionNames: string[] = []
  if (Array.isArray(references.Expressions) && references.Expressions.length > 0) {
    for (const expression of references.Expressions as Model3Expression[]) {
      if (!isRecord(expression)) {
        diagnostics.push(diagnostic(
          'model3-invalid',
          'error',
          'model3 包含无效的表情声明',
          true,
        ))
        continue
      }
      if (typeof expression.Name === 'string' && expression.Name) {
        expressionNames.push(expression.Name)
      } else {
        diagnostics.push(diagnostic(
          'expression-name-mismatch',
          'error',
          '表情声明缺少名称',
          true,
        ))
      }
      addAsset('expression', expression.File, true)
    }
  } else {
    diagnostics.push(diagnostic(
      'expression-missing',
      'warning',
      '模型未包含表情文件',
      false,
    ))
  }

  const motionGroups: string[] = []
  if (isRecord(references.Motions) && Object.keys(references.Motions).length > 0) {
    for (const [group, groupMotions] of Object.entries(references.Motions)) {
      motionGroups.push(group)
      if (!Array.isArray(groupMotions)) {
        diagnostics.push(diagnostic(
          'model3-invalid',
          'error',
          `动作组 ${group} 不是数组`,
          true,
        ))
        continue
      }
      for (const motion of groupMotions as Model3Motion[]) {
        if (!isRecord(motion)) {
          diagnostics.push(diagnostic(
            'model3-invalid',
            'error',
            `动作组 ${group} 包含无效声明`,
            true,
          ))
          continue
        }
        addAsset('motion', motion.File, true)
        if (motion.Sound !== undefined) addAsset('sound', motion.Sound)
      }
    }
  } else {
    diagnostics.push(diagnostic(
      'motion-missing',
      'warning',
      '模型未包含动作文件',
      false,
    ))
  }

  const missingMotions = expectedMotions.filter(name => !motionGroups.includes(name))
  if (missingMotions.length) {
    diagnostics.push({
      ...diagnostic(
        'motion-name-mismatch',
        'warning',
        `动作名称不匹配：${missingMotions.join('、')}`,
        false,
      ),
      expected: [...expectedMotions],
      actual: motionGroups,
    })
  }

  const missingExpressions = expectedExpressions
    .filter(name => !expressionNames.includes(name))
  if (missingExpressions.length) {
    diagnostics.push({
      ...diagnostic(
        'expression-name-mismatch',
        'warning',
        `表情名称不匹配：${missingExpressions.join('、')}`,
        false,
      ),
      expected: [...expectedExpressions],
      actual: expressionNames,
    })
  }

  if (assets.length > MAX_REFERENCED_ASSETS) {
    diagnostics.push(diagnostic(
      'model3-invalid',
      'error',
      `模型引用资源过多（最多 ${MAX_REFERENCED_ASSETS} 个）`,
      true,
      modelUrl.pathname,
    ))
  } else {
    const probeResults = await Promise.all(
      assets.map(asset => probeContractAsset(asset, signal)),
    )
    diagnostics.push(...probeResults.filter(
      (item): item is ModelDiagnostic => Boolean(item),
    ))
  }

  return {
    diagnostics,
    contract: {
      modelUrl: modelUrl.href,
      modelDirectoryUrl: modelDirectoryUrl.href,
      modelJson,
      assets,
      motionGroups,
      expressionNames,
    },
  }
}

async function probeContractAsset(
  asset: ModelContractAsset,
  signal?: AbortSignal,
): Promise<ModelDiagnostic | undefined> {
  try {
    const response = await fetch(asset.url, {
      cache: 'no-store',
      signal,
    })
    if (!response.ok) return missingAssetDiagnostic(asset)

    if (asset.kind === 'sound') {
      await response.body?.cancel()
      return undefined
    }

    if (JSON_ASSET_KINDS.has(asset.kind)) {
      try {
        await response.json()
      } catch {
        return invalidAssetDiagnostic(asset)
      }
      return undefined
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) return invalidAssetDiagnostic(asset)
    if (
      asset.kind === 'texture'
      && !isPng(bytes)
    ) {
      return invalidAssetDiagnostic(asset)
    }
    if (
      asset.kind === 'moc3'
      && !asset.reference.toLowerCase().endsWith('.moc3')
    ) {
      return invalidAssetDiagnostic(asset)
    }
    return undefined
  } catch (reason) {
    if (isAbortError(reason)) throw reason
    return missingAssetDiagnostic(asset)
  }
}

function missingAssetDiagnostic(asset: ModelContractAsset): ModelDiagnostic {
  if (asset.kind === 'moc3') {
    return diagnostic('moc3-missing', 'error', '缺少 moc3', true, asset.reference)
  }
  if (asset.kind === 'texture') {
    return diagnostic('texture-missing', 'error', '缺少模型纹理', true, asset.reference)
  }
  if (asset.kind === 'physics') {
    return diagnostic('physics-missing', 'error', '缺少 physics3', true, asset.reference)
  }
  if (asset.kind === 'motion') {
    return diagnostic(
      'motion-file-missing',
      'error',
      '缺少动作文件',
      true,
      asset.reference,
    )
  }
  if (asset.kind === 'expression') {
    return diagnostic(
      'expression-file-missing',
      'error',
      '缺少表情文件',
      true,
      asset.reference,
    )
  }
  return diagnostic(
    'optional-asset-missing',
    asset.kind === 'sound' ? 'warning' : 'error',
    `缺少可选模型资源：${asset.reference}`,
    asset.kind !== 'sound',
    asset.reference,
  )
}

function invalidAssetDiagnostic(asset: ModelContractAsset): ModelDiagnostic {
  if (asset.kind === 'moc3') {
    return diagnostic('moc3-invalid', 'error', 'moc3 文件无效', true, asset.reference)
  }
  if (asset.kind === 'texture') {
    return diagnostic(
      'texture-invalid',
      'error',
      '模型纹理不是有效 PNG',
      true,
      asset.reference,
    )
  }
  return missingAssetDiagnostic(asset)
}

function resolveRestrictedUrl(reference: string, base: URL, label: string): URL {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error(`${label}为空`)
  }
  if (reference !== reference.trim() || reference.includes('\\')) {
    throw new Error(`${label}包含不允许的字符`)
  }
  if (hasTraversalSegment(reference)) {
    throw new Error(`${label}包含不允许的目录跳转`)
  }

  let resolved: URL
  try {
    resolved = new URL(reference, base)
  } catch {
    throw new Error(`${label}无效`)
  }

  if (
    resolved.protocol !== base.protocol
    || resolved.host !== base.host
    || resolved.username
    || resolved.password
  ) {
    throw new Error(`${label}必须与应用同源，禁止远程 URL`)
  }
  if (resolved.search || resolved.hash) {
    throw new Error(`${label}不允许 query 或 hash`)
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(resolved.pathname)
  } catch {
    throw new Error(`${label}包含无效转义`)
  }
  if (
    !resolved.pathname.startsWith(MODEL_ROOT_PATH)
    || !decodedPath.startsWith(MODEL_ROOT_PATH)
    || decodedPath.includes('\\')
  ) {
    throw new Error(`${label}必须位于 ${MODEL_ROOT_PATH}`)
  }
  return resolved
}

function hasTraversalSegment(reference: string): boolean {
  let decoded = reference
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    return true
  }
  return decoded
    .replaceAll('\\', '/')
    .split('/')
    .some(segment => segment === '.' || segment === '..')
}

function diagnostic(
  code: ModelDiagnosticCode,
  severity: ModelDiagnosticSeverity,
  message: string,
  blocking: boolean,
  asset?: string,
): ModelDiagnostic {
  return {
    code,
    severity,
    message,
    blocking,
    ...(asset ? { asset } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  return bytes.length >= signature.length
    && signature.every((value, index) => bytes[index] === value)
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}
