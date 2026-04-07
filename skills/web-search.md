---
name: web-search
description: Search the web using DuckDuckGo and summarize results
when-to-use: When you need to find current information from the internet
arguments: [query, max_results]
allowed-tools:
  - Search
---

# Web Search Skill

Search the web for information using DuckDuckGo.

**Query**: $QUERY
**Max Results**: ${MAX_RESULTS:-5}

Use the Search tool to find information about: $QUERY

Return up to ${MAX_RESULTS:-5} results and provide a concise summary of the findings.
