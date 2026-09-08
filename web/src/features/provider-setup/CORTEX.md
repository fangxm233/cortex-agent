Please update me when files in this folder change.

Standalone new-install provider onboarding and local Claude setup.

| filename | role | function |
|---|---|---|
| ProviderSetupPage.tsx | view | Render provider setup outside the workbench shell |
| ProviderSetupPage.test.tsx | test | Verify skip, continuation and login refresh |
| provider-setup.ts | controller | Coordinate credentials, sync and profile readiness |
| provider-setup.test.ts | test | Verify readiness and operation-local failures |
| setup-native.ts | adapter | Guard Claude commands and filter install logs |
| setup-native.test.ts | test | Verify local guards and fixed native commands |
