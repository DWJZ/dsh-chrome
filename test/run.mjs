/**
 * Keyless unit tests: lease arbitration and the page-list text fallback.
 * Run with `node --import tsx/esm test/run.mjs`.
 */

import assert from 'node:assert/strict'
import { LeaseBook } from '../src/leases.ts'

// A claim is exclusive while its owner is alive.
{
  const leases = new LeaseBook(1_000, (id) => id === 'a' || id === 'b', () => 0)
  leases.claim(1, 'a')
  assert.equal(leases.owner(1), 'a')
  assert.throws(() => leases.claim(1, 'b'), (error) => error.code === 'tab_busy')
  leases.claim(1, 'a') // same owner refreshes
  assert.equal(leases.owner(1), 'a')
}

// Releasing frees the tab for another owner.
{
  const leases = new LeaseBook(1_000, () => true, () => 0)
  leases.claim(2, 'a')
  leases.release(2)
  leases.claim(2, 'b')
  assert.equal(leases.owner(2), 'b')
}

// A disposed owner's claims disappear without waiting for the ttl.
{
  const leases = new LeaseBook(60_000, (id) => id !== 'gone', () => 0)
  leases.claim(3, 'gone')
  leases.claim(4, 'live')
  assert.equal(leases.owner(3), undefined)
  assert.equal(leases.owner(4), 'live')
  assert.equal(leases.releaseAgent('live'), 1)
}

// When liveness cannot be resolved, the ttl decides.
{
  let now = 0
  const leases = new LeaseBook(100, () => undefined, () => now)
  leases.claim(5, 'unknown')
  now = 50
  assert.equal(leases.owner(5), 'unknown')
  now = 200
  assert.equal(leases.owner(5), undefined)
}

// Pruning drops claims for pages that no longer exist.
{
  const leases = new LeaseBook(1_000, () => true, () => 0)
  leases.claim(6, 'a')
  leases.claim(7, 'a')
  leases.prune([7])
  assert.equal(leases.owner(6), undefined)
  assert.equal(leases.owner(7), 'a')
}

console.log('unit tests passed')
