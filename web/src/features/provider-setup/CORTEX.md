Please update me when files in this folder change.

Standalone new-install provider onboarding and local Claude setup.

| filename | role | function |
|---|---|---|
| ProviderSetupPage.tsx | view | Render wizard-style provider rows with brand icons |
| ProviderSetupPage.test.tsx | test | Verify icons, login targets and continuation |
| SetupHeader.tsx | view | Match setup branding, language and window controls |
| SetupHeader.test.tsx | test | Verify appearance and native caption actions |
| provider-setup.css | style | Match native setup spacing, controls and tokens |
| provider-setup.ts | controller | Match profile auth types and coordinate setup |
| provider-setup.test.ts | test | Verify auth-type readiness and setup failures |
| setup-native.ts | adapter | Guard Claude commands and filter install logs |
| setup-native.test.ts | test | Verify local guards and fixed native commands |
