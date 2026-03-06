---
tracker:
  kind: asana
  endpoint: https://app.asana.com/api/1.0
  api_key: $ASANA_ACCESS_TOKEN
  project_id: "1213541042456827"
  active_states:
    - Ready to start
    - In Progress
  terminal_states:
    - Shipped
polling:
  interval_ms: 15000
workspace:
  root: ~/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 $SOURCE_REPO_URL .
    npm install
agent:
  max_concurrent_agents: 5
  max_turns: 20
claude:
  model: claude-sonnet-4-20250514
server:
  port: 4000
---

You are working on Asana task `{{ issue.identifier }}`

**Title:** {{ issue.title }}
**Status:** {{ issue.state }}
**URL:** {{ issue.url }}

{% if issue.description %}
**Description:**
{{ issue.description }}
{% endif %}

{% if attempt %}
This is continuation attempt #{{ attempt }}. Resume from current workspace state.
{% endif %}

Complete the task described above. When done, commit your changes and create a pull request.
