---
argument-hint: "[--branch branch-name]"
description: DDD-focused code review for correctness, architecture, and data integrity
---

# Code Review: Domain-Driven Design Focus

**Input:** $ARGUMENTS

## Setup & Scope

Extract branch name (after --branch, or use current branch). Run automated checks first:

```bash
# Automated pre-checks
yarn tsc --noEmit
yarn rw test --passWithNoTests
git diff master...[branch] --stat
```

Then analyze changes with DDD lens.

---

## 🔴 Critical Issues (P0 - Must Fix)

### 1. Domain Model Integrity

**Repository Pattern Violations**
- ❌ **Anti-pattern**: Using `save()` return value as domain object
  ```typescript
  // WRONG
  const workspace = await WorkspacesRepo.save(workspaceDomain);
  workspace.setWildMailAccountId(id); // Runtime error!

  // CORRECT
  await WorkspacesRepo.save(workspaceDomain);
  const workspace = await WorkspacesRepo.getById(workspaceDomain.getId());
  ```
- ✅ Repository interfaces: `save(entity: T): Promise<void>`, `getById(id): Promise<T>`
- ✅ Domain objects returned from `get*` methods only
- ✅ No Prisma types leaking into service/use case layers

**Domain Object Boundaries**
- Are domain objects properly separated from Prisma models?
- Do domain objects encapsulate business logic via methods (not just data bags)?
- Are setters/getters used consistently instead of direct property access?
- Are domain invariants enforced in constructors/setters?

**Example Violations to Check:**
```typescript
// ❌ Direct Prisma usage in service
const user = await db.user.findUnique({ where: { id } });
user.email = newEmail; // No validation!

// ✅ Domain object with invariants
const user = await UserRepo.getById(id);
user.setEmail(newEmail); // Validates format, uniqueness, etc.
```

### 2. Data Consistency & Relationships

**Core Schema Relationships** (from CLAUDE.md):
```
User ↔ WorkspaceUser ↔ Workspace ↔ WildMailAccount
```

Check for:
- [ ] `User.currentWorkspaceId` has corresponding `WorkspaceUser` record
- [ ] `Workspace.wildMailAccountId` points to valid `WildMailAccount`
- [ ] `WorkspaceUser` exists for all user-workspace memberships
- [ ] Foreign key constraints respected in all operations
- [ ] Race conditions handled (eventual consistency during user setup)

**Multi-User Workspace Pattern**:
- All users in workspace share **same AC account name**
- Each user has **different username** (`accountName%individualUsername`)
- Each user has **own API key** and password
- Per-user features tracked in `WorkspaceUser`, not `Workspace`

**Database Migrations**:
- [ ] Reversible with down migration or rollback plan
- [ ] Default values set for new NOT NULL columns
- [ ] Post-migration validation script included (if data changes)
- [ ] Tested on staging with production-like data volume

### 3. Service Layer Architecture

**Dependency Injection Violations**
- ❌ Hard-coded dependencies (use DI for testability)
- ❌ Direct instantiation of repos/services in use cases
- ✅ Dependencies passed as constructor params
- ✅ Interfaces used instead of concrete implementations

**Cross-Cutting Concerns**
```typescript
// Pattern: Wrapper for data requirements
export const withWildMailAccountIdRequirement = (service) => async (params) => {
  let wildMailAccountId = params.currentUser?.wildMailAccount?.id;

  // Fallback for race conditions
  if (!wildMailAccountId) {
    wildMailAccountId = await fallbackWildMailAccountLookup(params.currentUser);
  }

  return service({ ...params, wildMailAccountId });
};
```

Check for:
- [ ] Common requirements extracted to reusable wrappers
- [ ] Graceful handling of partial data states
- [ ] Appropriate fallback strategies

### 4. Type Safety & Null Handling

- [ ] No `any` types (except justified with comment)
- [ ] Null/undefined handled explicitly (not assumed)
- [ ] Optional chaining used appropriately (`?.`)
- [ ] Nullish coalescing used correctly (`??`)
- [ ] DTOs validated before transformation to domain objects

**Three-State Boolean Pattern** (from CLAUDE.md):
```typescript
// null | false | true pattern for features
acPasswordResetted: boolean | null

// null  = Not applicable (legacy, missing prerequisites)
// false = Applicable, action required
// true  = Complete, action taken
```

---

## 🟡 Important Issues (P1 - Should Fix)

### 5. Error Handling & Resilience

- [ ] All service calls wrapped in try-catch
- [ ] Errors logged with context (user ID, operation, timestamp)
- [ ] Error types distinguish recoverable from fatal
- [ ] User-facing error messages don't leak internals
- [ ] Proper error propagation (don't swallow errors)

**Result Type Pattern**:
```typescript
type Response = Either<ErrorType, Result<SuccessType>>;

// Left side = error, Right side = success
if (result.isLeft()) {
  return left(ErrorType.create());
}
```

### 6. Environment Configuration

**Environment-Aware Patterns**:
```typescript
const CONFIG = {
  stripe: {
    secretKey: process.env.ENV === 'local'
      ? process.env.STRIPE_SK_TEST
      : process.env.STRIPE_SK,
  }
};
```

Check for:
- [ ] Test vs. production keys properly separated
- [ ] Required env vars validated at startup
- [ ] No production API calls in test environment
- [ ] Secrets never hard-coded or logged

### 7. Race Condition & State Management

**CurrentUser State Lifecycle** (from CLAUDE.md):
- `CREATED`: User + Workspace exist, wildMailAccount is null
- `TRANSITION`: Race condition window during account linking
- `READY`: All relationships established

Check for:
- [ ] Services handle partial `currentUser` data gracefully
- [ ] Fallback data retrieval for race conditions
- [ ] Clear error messages when required data missing
- [ ] No assumptions that all joins are complete

### 8. Multi-Reseller Support

**Factory Pattern** (if multi-reseller support present):
```typescript
// ✅ CORRECT: Use factory
const ResellerApi = ResellerApiFactory.createForAccount(wildMailAccount);

// ❌ WRONG: Direct instantiation
const ResellerApi = ResellerApiAdapter();
```

Check for:
- [ ] All reseller API calls use `ResellerApiFactory`
- [ ] No hard-coded `resellerId` values
- [ ] Account-specific operations use `createForAccount()`
- [ ] Generic operations use `createDefault()`
- [ ] `resellerId` validated (not null/empty)

---

## 🔵 Code Quality (P2 - Nice to Have)

### 9. Readability & Maintainability

- [ ] Function names describe intent (verbs for actions)
- [ ] Variable names are descriptive (avoid abbreviations)
- [ ] Functions focused on single responsibility
- [ ] Magic numbers/strings extracted to named constants
- [ ] Complex logic has explanatory comments
- [ ] Cyclomatic complexity reasonable (< 10)

### 10. Testing

**Test Quality**:
- [ ] Unit tests for business logic
- [ ] Integration tests for critical workflows
- [ ] Edge cases covered (null, empty, boundary values)
- [ ] Mocks used for external dependencies
- [ ] Test environment isolated from production

**Anti-patterns to Check**:
```typescript
// ❌ WRONG: Testing with production APIs
test('payment', async () => {
  const stripe = new Stripe(process.env.STRIPE_SK); // Production key!
});

// ✅ CORRECT: Mocked external services
jest.mock('../stripe/Stripe', () => ({
  createCustomer: jest.fn().mockResolvedValue({ id: 'test_cust' })
}));
```

### 11. Performance

- [ ] Database queries optimized (use indexes, limits)
- [ ] N+1 query problems avoided (use `include`)
- [ ] Transactions kept minimal (short duration)
- [ ] Pagination for large result sets
- [ ] No unnecessary loops or redundant computations
- [ ] Appropriate caching where beneficial

### 12. Feature Flags & Capability Checks

```typescript
// Capability-based enablement
const hasAcCredentials = !!(user.acUsername && user.acApiKey);
const featureFlag = hasAcCredentials ? false : null;

// Defensive display logic
const shouldShowFeature = (user) => {
  if (user.featureFlag !== false) return false;
  if (!user.hasRequiredCapability) return false;
  if (isFeatureSnoozed(user)) return false;
  return true;
};
```

---

## Review Output Format

For each issue found, provide:

```markdown
**[Priority] Category: Issue Title**
- **File**: [filename.ts:123](path/to/file.ts#L123)
- **Problem**: Description of what's wrong
- **Impact**: What could go wrong (data loss, errors, confusion)
- **Fix**: Specific code change or approach
- **Example**: Code snippet (if helpful)
```

---

## Summary Assessment

After review, provide:

### Code Quality Score
**Score**: X/10

**Breakdown**:
- Domain Model Integrity: X/10
- Data Consistency: X/10
- Architecture & Patterns: X/10
- Type Safety: X/10
- Error Handling: X/10
- Testing: X/10

### Merge Readiness
- **Ready for Merge**: Yes/No/With Changes
- **Estimated Risk**: Low/Medium/High
- **Blockers**: List of P0 issues (if any)

### Top Priorities
1. Most critical issue to fix first
2. Second priority
3. Third priority

### Strengths
- What's done well in this PR
- Positive patterns to highlight

---

## Recommended Next Steps

- [ ] Fix P0 issues (blocking merge)
- [ ] Address P1 issues (strongly recommended)
- [ ] Consider P2 suggestions (optional)
- [ ] Run automated checks again: `yarn tsc && yarn rw test`
- [ ] Update tests to cover new scenarios
- [ ] Add migration validation script (if DB changes)

---

**Start review now**. Prioritize DDD patterns, data integrity, and type safety. Be specific with file paths and line numbers using markdown links.
