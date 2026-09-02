import assert from 'node:assert/strict'
import { advanceAdminAccess, EMPTY_ADMIN_SEQUENCE } from '../src/adminAccess'
import { fromUtm } from '../src/geo'

const point1 = fromUtm(371500, 4265500, 37, 'N')
const point2 = fromUtm(371680, 4265630, 37, 'N')
const point3 = fromUtm(371430, 4265790, 37, 'N')

let state = EMPTY_ADMIN_SEQUENCE
let result = advanceAdminAccess(state, point2, 1_000)
assert.equal(result.complete, false)
state = result.state

result = advanceAdminAccess(state, point1, 3_000)
assert.equal(result.complete, false)
state = result.state

result = advanceAdminAccess(state, point3, 6_000)
assert.equal(result.complete, true)

result = advanceAdminAccess({ step: 1, startedAt: 1_000 }, point1, 10_001)
assert.equal(result.complete, false)
assert.equal(result.state.step, 0)

result = advanceAdminAccess({ step: 1, startedAt: 1_000 }, point3, 2_000)
assert.equal(result.complete, false)
assert.equal(result.state.step, 0)

console.log('Gizli yönetici koordinat sırası doğrulandı.')
