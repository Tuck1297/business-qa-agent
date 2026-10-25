# Tools: what's built and what to add

Research notes from 2026-10-24 on which tools a business question-answering agent needs beyond "query the database" and "search the documents", and in what order to add them.

## Built

| Tool | Step | What it does |
|---|---|---|
| Purpose and routing | `route` | Decisions API: purpose (choice), needs database / needs documents / is ambiguous (predicates) |
| Tool selection | `select_tools` | Decisions API predicate per database tool you defined; top tools above a threshold go forward |
| Parameter filling | `plan_tool_calls` | Function calling over the shortlist; arguments validated, one retry |
| Your SQL | `run_tool` | Read-only, timeout, row cap, truncation flag; one step per call |
| Document search | `search_documents` | Cloudflare AI Search retrieval, top-N chunks with source keys |
| Clarifying question | `write_answer` (clarify mode) | Asks one follow-up instead of guessing when the question is too vague |
| Templated answer + merge | `write_answer` | Model writes merge fields; the service fills values, so rows never reach the model |
| Tool checking | `npm run tools:check` | Validates tools.json; `--run` executes each example and compares returned columns to declared outputs |

## What to add next, in priority order

### 1. Value lookup (entity grounding)

**Problem:** people type "Northwind" or "the Lakeside account"; the data says "Northwind Traders, Inc.". Filters on guessed values return nothing.
**Tool:** tool parameters take whatever text the model extracts from the question, so make matching forgiving in your SQL (`customer_name ILIKE '%' || :customer || '%'`), or add a `find_customer` tool that returns candidate names for the user to pick from. A built-in step could go further: let a parameter declare `"lookup": "SELECT DISTINCT customer_name FROM … WHERE customer_name ILIKE :q LIMIT 10"`, run it before function calling, and offer the matches as the parameter's enum. **Note:** that step would show stored names to the model, so make it opt-in per parameter.
**Why first:** grounding filter terms in stored values is one of the most cited fixes for data agents.

### 2. Golden questions and few-shot examples

**Problem:** the model picks tools and arguments from descriptions alone.
**Tool:** an `examples.json` of question → tool calls (and a good answer template) you've checked. Pick 2–4 by similarity to the incoming question (one per query shape) and include them in the planning prompt. The same file doubles as an **evaluation set**: run it on every change and track table-selection recall (aim for 95%+) separately from end-to-end accuracy.
**Evidence:** few-shot selection of this kind reached 86.6% execution accuracy on the Spider benchmark (DAIL-SQL); keep evaluation questions out of the example pool.

### 3. Follow-up questions (conversation context)

**Problem:** "and last year?" or "break that down by region" has no meaning on its own.
**Tool:** accept an optional `history` (previous question, tool calls and arguments, answer template; never the rows) and give it to routing and parameter filling, so a follow-up can reuse and adjust the last calls.

### 4. Charts

**Problem:** time series and rankings read better as charts.
**Tool:** a `{{chart call}}` merge field, or a `chart` hint on the tool (x field, y field, type), so the service returns a chart spec (for example Vega-Lite) built from the rows. The client draws it; the model never sees the values.

### 5. Questions that span tools

**Problem:** "tickets per customer plan" needs data from two areas, but merge fields can't join rows from two calls.
**Tool:** write a tool (over a view) for the combination. Because every query is yours, cross-area questions are answered by adding tools, not by letting the model join.

### 6. Calculation

**Problem:** growth rates, shares and differences computed in prose are error-prone.
**Tool:** compute in your SQL (a `growth_pct` column) or with the `sum`/`avg`/`min`/`max` merge fields. A next step: expression merge fields such as `{{pct revenue_by_month_2.revenue revenue_by_month.revenue}}`, computed by the service, so comparisons work without the model seeing values.

### 7. Full-document read

**Problem:** a passage says "see section 4.2" and the answer needs the rest of the document.
**Tool:** fetch the whole source object (the AI Search `item.key` in R2) when the top chunks all come from one document and don't answer the question.

### 8. Fiscal calendar and named periods

**Problem:** "Q3" or "this fiscal year" may not match the calendar year.
**Tool:** a `periods` section in the config (fiscal year start, named seasons) passed to the parameter-filling step, or a calendar table your tools join to.

### 9. Web search (external facts)

**Problem:** "how does our late fee compare to the state limit?" needs outside information.
**Tool:** a separate web-search step (OpenAI's built-in web search tool works) whose results are cited as `[W1]` and never mixed up with internal data. Off by default.

### 10. Action tools, with approval

**Problem:** the natural next step after an answer is often an action: email the customers with overdue balances, open a ticket, schedule a follow-up.
**Tool:** separate write tools that only *draft* the action and require the user to approve it in the client. Keep the question-answering path read-only.

### 11. Guardrails and operations

- **Per-user access:** pass the caller's identity to the database (row-level security or per-user views). Tools limit what can be queried, not who may see which rows.
- **Cost guard:** run `EXPLAIN` first on large tables and refuse plans above a cost threshold.
- **Feedback and logging:** store question, route, table, plan, SQL, row count, latency and a thumbs-up/down, without the row data, to find weak spots and grow the golden set.
- **Expose as an MCP server:** wrap `ask` as an MCP tool so Claude, ChatGPT or other agents can use the same governed path into your data.

## Sources

- OpenAI, Decisions API guide: <https://developers.openai.com/api/docs/guides/decisions>
- OpenAI, Structured Outputs: <https://developers.openai.com/api/docs/guides/structured-outputs>
- OpenAI, Streaming responses: <https://developers.openai.com/api/docs/guides/streaming-responses>
- Cloudflare, AI Search REST API (search): <https://developers.cloudflare.com/ai-search/api/search/rest-api/>
- Cloudflare, AI Search result controls: <https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/>
- Cloudflare, migrating from the AutoRAG API: <https://developers.cloudflare.com/ai-search/how-to/migrate-from-autorag-api>
- Data Lakehouse Hub, schema pruning and few-shot SQL selection for data agents: <https://datalakehousehub.com/blog/schema-pruning-few-shot-sql-data-agents/>
- Atlan, text-to-SQL vs a semantic layer for self-serve analytics: <https://atlan.com/know/ai-agent/semantic-layer/text-to-sql-vs-semantic-layer-for-self-serve-analytics/>
