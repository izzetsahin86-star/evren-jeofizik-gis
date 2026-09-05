export type DesMeasurementLite = {
  ab2: number
  mn: number
  rho: number
}

export type ObservedPoint = {
  ab2: number
  rho: number
  count: number
}

export type DesLayerModel = {
  id: string
  rho: number
  thickness: number | null
  interpretation: string
}

export type DesFitResult = {
  layers: DesLayerModel[]
  response: number[]
  rms: number
  curveType: string
  iterations: number
  method: string
}

const FILTER_INDEX = [-3, -2, -1, 0, 1, 2, 3, 4, 5]
const FILTER_COEFFICIENTS = [0.0225, -0.0499, 0.1064, 0.1854, 1.9720, -1.5716, 0.4018, -0.0814, 0.0148]
const FILTER_STEP = Math.log(10) / 8

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function geometricMean(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0)
  if (!valid.length) return 1
  return Math.exp(valid.reduce((sum, value) => sum + Math.log(value), 0) / valid.length)
}

export function prepareObserved(measurements: DesMeasurementLite[]): ObservedPoint[] {
  const groups = new Map<number, number[]>()
  measurements.forEach((item) => {
    if (!Number.isFinite(item.ab2) || item.ab2 <= 0 || !Number.isFinite(item.rho) || item.rho <= 0) return
    groups.set(item.ab2, [...(groups.get(item.ab2) || []), item.rho])
  })
  return Array.from(groups.entries())
    .map(([ab2, values]) => ({ ab2, rho: geometricMean(values), count: values.length }))
    .sort((a, b) => a.ab2 - b.ab2)
}

function transformAt(lambda: number, layers: DesLayerModel[]) {
  let transform = Math.max(0.001, layers[layers.length - 1]?.rho || 1)
  for (let index = layers.length - 2; index >= 0; index -= 1) {
    const rho = Math.max(0.001, layers[index].rho)
    const thickness = Math.max(0.001, layers[index].thickness || 0.001)
    const tanh = Math.tanh(lambda * thickness)
    const denominator = rho + transform * tanh
    transform = denominator !== 0
      ? rho * (transform + rho * tanh) / denominator
      : rho
  }
  return Math.max(0.001, transform)
}

export function forwardAt(ab2: number, layers: DesLayerModel[]) {
  if (!layers.length || !Number.isFinite(ab2) || ab2 <= 0) return 1
  let sum = 0
  for (let index = 0; index < FILTER_COEFFICIENTS.length; index += 1) {
    const sampleIndex = FILTER_INDEX[index]
    const lambda = 1 / (ab2 * Math.exp(sampleIndex * FILTER_STEP))
    sum += FILTER_COEFFICIENTS[index] * transformAt(lambda, layers)
  }
  return Math.max(0.001, sum)
}

export function responseFor(observed: ObservedPoint[], layers: DesLayerModel[]) {
  return observed.map((point) => forwardAt(point.ab2, layers))
}

export function logRms(observed: ObservedPoint[], response: number[]) {
  if (!observed.length || response.length !== observed.length) return Number.POSITIVE_INFINITY
  const sum = observed.reduce((acc, point, index) => {
    const predicted = Math.max(0.001, response[index])
    return acc + Math.log(predicted / point.rho) ** 2
  }, 0)
  return Math.sqrt(sum / observed.length) * 100
}

function letterFor(a: number, b: number, c: number) {
  if (a < b && b < c) return 'A'
  if (a > b && b > c) return 'Q'
  if (a > b && b < c) return 'H'
  if (a < b && b > c) return 'K'
  return '–'
}

export function curveTypeFromLayers(layers: DesLayerModel[]) {
  if (layers.length < 3) return '–'
  const letters: string[] = []
  for (let index = 0; index <= layers.length - 3; index += 1) {
    letters.push(letterFor(layers[index].rho, layers[index + 1].rho, layers[index + 2].rho))
  }
  return letters.join('') || '–'
}

function cumulativeDepths(layerCount: number, minAb2: number, maxAb2: number) {
  const finiteCount = Math.max(1, layerCount - 1)
  const first = Math.max(1.5, minAb2 * 0.12)
  const last = Math.max(first * 2, maxAb2 * 0.7)
  if (finiteCount === 1) return [last]
  return Array.from({ length: finiteCount }, (_, index) => {
    const t = index / (finiteCount - 1)
    return first * (last / first) ** t
  })
}

export function createInitialLayers(observed: ObservedPoint[], layerCount: number): DesLayerModel[] {
  const count = clamp(Math.round(layerCount), 3, 6)
  if (!observed.length) {
    return Array.from({ length: count }, (_, index) => ({
      id: `layer-${index + 1}`,
      rho: 100,
      thickness: index === count - 1 ? null : 20 * (index + 1),
      interpretation: '',
    }))
  }
  const minAb2 = observed[0].ab2
  const maxAb2 = observed[observed.length - 1].ab2
  const depths = cumulativeDepths(count, minAb2, maxAb2)
  let previousDepth = 0
  return Array.from({ length: count }, (_, index) => {
    const q = count === 1 ? 0 : index / (count - 1)
    const pointIndex = Math.min(observed.length - 1, Math.round(q * (observed.length - 1)))
    const bottom = index < count - 1 ? depths[index] : null
    const thickness = bottom === null ? null : Math.max(0.5, bottom - previousDepth)
    if (bottom !== null) previousDepth = bottom
    return {
      id: `layer-${index + 1}`,
      rho: Math.max(0.2, observed[pointIndex].rho),
      thickness,
      interpretation: '',
    }
  })
}

function layersToParameters(layers: DesLayerModel[]) {
  const rhos = layers.map((layer) => Math.log(Math.max(0.2, layer.rho)))
  const thicknesses = layers.slice(0, -1).map((layer) => Math.log(Math.max(0.5, layer.thickness || 0.5)))
  return [...rhos, ...thicknesses]
}

function parametersToLayers(parameters: number[], layerCount: number, interpretations: string[] = []) {
  return Array.from({ length: layerCount }, (_, index) => ({
    id: `layer-${index + 1}`,
    rho: Math.exp(parameters[index]),
    thickness: index === layerCount - 1 ? null : Math.exp(parameters[layerCount + index]),
    interpretation: interpretations[index] || '',
  }))
}

function objective(observed: ObservedPoint[], layers: DesLayerModel[]) {
  return logRms(observed, responseFor(observed, layers))
}

export function fitLayerModel(
  observed: ObservedPoint[],
  layerCount: number,
  startLayers?: DesLayerModel[],
): DesFitResult {
  const count = clamp(Math.round(layerCount), 3, 6)
  const base = startLayers && startLayers.length === count ? startLayers : createInitialLayers(observed, count)
  const interpretations = base.map((layer) => layer.interpretation)
  const minRho = Math.max(0.05, Math.min(...observed.map((point) => point.rho), 1) / 30)
  const maxRho = Math.min(1_000_000, Math.max(...observed.map((point) => point.rho), 100) * 50)
  const maxAb2 = Math.max(...observed.map((point) => point.ab2), 100)
  const lower = [
    ...Array.from({ length: count }, () => Math.log(minRho)),
    ...Array.from({ length: count - 1 }, () => Math.log(0.5)),
  ]
  const upper = [
    ...Array.from({ length: count }, () => Math.log(maxRho)),
    ...Array.from({ length: count - 1 }, () => Math.log(maxAb2 * 3)),
  ]

  let globalBest = layersToParameters(base)
  let globalScore = objective(observed, base)
  let totalIterations = 0

  for (let restart = 0; restart < 3; restart += 1) {
    let parameters = layersToParameters(base).map((value, index) => {
      if (restart === 0) return value
      const phase = Math.sin((index + 1) * (restart + 0.7))
      return clamp(value + phase * 0.45 * restart, lower[index], upper[index])
    })
    let best = objective(observed, parametersToLayers(parameters, count, interpretations))
    let step = 0.85

    for (let pass = 0; pass < 24; pass += 1) {
      let improved = false
      for (let index = 0; index < parameters.length; index += 1) {
        totalIterations += 1
        const baseValue = parameters[index]
        let bestValue = baseValue
        let localBest = best
        for (const direction of [-1, 1]) {
          const candidate = [...parameters]
          candidate[index] = clamp(baseValue + direction * step, lower[index], upper[index])
          const layers = parametersToLayers(candidate, count, interpretations)
          const score = objective(observed, layers)
          if (score < localBest) {
            localBest = score
            bestValue = candidate[index]
          }
        }
        if (localBest < best) {
          parameters[index] = bestValue
          best = localBest
          improved = true
        }
      }
      step *= improved ? 0.82 : 0.58
      if (step < 0.018) break
    }

    if (best < globalScore) {
      globalScore = best
      globalBest = parameters
    }
  }

  const layers = parametersToLayers(globalBest, count, interpretations)
  const response = responseFor(observed, layers)
  return {
    layers,
    response,
    rms: logRms(observed, response),
    curveType: curveTypeFromLayers(layers),
    iterations: totalIterations,
    method: 'Schlumberger · 1B katmanlı yer · 9 noktalı dijital filtre · log-uzay otomatik uyum',
  }
}

export function fitTone(rms: number) {
  if (!Number.isFinite(rms)) return { label: 'Model yok', tone: 'neutral' }
  if (rms <= 8) return { label: 'Yüksek uyum', tone: 'good' }
  if (rms <= 16) return { label: 'Orta uyum', tone: 'warning' }
  return { label: 'Gözden geçir', tone: 'danger' }
}
