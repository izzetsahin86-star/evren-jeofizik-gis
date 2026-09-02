import assert from 'node:assert/strict'
import { advanceAdminAccess, applyAdminAccessConfig, DEFAULT_ADMIN_ACCESS_CONFIG, EMPTY_ADMIN_SEQUENCE } from '../src/adminAccess'
import { fromUtm } from '../src/geo'

const custom = {
  ...DEFAULT_ADMIN_ACCESS_CONFIG,
  targets: [
    { id: 1, easting: 372000, northing: 4266000 },
    { id: 2, easting: 372200, northing: 4266200 },
    { id: 3, easting: 372400, northing: 4266400 },
  ],
}

assert.equal(applyAdminAccessConfig(custom), true)

const point1 = fromUtm(372000, 4266000, 37, 'N')
const point2 = fromUtm(372200, 4266200, 37, 'N')
const point3 = fromUtm(372400, 4266400, 37, 'N')

let state = EMPTY_ADMIN_SEQUENCE
let result = advanceAdminAccess(state, point2, 1_000)
assert.equal(result.complete, false)
state = result.state
result = advanceAdminAccess(state, point1, 3_000)
assert.equal(result.complete, false)
state = result.state
result = advanceAdminAccess(state, point3, 6_000)
assert.equal(result.complete, true)

console.log('Değiştirilebilir yönetici koordinatları doğrulandı.')
