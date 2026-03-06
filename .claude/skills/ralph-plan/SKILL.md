---
name: ralph-plan
description: Plan a feature by breaking it into tasks for Ralph autonomous execution. Creates a structured PRD with dependencies, acceptance criteria, and the project folder.
---

# Ralph Plan - Feature Planning Skill

You help users break features into right-sized tasks for autonomous execution by Ralph.

## Planning Steps

### 1. Gather Feature Information

Ask the user:
- **Do you have a PRD file?** If yes, read it. If no, ask them to describe the feature.
- Store the PRD file path in `feature.prdFile` if provided.

### 2. Ask Clarifying Questions

Before planning, understand:
- **User-facing goal**: What does the end user see or experience?
- **Codebase areas affected**: Which parts of the codebase will change? (api, web, shared, scripts, etc.)
- **Existing patterns**: Are there similar features already implemented to follow as reference?
- **Definition of done**: How will we know the feature is complete?
- **Constraints**: Any limitations, deadlines, or technical requirements?

### 3. Break Into Right-Sized Tasks

Each task should be completable in **one context window / one iteration**. Guide:

**Good task size:**
- Add a database migration / schema change
- Create one service or use case
- Implement one GraphQL mutation/query
- Build one React component
- Write tests for one module
- Add one script

**Too big (split these):**
- "Build the entire dashboard" → schema + queries + components + filters + tests
- "Implement authentication" → schema + service + middleware + UI + tests
- "Add reporting feature" → data model + aggregation + API + UI + export

### 4. Define Dependencies

Common dependency patterns for this RedwoodJS project:
```
Schema/Migration → Service/Use Case → GraphQL SDL + Service → UI Component → Tests
```

Tasks that don't depend on each other can run in parallel (they just need shared dependencies marked).

### 5. Write Verifiable Acceptance Criteria

**Good:**
- "The `createUser` mutation returns a User object with id and email"
- "Running `yarn rw type-check` passes with no errors"
- "The component renders a table with columns: Name, Email, Status"

**Bad (too vague):**
- "Works correctly"
- "Is well tested"
- "Follows best practices"

### 6. Create Project Structure

Create `ralph/<project-name>/` with:

1. **prd.json** - Copy from `ralph/.template/prd.json` and fill in:
   - `feature.name` and `feature.description`
   - `feature.prdFile` (if user provided one)
   - `config.qualityChecks` - customize if needed (defaults: `yarn rw type-check`, `yarn rw test --no-watch`)
   - `config.commitPrefix` - default `feat`, change to `fix`, `refactor`, etc. as appropriate
   - All tasks with ids, titles, descriptions, dependencies, acceptance criteria, and file hints
   - `progress.started` - current ISO timestamp
   - `progress.maxIterations` - estimate based on task count (typically 2x number of tasks)

2. **progress.md** - Copy from `ralph/.template/progress.md` and fill in feature name and date

### 7. Present for Review

Show the user:
- Task list with IDs and titles
- Dependency graph (text-based)
- Estimated iteration count
- Ask for approval before they run `./ralph/ralph.sh <project-name>`

## Task Description Template

Each task description should be self-contained (Claude gets fresh context each iteration):

```markdown
**What to do:**
- Specific step 1
- Specific step 2

**Files:**
- path/to/file.ts (create/modify)
- path/to/other.ts (modify)

**Reference patterns:**
- Look at path/to/similar.ts for the existing pattern

**Notes:**
- Any important context
- Business rules that apply
- Edge cases to handle
```

## Project-Specific Patterns for This Codebase

When planning tasks for this RedwoodJS project, inject these patterns:

- **Database changes**: Use Prisma schema at `api/db/schema.prisma`, run `yarn rw prisma migrate dev`
- **Services**: Located in `api/src/services/`, follow domain-driven patterns
- **GraphQL**: SDL files in `api/src/graphql/`, service implementations alongside
- **Web components**: React components in `web/src/components/`
- **Shared code**: Reusable types/utils in `shared/src/`
- **Scripts**: Backend scripts in `scripts/`, run via `yarn rw exec <name>`
- **Domain objects**: Follow repository pattern - never use save() returns as domain objects
- **Race conditions**: Account for partial data states (User → WorkspaceUser → Workspace → WildMailAccount chain)
- **Three-state booleans**: Use `null | false | true` for feature flags (null = not applicable)
