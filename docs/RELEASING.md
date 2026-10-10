# Releasing dsh-notification-hook

This guide is for maintainers. No command in this guide is executed automatically by the repository, an assistant, or a dry-run workflow. Creating an npm stage, approving it, configuring trust, pushing a release tag, publishing to npm, and changing a GitHub Release all require explicit maintainer approval.

## Release invariants

- Normal CI uses Node.js 22 on Windows, macOS, and Linux.
- Release jobs use exactly Node.js `24.15.0` and npm `12.2.0`.
- npm Trusted Publishing uses OIDC; do not create or add a long-lived `NODE_AUTH_TOKEN`.
- Trusted Publishing generates provenance automatically; do not add `--provenance`.
- `workflow_dispatch` is verification-only. Only a pushed `v*` tag can reach the publish job.
- The release workflow first creates a draft GitHub Release, then publishes npm, then makes the GitHub Release public.

## Local acceptance

Start from a clean checkout and run:

```powershell
npm ci
npm run check
npm run verify:package -- --out-dir dist
npm run verify:dsh -- --archive-dir dist
npm run release:preflight -- --mode dry-run
git status --short
```

The final command must report no tracked changes. `dist/` is ignored and contains the candidate `.tgz` plus its `.sha256` file. The lifecycle check uses a temporary DSH profile; it never accesses the real `desktop` profile.

## One-time npm bootstrap

Trusted Publisher settings are configured on an existing npm package. Bootstrap ownership with a staged prerelease, not the final `0.3.0` release.

Before starting, create the public repository `cyrillee0413-bit/dsh-notification-hook`, push the intended `main` branch, and confirm its CI run is green.

1. Use a disposable clean branch or worktree. Install Node.js `24.15.0`, then pin and verify npm:

   ```powershell
   npm install --global npm@12.2.0
   node --version
   npm --version
   ```

   The outputs must be `v24.15.0` and `12.2.0`.

2. Sign in to the npm account that will own the package and make sure account 2FA is enabled. Do not save an OTP, session token, or access token in the repository.

3. Temporarily set the package and lockfile version to `0.3.0-rc.0` and add a matching `0.3.0-rc.0` entry to `CHANGELOG.md`, then run the full local acceptance sequence and build the RC archive. Package verification derives the expected version from `package.json`, lifecycle verification discovers the one `.tgz` in `dist`, and dry-run preflight checks that exact prerelease and changelog entry, so the RC uses the same checks as the final build. Do not create a Git tag for this bootstrap-only version.

4. Stage the verified prerelease under `next`:

   ```powershell
   npm stage publish dist/dsh-notification-hook-0.3.0-rc.0.tgz --tag next --access public
   npm stage list dsh-notification-hook
   ```

5. Inspect the returned stage, optionally download it with `npm stage download <stage-id>`, and approve it interactively:

   ```powershell
   npm stage approve <stage-id>
   ```

   Approval prompts for 2FA. Never place the OTP on a command line recorded in documentation or CI.

6. In the npm package settings, configure the GitHub Trusted Publisher for repository `cyrillee0413-bit/dsh-notification-hook`. Enter the workflow filename exactly as `release.yml` (not the repository path), and enable **Allow npm publish** because this workflow performs a direct `npm publish`. Keep any npm environment field consistent with the workflow; this repository does not declare a GitHub environment.

7. Complete the first OIDC publication within two days of configuring the trusted relationship. Restore the intended `0.3.0` version in both manifest and lockfile, restore the final changelog entry, rerun acceptance, review the diff, and commit normally. After the first successful OIDC release, disable traditional token publishing in the npm package settings.

If the stage is wrong, use `npm stage reject <stage-id>` and complete the interactive 2FA challenge. The semver is reserved while the stage is pending; after rejection, you may stage it again with corrected contents or a different tag.

## Dry-run workflow

Run the GitHub Actions **Release** workflow manually with `workflow_dispatch`. It calls the complete three-platform CI workflow, then rehearses Node.js `24.15.0`, npm `12.2.0`, package verification, and dry-run preflight in a read-only job. The publish job requires both a `push` event and a `v*` tag, so a manual run cannot create a GitHub Release or publish to npm even when the selected ref is a tag.

## Normal release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the release.
2. Run the local acceptance commands above.
3. Commit the release changes and obtain review.
4. Confirm the npm Trusted Publisher still names this repository, the workflow filename `release.yml`, and **Allow npm publish**.
5. With explicit maintainer approval, create and push a tag that exactly equals `v` plus `package.json.version`.

The tag workflow re-runs the three-platform gates. Its publish job pins Node.js `24.15.0` and npm `12.2.0`, rebuilds the candidate, runs `release:preflight`, creates a draft GitHub Release, executes `npm publish <verified.tgz> --access public` through OIDC, and exposes the GitHub Release only after npm succeeds.

## Failure recovery

- If preflight reports that the version already exists, increment the version; npm versions cannot be overwritten.
- If the GitHub draft is created but npm publishing fails, leave the Release as a draft while diagnosing the failure. A retry validates that the existing Release is still a draft and refreshes its assets with `--clobber`; it refuses to reuse a public Release. Do not publish the draft as a substitute for npm availability.
- If npm succeeds but the final `gh release edit` step fails, verify the npm package, checksum, tag, and draft assets before manually publishing that existing draft.
- If the DSH lifecycle fails, do not bypass it. Read the redacted command error, reproduce with the same pinned versions, and fix the verifier or package deliberately.
- Never retry by adding `NODE_AUTH_TOKEN`, weakening workflow permissions, or removing the native volatile Config assertion.
