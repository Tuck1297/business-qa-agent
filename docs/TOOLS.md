# Tools: what's built and what to add

Research notes from 2026-10-24 on which tools a business question-answering agent needs beyond "query the database" and "search the documents", and in what order to add them.

## Built

| Tool | Step | What it does |
|---|---|---|
| Purpose and routing | `route` | Decisions API: purpose (choice), needs database / needs documents / is ambiguous (predicates) |
| Table or view selection | `select_table` | Decisions API choice over catalog descriptions, with "none" |
| Query planning | `build_query` | Structured plan limited to the table's columns and metrics, validated, one retry |
| Query execution | `run_query` | Read-only, timeout, row cap, truncation flag |
| Document search | `search_documents` | Cloudflare AI Search retrieval, top-N chunks with source keys |
| Clarifying question | `write_answer` (clarify mode) | Asks one follow-up instead of guessing when the question is too vague |
| Cited answer | `write_answer` | Streams an answer citing `[T1]` rows and `[D1]` passages; says what's missing |
| Catalog drafting | `npm run catalog:draft` | Skeleton catalog from `information_schema` |

## What to add next, in priority order

### 1. Value lookup (entity grounding)

**Problem:** people type "Northwind" or "the Lakeside account"; the data says "Northwind Traders, Inc.". Filters on guessed values return nothing.
**Tool:** before planning, for text columns marked `lookup: true` in the catalog, run `SELECT DISTINCT col … WHERE col ILIKE $1 LIMIT 10` for the names in the question and pass the matches to the planner.
**Why first:** grounding filter terms in stored values is one of the most cited fixes for data agents, and `sampleValues` only covers low-cardinality columns. Restrict lookups to columns every user may see.

### 2. Golden questions and few-shot examples

**Problem:** the planner sees a schema but no examples of good plans for your data.
**Tool:** a `examples.json` of question → plan pairs you've checked. Pick 2–4 by similarity to the incoming question (one per query shape) and include them in the planning prompt. The same file doubles as an **evaluation set**: run it on every change and track table-selection recall (aim for 95%+) separately from end-to-end accuracy.
**Evidence:** few-shot selection of this kind reached 86.6% execution accuracy on the Spider benchmark (DAIL-SQL); keep evaluation questions out of the example pool.

### 3. Follow-up questions (conversation context)

**Problem:** "and last year?" or "break that down by region" has no meaning on its own.
**Tool:** accept an optional `history` (previous question, chosen table, plan) and give it to routing and planning, so a follow-up can reuse and modify the last plan.

### 4. Charts

**Problem:** time series and rankings read better as charts.
**Tool:** when the result has a date bucket or a single measure across categories, return a chart spec (for example Vega-Lite) alongside the rows in the `run_query` step data. The client draws it; the model doesn't.

### 5. Multi-table questions

**Problem:** some questions span two areas (tickets per customer plan).
**Tool, simplest first:** (a) write a view for each common combination; (b) let table selection return the top two tables and plan two queries, then combine in the answer; (c) a reviewed join graph in the catalog so the planner can join along declared keys only. Never let the model invent join conditions.

### 6. Calculation

**Problem:** growth rates, shares and differences computed in prose are error-prone.
**Tool:** prefer metrics computed in SQL. For what can't be, a small deterministic calculator function the answer step can call (or OpenAI's hosted code-execution tool), with the calculation shown in the answer.

### 7. Full-document read

**Problem:** a passage says "see section 4.2" and the answer needs the rest of the document.
**Tool:** fetch the whole source object (the AI Search `item.key` in R2) when the top chunks all come from one document and don't answer the question.

### 8. Fiscal calendar and named periods

**Problem:** "Q3" or "this fiscal year" may not match the calendar year.
**Tool:** a `periods` section in the config (fiscal year start, named seasons) passed to the planner, or a calendar table in the database as a catalog table.

### 9. Web search (external facts)

**Problem:** "how does our late fee compare to the state limit?" needs outside information.
**Tool:** a separate web-search step (OpenAI's built-in web search tool works) whose results are cited as `[W1]` and never mixed up with internal data. Off by default.

### 10. Action tools, with approval

**Problem:** the natural next step after an answer is often an action: email the customers with overdue balances, open a ticket, schedule a follow-up.
**Tool:** separate write tools that only *draft* the action and require the user to approve it in the client. Keep the question-answering path read-only.

### 11. Guardrails and operations

- **Per-user access:** pass the caller's identity to the database (row-level security or per-user views). The catalog limits what can be queried, not who may see which rows.
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
