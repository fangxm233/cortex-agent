// input:  none (pure)
// output: compareCalVer — CalVer YYYY.M.D[-N] comparator
// pos:    shared version ordering for server update check and app-update manifest
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// CalVer comparison: YYYY.M.D[-N]. Supports an optional suffix (e.g. 2026.5.23-1) for hotfix
// releases — the suffix sorts ABOVE the plain version (unlike semver prerelease ordering, which is
// why semver comparators must never be used on these versions). Default suffix is 0 when absent.
// Compare element-wise (year, month, day, suffix) to avoid string-ordering pitfalls across digit
// boundaries.

export function compareCalVer(a: string, b: string): number {
  const parse = (v: string): [number, number, number, number] => {
    const parts = v.split('.');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const daySuffix = parts[2]?.split('-') ?? ['0'];
    const day = Number(daySuffix[0]);
    const suffix = Number(daySuffix[1] ?? '0');
    return [year, month, day, suffix];
  };

  const [ay, am, ad, asfx] = parse(a);
  const [by, bm, bd, bsfx] = parse(b);

  if (ay !== by) return ay - by;
  if (am !== bm) return am - bm;
  if (ad !== bd) return ad - bd;
  return asfx - bsfx;
}
