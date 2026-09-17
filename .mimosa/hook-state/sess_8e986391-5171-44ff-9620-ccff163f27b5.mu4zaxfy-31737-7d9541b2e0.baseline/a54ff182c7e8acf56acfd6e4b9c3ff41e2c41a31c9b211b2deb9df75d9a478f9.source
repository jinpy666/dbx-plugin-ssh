# Agent workflow

This repository is the DBX SSH/SFTP plugin. Follow `.github/agent-flow.yml` as the machine-readable task contract and `.zcode/skills/dbx-ssh-dev/SKILL.md` for repository-specific build and safety rules.

## Handoff rules

- Use one branch/worktree per agent. Never run concurrent agents in this checkout.
- Read the contract and the SSH development skill before editing; stay within `allowed_paths`.
- Never use real SSH credentials, private keys, production hosts, or an external DBX host checkout.
- Treat authentication, command execution, secret binding, and protocol changes as high-risk and require human review.
- Run local validation before handoff and record the base SHA, changed files, tests, risks, and follow-up work in the PR.
- Agents do not merge their own PRs.

## Integration rules

The integrator owns `Cargo.lock`, versions, generated `ui/`, packaging/install checks, and final protocol/manifest consistency. Installation and DBX restart are never automatic agent actions.

