# Quick start

The coworker uses Fable 5.1 for both conversation and coding. It is built locally and is not yet enabled for a repository.

1. Set the target repository, install commands, tests, and GitHub CI contexts in `engineer.config.json`.
2. Run `npm test`, `npm run compile`, and `npm run test:workflow`.
3. Connect GitHub to the existing Lua agent and verify a Fable-only runtime policy.
4. Publish with `npm run lua -- push all --ci`.
5. Generate the target files with `npm run prepare:github` and review them in a setup PR.
6. Configure enforced human reviews, CI, squash merging, and Actions secrets/variables.
7. Enable `LUA_ENGINEER_ENABLED` and label an issue `lua-ready`.

See [README.md](README.md) for exact commands, model-policy scope, and operation details. A second human must review a PR authored using your own GitHub account.
