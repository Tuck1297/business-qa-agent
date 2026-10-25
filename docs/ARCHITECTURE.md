# Architecture

## Layout

```
src/
  main.ts                    wires config → clients → agent → HTTP + WebSocket
  config.ts                  environment variables, with validation and safe defaults
  events.ts                  the event types every transport sends; runStep() wraps each step
  llm/
    types.ts                 LlmClient interface (decide / structured / streamText)
    openai.ts                fetch-based OpenAI client: Decisions API + Responses API (+ SSE parser)
  agent/
    router.ts                step 1: purpose + which tools (one Decisions call)
    agent.ts                 orchestrator: runs the branches in parallel, then the answer
    answer.ts                answer prompts (grounded / clarify / general) and citations
  tools/
    database/
      catalog.ts             catalog format, validation, table descriptions for selection
      spec.ts                the query plan: strict JSON Schema per table + validator
      compile.ts             plan → parameterized SQL, Postgres and SQL Server dialects
      service.ts             one adapter per source, truncation, JSON-safe rows
      tool.ts                select_table → build_query → run_query
      adapters/              pg (read-only transaction) and mssql
    documents/
      aiSearch.ts            Cloudflare AI Search /search client
  server/
    http.ts                  /health, /ask, /ask/stream (SSE), demo page
    ws.ts                    /ws protocol
scripts/draft-catalog.ts     catalog skeleton from information_schema
public/index.html            demo page (no build, no external assets)
```

Only `pg`, `mssql` and `ws` are runtime dependencies, and each is loaded lazily, so the core runs and tests without them. OpenAI and Cloudflare are called with `fetch`.

## Why each model call is the kind it is

| Step | API | Why |
|---|---|---|
| Route | **Decisions** | The output is a choice and three yes/no probabilities, not text. Decisions returns typed answers with probabilities, reportedly about 10× faster than a Responses call, priced on input tokens only, and several independent questions share one call. |
| Select table | **Decisions** | A choice among your tables, with descriptions as the options, plus "none". The confidence and runner-up probabilities are surfaced in the step data. |
| Build query | **Responses + Structured Outputs** | The plan is a generated object (columns, filters, sort, limit). A strict JSON Schema built per table makes column and metric names enums, so the model can't reference anything outside the catalog. |
| Write answer | **Responses, streamed** | Free text with citations, streamed token by token to the client. |

Thresholds for the Decisions answers are configurable (`ROUTE_PREDICATE_THRESHOLD`, `ROUTE_CLARIFY_THRESHOLD`, `TABLE_CONFIDENCE_WARNING`). Routing leans toward recall: a tool is used if *either* the purpose or its predicate calls for it, because an unneeded lookup costs less than a missing one.

## Why a query plan instead of SQL

Text-to-SQL failures are mostly wrong tables, wrong joins and wrong metric definitions, not syntax, and they look like plausible wrong answers. The plan approach narrows what can go wrong:

- **Allowlist by construction.** Identifiers come from the catalog only and are always quoted. Values are always bound parameters. The output is always one `SELECT … LIMIT/TOP`.
- **Governed metrics.** Business calculations live in the catalog as SQL you wrote (`revenue`, `outstanding_balance`); the model picks them by name, so "revenue" means the same thing every time.
- **Validation with one retry.** Cross-field rules a schema can't express (sum needs a numeric column, `between` needs two values, dates must be real dates) are checked after generation. On failure, the exact problems go back to the model once.
- **Automatic grouping.** Plain columns selected next to an aggregate become the GROUP BY, which removes a whole class of invalid queries.
- **Dialect details handled once.** Postgres `date_trunc` vs SQL Server `DATEFROMPARTS`; Monday-start weeks on both regardless of `@@DATEFIRST`; SQL Server integer `SUM`/`AVG` cast to avoid overflow and truncation; `LIKE` wildcards escaped per dialect.

The trade-off: one table or view per question, and only the operations the plan supports. Views cover most join needs; see [TOOLS.md](TOOLS.md) for multi-table planning.

## Why retrieval-only AI Search

AI Search can also generate answers (`/chat/completions`), but then database figures and document passages would be answered separately. Using `/search` returns chunks only (text, source key, score), and one answer step cites both. The client accepts both the REST envelope (`{ success, result: { chunks } }`) and the bare Workers-binding shape.

## Streaming

`runStep()` wraps every step and emits `step.started`, then `step.completed` (with a `data` summary) or `step.failed`. Transports only serialize events:

- `POST /ask` collects them and returns them with the answer (without `answer.delta`).
- `POST /ask/stream` writes each as an SSE event (`event: <type>`), with a keep-alive comment every 15 s and `X-Accel-Buffering: no` so proxies don't hold events back.
- `/ws` sends each as a JSON message tagged with the client's `requestId`; `cancel` aborts the run through an `AbortSignal` that reaches every outbound request.

Client disconnects abort the run the same way.

## Failure handling

- The database and document branches run with `Promise.allSettled`. A failure becomes a `step.failed` event and a note in the answer prompt ("the document search failed …"), and the run still completes.
- Routing or answer-writing failures end the run with `run.failed`.
- A failed database connection is forgotten, so the next question retries it.
- Model refusals and cut-off outputs surface as clear errors instead of half-parsed JSON.
