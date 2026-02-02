---
description: Squash all unpushed commits into a single commit with a generated conventional commit message.
includeContext: false
autoApprove: true
---

Please squash all unpushed commits into a single commit.

Assuming the remote is 'origin', the upstream is origin/{current branch}.

Get the diff of the unpushed commits:

`git diff origin/$(git rev-parse --abbrev-ref HEAD)..HEAD`

Based on this diff, generate a conventional commit message following the Conventional Commits specification (e.g., `type: description`).

Then, execute the following commands to perform the squash:

`git reset --soft origin/$(git rev-parse --abbrev-ref HEAD)`

`git commit -m "<generated commit message>"`
