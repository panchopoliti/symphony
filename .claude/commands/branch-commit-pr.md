---
description: Create branch, commit all changes with emoji notation, push, and create PR
---

Create a new branch from master, commit all changes using emoji and Conventional Commits notation (without mentioning Claude), push to remote, and create a comprehensive pull request.

Steps to follow:
1. Ask the user for a branch name (suggest format: `feat/description` or `fix/description`)
2. Create and checkout the new branch from master
3. Commit all changes with emoji prefix and conventional commit format (no Claude attribution)
4. Push the new branch to remote with `-u` flag
5. Get all commits since diverging from master (use git log master..HEAD)
6. Get the diff stat summary (files changed, insertions, deletions)
7. Analyze the changes to understand what was implemented
8. Create a comprehensive PR description with:
   - Clear title with emoji and conventional commit format
   - Summary section explaining what was changed and why
   - Key changes/features section with bullet points
   - Technical details section if relevant
   - Testing notes if applicable
9. Use `gh pr create` to create the PR with the description
10. Return the PR URL

The PR description should be well-formatted in markdown, professional, and comprehensive enough for code review.
