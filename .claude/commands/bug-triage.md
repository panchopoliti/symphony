---
argument-hint: "--description \"issue description\" [--comment \"additional comment\"]"
description: Analyze and triage bug reports with structured recommendations
---

# Bug Triage Analysis

Please analyze this bug report and provide a structured triage assessment.

**Input:** $ARGUMENTS

Parse the input above to extract:
- Issue description (after --description flag)
- Additional comments (after --comment flag, if present)

Following the **Bug Triage SOP**, analyze the bug report systematically:

## 1. **Severity & Impact Assessment**
Rate as Critical/High/Medium/Low based on:
- Production system availability impact
- User experience degradation scale
- Business revenue/operations impact
- Security implications
- Data integrity risks

## 2. **Category Classification & Component Analysis**
Identify affected areas:
- **Frontend**: React components, UI/UX, client-side logic
- **Backend API**: Express routes, GraphQL resolvers, business logic
- **Database**: PostgreSQL queries, data integrity, migrations
- **Authentication**: Auth0, session management, permissions
- **Integrations**: ActiveCampaign API, Stripe, webhooks
- **Infrastructure**: AWS Lambda, deployment pipeline, monitoring

## 3. **Detailed Root Cause Hypothesis**
Develop comprehensive hypotheses for each potential cause:

### Primary Hypothesis
- **Theory**: [Most likely root cause based on symptoms]
- **Supporting Evidence**: [What in the description supports this]
- **Verification Method**: [How to confirm/disprove this theory]

### Alternative Hypotheses (if primary unclear)
- **Theory 2**: [Second most likely cause]
- **Theory 3**: [Third possibility]
- **Edge Case Scenarios**: [Less common but possible causes]

## 4. **Investigation Strategy**

### Safe Production Debugging Protocol
⚠️ **PRODUCTION SAFETY RULES**:
- NEVER run destructive operations against production
- Use read-only database connections when accessing production data
- Always test fixes in development/staging first
- Monitor system performance during investigation

### TDD Reproduction Approach
If root cause is unclear, follow this systematic approach:

1. **Create Failing Test**
   - Write test cases that reproduce the reported behavior
   - Include edge cases and boundary conditions
   - Test with production-like data (anonymized)

2. **Local Environment Setup**
   - Set up local environment mirroring production conditions
   - Use production database read replica for data investigation
   - Replicate user scenarios and workflows

3. **Subagent Investigation Strategy**
   - Deploy specialized investigation agents for different hypotheses
   - Parallel investigation of multiple root cause theories
   - Systematic elimination of potential causes

### Investigation Steps by Hypothesis

#### For Data/Database Issues:
- Query production logs (read-only) for error patterns
- Check recent migrations and schema changes
- Analyze data consistency and foreign key violations
- Review database performance metrics

#### For API/Integration Issues:
- Examine webhook logs and API response patterns
- Check third-party service status and rate limits
- Validate request/response data formats
- Test integration endpoints in staging

#### For Authentication Issues:
- Review Auth0 logs and user session data
- Check token expiration and refresh patterns
- Validate permission and role assignments
- Test authentication flows in development

#### For Frontend Issues:
- Analyze browser console errors and network requests
- Check component state management and props
- Test across different browsers and devices
- Review recent frontend deployments

## 5. **Solution Approaches**

### Immediate Mitigation (if Critical/High)
- **Hotfix Strategy**: Quick temporary solution to restore service
- **Rollback Plan**: Steps to revert to previous working state
- **Monitoring Enhancement**: Additional alerts and logging

### Comprehensive Solutions
Provide multiple solution approaches ranked by:
- **Implementation Complexity**: Time and effort required
- **Risk Level**: Potential for introducing new issues
- **Long-term Sustainability**: Addresses root cause vs. symptoms

#### Approach 1: [Recommended Solution]
- **Description**: [Detailed solution approach]
- **Implementation Steps**: [Step-by-step plan]
- **Testing Strategy**: [How to validate the fix]
- **Rollback Plan**: [How to undo if issues arise]

#### Approach 2: [Alternative Solution]
- **Description**: [Different approach to same problem]
- **Trade-offs**: [Pros and cons vs. Approach 1]

#### Approach 3: [Quick Fix/Workaround]
- **Description**: [Temporary solution if needed]
- **Limitations**: [What this doesn't address]

## 6. **Testing & Validation Strategy**

### Pre-Deployment Testing
- Unit tests covering the fix
- Integration tests for affected workflows
- Performance impact assessment
- Security implications review

### Deployment Strategy
- **Staging Validation**: Full testing in production-like environment
- **Gradual Rollout**: Phased deployment plan if applicable
- **Monitoring Plan**: Metrics to watch post-deployment
- **Success Criteria**: How to measure fix effectiveness

## 7. **Asana Task Creation**

**Title**: [Bug] [Concise description]
**Priority**: [Based on severity assessment]
**Assignee Team**: [Frontend/Backend/DevOps/Security]
**Epic/Project**: [Link to relevant project]

**Description Template**:
```
## Issue Summary
[Brief description of the problem]

## Root Cause Hypothesis
[Primary theory with supporting evidence]

## Solution Approach
[Recommended solution with implementation plan]

## Testing Requirements
- [ ] Unit tests
- [ ] Integration tests
- [ ] Staging validation
- [ ] Performance testing

## Definition of Done
- [ ] Issue reproduced and root cause confirmed
- [ ] Fix implemented and tested
- [ ] Deployed to production safely
- [ ] Monitoring confirms resolution
- [ ] Documentation updated if needed
```

**Tags**: [severity-level], [component], [team], [customer-impact if applicable]

## 8. **Communication & Escalation Plan**

### For Critical Issues
- **Immediate**: Notify engineering lead and product team
- **Update Frequency**: Every 30 minutes until resolved
- **Stakeholder Communication**: [Draft customer/internal communication]
- **Post-Mortem Required**: Yes, schedule within 48 hours

### For High Priority Issues
- **Timeline**: Resolution within 24 hours
- **Stakeholder Updates**: Every 4 hours
- **Communication Channels**: Slack engineering channel

## 9. **Documentation & Learning**

### Post-Resolution Actions
- Update troubleshooting documentation
- Add monitoring/alerts to prevent recurrence
- Knowledge sharing session if complex issue
- Process improvement recommendations

Generate this comprehensive analysis to guide the engineering team's systematic approach to resolving the issue.