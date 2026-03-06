# Custom Claude Commands

This directory contains custom slash commands for the WildAudience project.

## Available Commands

### `/bug-triage`

Analyzes and triages bug reports with structured recommendations.

**Usage:**
```
/bug-triage --description "Users can't login after password reset" --comment "This affects approximately 15% of users since yesterday's deployment"
```

**Parameters:**
- `--description` (required): Issue description
- `--comment` (optional): Additional comments or context

**Output (Comprehensive SOP-Based Analysis):**
- **Severity & Impact Assessment**: Critical/High/Medium/Low with business impact analysis
- **Component Classification**: Detailed system component mapping (Frontend, Backend, Database, Auth, Integrations, Infrastructure)
- **Root Cause Hypothesis**: Primary theory with supporting evidence + alternative hypotheses
- **Investigation Strategy**: TDD reproduction approach with safe production debugging protocol
- **Solution Approaches**: Multiple ranked solutions with implementation complexity and risk assessment
- **Testing & Validation Strategy**: Pre-deployment testing requirements and deployment strategy
- **Asana Task Creation**: Complete task template with definition of done checklist
- **Communication & Escalation Plan**: Stakeholder communication strategy based on severity
- **Documentation & Learning**: Post-resolution actions and knowledge sharing recommendations

**Key SOP Features:**
- **Production Safety**: Emphasizes read-only database access and safe debugging practices
- **TDD Approach**: Systematic test-driven reproduction of issues in local environment
- **Subagent Strategy**: Parallel investigation of multiple root cause theories
- **Comprehensive Testing**: Unit, integration, staging validation, and performance testing requirements

**Example:**
```
/bug-triage --description "Payment processing fails for European users" --comment "Started happening after the Stripe webhook update this morning"
```

## Future Enhancements

When MCP (Model Context Protocol) integration is available, this command will:
- Automatically create Asana tasks
- Link to relevant Loom transcripts
- Attach screenshots from bug reports
- Set up proper assignees and due dates

## Adding New Commands

1. Create a new `.md` file in this directory
2. Add frontmatter with `argument-hint` and `description`
3. Use `$1`, `$2`, etc. for parameter placeholders
4. Write clear instructions for Claude to follow