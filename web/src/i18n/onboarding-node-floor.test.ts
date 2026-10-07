import { expect, it } from 'vitest';
import { onboardingEn, onboardingZh } from './onboarding-vocab';

it('keeps dependency names and technical details out of normal onboarding copy', () => {
  for (const vocab of [onboardingEn, onboardingZh]) {
    for (const [key, value] of Object.entries(vocab)) {
      if (key.startsWith('onbErr')) continue;
      expect(value, key).not.toMatch(/Node(?:\.js)?|npm|\bGit\b|prefix|checksum|PATH|校验|运行时/i);
    }
    expect(vocab.onbPreparingIntro).not.toMatch(/no extra steps|无需其他操作/i);
    expect(vocab.onbLocalHint).not.toMatch(/upgrade|升级/i);
  }
});

it('keeps Windows prerequisite actions without a separately hardcoded Node floor', () => {
  for (const vocab of [onboardingEn, onboardingZh]) {
    expect(vocab.onbErrNodeRequired).toContain('Node.js LTS');
    expect(vocab.onbErrNodeRequired).not.toMatch(/Node(?:\.js)?\s*\d/);
    expect(vocab.onbErrNpmRequired).toContain('npm');
    expect(vocab.onbErrGitRequired).toContain('Git Bash');
  }
});

it('uses nontechnical installation failures in both languages', () => {
  for (const vocab of [onboardingEn, onboardingZh]) {
    for (const key of ['onbErrRuntimeDownloadFailed', 'onbErrRuntimeIntegrityFailed',
      'onbErrRuntimeUnsupported', 'onbErrRuntimeMissing', 'onbErrServerExternalUnsupported',
      'onbErrSetupCancelled'] as const) {
      expect(vocab[key]).toBeTruthy();
      expect(vocab[key]).not.toMatch(/Node|npm|Git|checksum|prefix|PATH|校验|运行时/i);
    }
  }
});
