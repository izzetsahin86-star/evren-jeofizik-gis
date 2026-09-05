import {
  createInitialLayers,
  curveTypeFromLayers,
  fitLayerModel,
  logRms,
  responseFor,
  type DesFitResult,
  type DesLayerModel,
  type ObservedPoint,
} from './DESProfessionalEngine'

export type DualLayerResult = {
  layerCount: number
  motorA: DesFitResult
  motorB: DesFitResult
  consensusLayers: DesLayerModel[]
  consensusResponse: number[]
  consensusRms: number
  consensusCurveType: string
  rhoDifferencePct: number
  thicknessDifferencePct: number
  curveDifferencePct: number
  consistency: number
  bicA: number
  bicB: number
  meanBic: number
  selectionScore: number
  overfitPenalty: number
}

export type DualAnalysisResult = {
  results: DualLayerResult[]
  recommended: DualLayerResult
  confidence: 'high' | 'medium' | 'low'
  confidenceLabel: string
  generatedAt: number
  methodNote: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function hashObserved(observed: ObservedPoint[], salt = 0) {
  let hash = (2166136261 ^ salt) >>> 0
  observed.forEach((point) => {
    const parts = [Math.round(point.ab2 * 1000), Math.round(point.rho * 1000), point.count]
    parts.forEach((part) => {
      hash ^= part >>> 0
      hash = Math.imul(hash, 16777619) >>> 0
    })
  })
  return hash || 1
}

function randomGenerator(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function layersToParameters(layers: DesLayerModel[]) {
  return [
    ...layers.map((layer) => Math.log(Math.max(0.2, layer.rho))),
    ...layers.slice(0, -1).map((layer) => Math.log(Math.max(0.5, layer.thickness || 0.5))),
  ]
}

function parametersToLayers(parameters: number[], layerCount: number) {
  return Array.from({ length: layerCount }, (_, index) => ({
    id: `layer-${index + 1}`,
    rho: Math.exp(parameters[index]),
    thickness: index === layerCount - 1 ? null : Math.exp(parameters[layerCount + index]),
    interpretation: '',
  }))
}

function parameterBounds(observed: ObservedPoint[], layerCount: number) {
  const minObserved = Math.min(...observed.map((point) => point.rho), 1)
  const maxObserved = Math.max(...observed.map((point) => point.rho), 100)
  const maxAb2 = Math.max(...observed.map((point) => point.ab2), 100)
  const minRho = Math.max(0.05, minObserved / 40)
  const maxRho = Math.min(1_000_000, maxObserved * 80)
  return {
    lower: [
      ...Array.from({ length: layerCount }, () => Math.log(minRho)),
      ...Array.from({ length: layerCount - 1 }, () => Math.log(0.5)),
    ],
    upper: [
      ...Array.from({ length: layerCount }, () => Math.log(maxRho)),
      ...Array.from({ length: layerCount - 1 }, () => Math.log(maxAb2 * 3)),
    ],
  }
}

function scoreParameters(observed: ObservedPoint[], parameters: number[], layerCount: number) {
  const layers = parametersToLayers(parameters, layerCount)
  return logRms(observed, responseFor(observed, layers))
}

function sampleDifferentIndices(random: () => number, size: number, excluded: number) {
  const picked: number[] = []
  while (picked.length < 3) {
    const candidate = Math.floor(random() * size)
    if (candidate === excluded || picked.includes(candidate)) continue
    picked.push(candidate)
  }
  return picked
}

export function fitLayerModelGlobal(observed: ObservedPoint[], layerCount: number): DesFitResult {
  const count = clamp(Math.round(layerCount), 3, 6)
  const base = createInitialLayers(observed, count)
  const baseParameters = layersToParameters(base)
  const { lower, upper } = parameterBounds(observed, count)
  const random = randomGenerator(hashObserved(observed, count * 7919))
  const parameterCount = baseParameters.length
  const populationSize = Math.max(18, parameterCount * 3)
  const generations = 22
  const mutationFactor = 0.72
  const crossoverRate = 0.86

  const population: number[][] = Array.from({ length: populationSize }, (_, memberIndex) => {
    if (memberIndex === 0) return [...baseParameters]
    return baseParameters.map((baseValue, index) => {
      const span = upper[index] - lower[index]
      if (memberIndex < Math.min(6, populationSize)) {
        const jitter = (random() - 0.5) * span * 0.36
        return clamp(baseValue + jitter, lower[index], upper[index])
      }
      return lower[index] + random() * span
    })
  })

  const scores = population.map((parameters) => scoreParameters(observed, parameters, count))
  let evaluations = populationSize

  for (let generation = 0; generation < generations; generation += 1) {
    for (let memberIndex = 0; memberIndex < populationSize; memberIndex += 1) {
      const [aIndex, bIndex, cIndex] = sampleDifferentIndices(random, populationSize, memberIndex)
      const forcedIndex = Math.floor(random() * parameterCount)
      const trial = population[memberIndex].map((value, parameterIndex) => {
        if (random() > crossoverRate && parameterIndex !== forcedIndex) return value
        const mutant = population[aIndex][parameterIndex]
          + mutationFactor * (population[bIndex][parameterIndex] - population[cIndex][parameterIndex])
        return clamp(mutant, lower[parameterIndex], upper[parameterIndex])
      })
      const trialScore = scoreParameters(observed, trial, count)
      evaluations += 1
      if (trialScore < scores[memberIndex]) {
        population[memberIndex] = trial
        scores[memberIndex] = trialScore
      }
    }
  }

  let bestIndex = 0
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] < scores[bestIndex]) bestIndex = index
  }

  const layers = parametersToLayers(population[bestIndex], count)
  const response = responseFor(observed, layers)
  return {
    layers,
    response,
    rms: logRms(observed, response),
    curveType: curveTypeFromLayers(layers),
    iterations: evaluations,
    method: 'Motor B · Differential Evolution · çok başlangıçlı global log-parametre araması · aynı Schlumberger 1B ileri çözüm',
  }
}

function symmetricDifferencePct(a: number, b: number) {
  const denominator = (Math.abs(a) + Math.abs(b)) / 2
  if (denominator <= 1e-12) return 0
  return Math.abs(a - b) / denominator * 100
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function parameterDifferences(a: DesLayerModel[], b: DesLayerModel[]) {
  const rhoDifferencePct = mean(a.map((layer, index) => symmetricDifferencePct(layer.rho, b[index]?.rho ?? layer.rho)))
  const thicknessPairs = a.slice(0, -1).map((layer, index) => [layer.thickness || 0, b[index]?.thickness || 0] as const)
  const thicknessDifferencePct = mean(thicknessPairs.map(([left, right]) => symmetricDifferencePct(left, right)))
  return { rhoDifferencePct, thicknessDifferencePct }
}

function responseDifferencePct(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 100
  const sum = a.reduce((acc, value, index) => {
    const left = Math.max(0.001, value)
    const right = Math.max(0.001, b[index])
    return acc + Math.log(left / right) ** 2
  }, 0)
  return Math.sqrt(sum / a.length) * 100
}

function bicScore(observed: ObservedPoint[], response: number[], parameterCount: number) {
  const n = observed.length
  if (!n || response.length !== n) return Number.POSITIVE_INFINITY
  const sse = observed.reduce((sum, point, index) => {
    const predicted = Math.max(0.001, response[index])
    const residual = Math.log(predicted / point.rho)
    return sum + residual * residual
  }, 0)
  const mse = Math.max(1e-12, sse / n)
  return n * Math.log(mse) + parameterCount * Math.log(Math.max(2, n))
}

function consensusLayers(a: DesLayerModel[], b: DesLayerModel[]) {
  return a.map((layer, index) => {
    const other = b[index] || layer
    return {
      id: `layer-${index + 1}`,
      rho: Math.sqrt(Math.max(0.001, layer.rho) * Math.max(0.001, other.rho)),
      thickness: layer.thickness === null || other.thickness === null
        ? null
        : Math.sqrt(Math.max(0.001, layer.thickness) * Math.max(0.001, other.thickness)),
      interpretation: '',
    }
  })
}

export function runDualLayerCount(observed: ObservedPoint[], layerCount: number): DualLayerResult {
  const count = clamp(Math.round(layerCount), 3, 6)
  const motorA = fitLayerModel(observed, count)
  const motorB = fitLayerModelGlobal(observed, count)
  const consensus = consensusLayers(motorA.layers, motorB.layers)
  const consensusResponse = responseFor(observed, consensus)
  const consensusRms = logRms(observed, consensusResponse)
  const { rhoDifferencePct, thicknessDifferencePct } = parameterDifferences(motorA.layers, motorB.layers)
  const curveDifferencePct = responseDifferencePct(motorA.response, motorB.response)
  const curveAgreement = clamp(100 - curveDifferencePct * 2, 0, 100)
  const parameterAgreement = clamp(100 - rhoDifferencePct * 0.32 - thicknessDifferencePct * 0.28, 0, 100)
  const consistency = clamp(curveAgreement * 0.62 + parameterAgreement * 0.38, 0, 100)
  const parameterCount = count * 2 - 1
  const bicA = bicScore(observed, motorA.response, parameterCount)
  const bicB = bicScore(observed, motorB.response, parameterCount)
  const meanBic = (bicA + bicB) / 2
  const overfitPenalty = Math.max(0, parameterCount + 2 - observed.length) * 12
  const selectionScore = meanBic + (100 - consistency) * 0.08 + overfitPenalty

  return {
    layerCount: count,
    motorA,
    motorB,
    consensusLayers: consensus,
    consensusResponse,
    consensusRms,
    consensusCurveType: curveTypeFromLayers(consensus),
    rhoDifferencePct,
    thicknessDifferencePct,
    curveDifferencePct,
    consistency,
    bicA,
    bicB,
    meanBic,
    selectionScore,
    overfitPenalty,
  }
}

export function finalizeDualAnalysis(results: DualLayerResult[]): DualAnalysisResult | null {
  if (!results.length) return null
  const recommended = results.reduce((best, item) => item.selectionScore < best.selectionScore ? item : best)
  const maxMotorRms = Math.max(recommended.motorA.rms, recommended.motorB.rms, recommended.consensusRms)
  let confidence: DualAnalysisResult['confidence'] = 'low'
  let confidenceLabel = 'Düşük güven · manuel kontrol önerilir'
  if (recommended.consistency >= 82 && maxMotorRms <= 10) {
    confidence = 'high'
    confidenceLabel = 'Yüksek iç tutarlılık'
  } else if (recommended.consistency >= 65 && maxMotorRms <= 18) {
    confidence = 'medium'
    confidenceLabel = 'Orta iç tutarlılık'
  }
  return {
    results: [...results].sort((a, b) => a.layerCount - b.layerCount),
    recommended,
    confidence,
    confidenceLabel,
    generatedAt: Date.now(),
    methodNote: 'Motor A ve Motor B aynı Schlumberger 1B ileri çözümü kullanır; doğrulanan şey optimizasyon kararlılığı ve model seçiminin iç tutarlılığıdır. Bu ekran harici IPI2Win/RES1D benchmarkı değildir.',
  }
}
