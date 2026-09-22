import { describe, expect, test } from 'vitest';

import { staffUserFromLocals } from '../../src/middleware/staffSession.js';

describe('staffUserFromLocals', () => {
  test('throws when called on a route that skipped requireStaffAuth', () => {
    const res = { locals: {} } as Parameters<typeof staffUserFromLocals>[0];

    expect(() => staffUserFromLocals(res)).toThrow(/requireStaffAuth/);
  });
});
