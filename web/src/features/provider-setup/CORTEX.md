Please update me when files in this folder change.

Standalone new-install provider onboarding and local Claude setup.

| filename | role | function |
|---|---|---|
| ProviderSetupPage.tsx | view | Render provider setup with native window controls |
| ProviderSetupPage.test.tsx | test | Verify skip, continuation and login refresh |
| provider-setup.ts | controller | Match profile auth types and coordinate setup |
| provider-setup.test.ts | test | Verify auth-type readiness and setup failures |
| setup-native.ts | adapter | Guard Claude commands and filter install logs |
| setup-native.test.ts | test | Verify local guards and fixed native commands |
