// input:  mobile route declarations and React route elements
// output: Usage settings route registration regression
// pos:    Verifies the mobile Usage route seam
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { mobileRoutes } from './mobile-routes';

function mobileChildren() {
  return mobileRoutes[0]?.children ?? [];
}

describe('mobile Usage route', () => {
  it('registers /m/settings/usage as a drill-in screen', () => {
    const route = mobileChildren().find(candidate => candidate.path === '/m/settings/usage');

    expect(isValidElement(route?.element)).toBe(true);
    expect((route?.element as { type?: { name?: string } } | undefined)?.type?.name).toBe('MUsageScreen');
  });
});
