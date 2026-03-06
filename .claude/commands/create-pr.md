---
description: Create a pull request to master with comprehensive description
---

Create a pull request from the current branch to master.

Steps to follow:
1. Get the current branch name
2. Get all commits since diverging from master (use git log master..HEAD)
3. Get the diff stat summary (files changed, insertions, deletions)
4. Analyze the changes to understand what was implemented
5. Create a comprehensive PR description with:
   - Clear title with emoji and conventional commit format
   - Summary section explaining what was changed and why
   - Key changes/features section with bullet points
   - Technical details section if relevant
   - Testing notes if applicable
6. Use `gh pr create` to create the PR with the description
7. Return the PR URL

The PR description should be well-formatted in markdown, professional, and comprehensive enough for code review.
