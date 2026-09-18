# Development contract

Read README.md and docs/design.md first. This is an independent DeepSeek Harness plugin, not a Zotero extension and not part of the Paper Library plugin.

- **One-way only.** Local data flows to the remote. Never add a path that writes remote content back over a source directory, and never treat the remote as authoritative.
- **Secrets never enter the repository or a config file.** `config.json` rejects any secret-shaped field on purpose. Credentials come from `<stateDir>/oss.env` (mode 0600) or the environment, and every report redacts them.
- **Never modify source data.** Sources are read-only inputs. All writes land in the remote or the managed state directory.
- **Do not destroy a good copy to save an upload.** The planner may only replace a remote object when the size changed or the transport reported a differing digest. "Cannot prove identical" means leave it alone and report `size-match-unverified`.
- **Crash safety comes from ordering, not rollback.** Archive before overwrite; upload to a run-scoped temp key; verify; then publish. Keep it so an interrupted run can only be resumed, never half-applied.
- **Advance a source's index only when that whole source succeeded.** Partial runs must not mark failed files as backed up.
- **Bound everything.** Bounded concurrency (1–24), bounded listing, bounded per-file and per-run bytes, bounded output; every subprocess call is argv-based and timeout-guarded.
- **Report facts, not reassurance.** Unverified is not verified; a cost estimate from a price table is not a bill; a synthetic test is not a real-bucket test.
- **Tests use synthetic documents and local or in-process doubles only.** No real bucket, no real credential, no network. Keep `scripts/validate.mjs` runnable and honest about scope.
- Scheduler logic belongs to dsh-cron-scheduler, not here. This plugin owns scanning, planning, uploading, archiving, verifying and locating versions.
- Commit task changes after the checks pass. The public source repository is `mappedinfo/dsh-vault-sync`; never publish credentials, bucket names, local paths or run artifacts.
- Original code is MIT. Preserve the separate licenses of external tools (see THIRD_PARTY.md); rclone is optional and never bundled.
