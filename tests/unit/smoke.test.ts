import { describe, it, expect } from 'vitest';

// Bootstrap smoke test — proves the unit runner is wired before feature slices land.
describe('unit harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
