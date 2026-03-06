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
    echo "workspace created"
  timeout_ms: 30000
agent:
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 120000
claude:
  model: claude-sonnet-4-20250514
server:
  port: 4000
---

You are working on Asana task `{{ issue.identifier }}`

**Title:** {{ issue.title }}
**Status:** {{ issue.state }}

{% if issue.description %}
**Description:**
{{ issue.description }}
{% endif %}

{% if attempt %}
This is continuation attempt #{{ attempt }}.
{% endif %}

Complete the task described above.
