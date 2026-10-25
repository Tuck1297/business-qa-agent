# Architecture

## Layout

```
src/
  main.ts                    wires config → clients → agent → HTTP + WebSocket
  config.ts                  environment variables, validated, with safe defaults
  events.ts                  the event types every transport sends; runStep() wraps each step
  llm/
    types.ts                 LlmClient interface (decide / callTools / streamText)
    openai.ts                fetch-based OpenAI client: Decisions API + Responses API (+ SSE parser)
  agent/
    router.ts                purpose + which routes (one Decisions call)
    agent.ts                 orchestrator: branches in parallel, answer streamed through the merger
    answer.ts                answer prompts (grounded / clarify / general) and citations
  merge/
    merge.ts                 merge-field grammar, value formatting, streaming merger
  tools/
    database/
      definitions.ts         tools.json format and validation
      sql.ts                 :named params → $n::type / @p_name, row cap
      arguments.ts           tool → strict function schema; argument validation
      service.ts             runs a tool: bind, cap, one connection pool per source
      tool.ts                select_tools → plan_tool_calls → run_tool × N
      adapters/              pg (read-only transaction) and mssql (typed params)
    documents/
      aiSearch.ts            Cloudflare AI Search /search client
  server/
    http.ts                  /health, /ask, /ask/stream (SSE), demo page
    ws.ts                    /ws protocol
scripts/check-tools.ts       validate tools.json; optionally run each example
public/index.html            demo page (no build, no external assets)
```

Only `pg`, `mssql` and `ws` are runtime dependencies, each loaded lazily, so the core runs and tests without them. OpenAI and Cloudflare are called with `fetch`.

## The database route

### Principle

The agent can only reach the database through tools you wrote, and the model provider never receives what the database returns.

| Step | API | What the model sees | What it decides |
|---|---|---|---|
| `select_tools` | **Decisions**, one predicate per tool | Question, today, each tool's name and description | Which tools are likely relevant (probabilities) |
| `plan_tool_calls` | **Responses, function calling** (`tool_choice: required`) | Question, today, the shortlisted tools as functions (description + parameter schema) | Which tools to call and with what arguments |
| `run_tool` | none | nothing | — (your SQL runs with the validated arguments) |
| `write_answer` | **Responses, streamed** | Question, call ids, arguments, field names/formats/descriptions, `resultDescription`, document passages | The wording, with merge fields where values go |

### Why two model calls to pick tools

- OpenAI's guidance is to keep fewer than 20 functions available at a time. The Decisions call scores every tool (up to 400 in one request) cheaply and returns probabilities, and only the top tools above `TOOL_SELECT_THRESHOLD` (max 8) are offered for function calling.
- The Decisions step also makes "no tool fits" explicit: if nothing clears the threshold, no SQL runs and the answer says so.
- The selection probabilities show up in the `select_tools` step, which helps when tuning descriptions.

### Why function calling for parameters

It's the API built for "choose a tool and fill its arguments", and it lets the model call one tool several times (two periods to compare). Each tool becomes a strict function schema: every parameter listed as required, optional ones nullable, enums carried over. The service validates the arguments again (types, required, enum, min/max, max length, real calendar dates) because they become SQL parameters, and retries once with the exact problems if they're wrong. The calls are never answered with `function_call_output`; results don't go back to the model.

### Binding

`:name` placeholders are found by a small scanner that skips strings, quoted identifiers, comments and Postgres `::` casts. Postgres gets `($n::type)`, so a NULL optional parameter has a type (`$1 IS NULL` alone would fail) and a parameter used twice is one bind value. SQL Server gets `@p_name` with explicit mssql types (dates bound as `Date`, strings as `NVarChar(4000)`).

Row caps: Postgres wraps the statement (`SELECT * FROM (…) AS capped_result LIMIT n+1`); SQL Server uses `SET ROWCOUNT n+1`, which keeps a top-level `ORDER BY` and `WITH` working where a subquery wrapper wouldn't. The extra row detects truncation.

The pg adapter returns `DATE` columns as `YYYY-MM-DD` text, because by default pg turns them into JS Dates at the server's local midnight, which can shift the day after conversion to UTC.

## Merge fields

The answer model writes a template. `src/merge/merge.ts` fills it:

| Field | Value |
|---|---|
| `{{call.field}}` / `{{call[n].field}}` | One cell, formatted by the field's `format` |
| `{{table call}}` | Markdown table: labels, right-aligned numbers, escaped pipes, "showing the first N rows" when capped |
| `{{count call}}` | Row count, `N+` when capped |
| `{{list call.field}}` | `Intl.ListFormat` list, "and more" when capped |
| `{{sum/avg/min/max call.field}}` | Computed over the rows, formatted like the field |

Formatting uses `Intl` with `LOCALE`, `CURRENCY` and `TIMEZONE`. Dates are read as calendar dates (no time-zone shift); `datetime` is shown in `TIMEZONE`.

**Streaming.** `StreamingMerger` holds back text from an unclosed `{{` until its `}}` arrives (or 200 characters pass), so each `answer.delta` contains finished text with values filled in and never a raw or half merge field. After the stream ends, the full template is rendered once more for the authoritative `run.completed.answer` (tidier spacing), and a truncation note is appended if any referenced result hit its cap.

**Failure modes.** Empty results become `—` / "No matching records"; failed calls and unknown references become `[unavailable]` and are listed in `merge.unresolved`. A failed call is described to the model as unavailable, without the database error text.

## What the model can and can't do with hidden values

It can't compare or interpret numbers it never sees, so the prompt tells it to present values and only call a row "the largest" or "the latest" when `resultDescription` states the order. That pushes logic into the place where it's exact: your SQL (computed columns, ordering) and the deterministic aggregates in merge fields.

## Documents route

Unchanged: AI Search's retrieval-only `/search` endpoint returns chunks (text, source key, score). They go into the answer prompt as passages cited `[D1]`, because an answer about documents needs their text. The client accepts the REST envelope (`{ success, result: { chunks } }`) and the bare Workers-binding shape.

## Streaming and transports

`runStep()` wraps every step and emits `step.started`, then `step.completed` (with a `data` summary) or `step.failed`. Each event carries a `key` so repeated steps (`run_tool:revenue_by_month`, `run_tool:revenue_by_month_2`) stay distinct.

- `POST /ask` collects the events and returns them with the result (without `answer.delta`).
- `POST /ask/stream` writes each event as SSE, with a keep-alive comment every 15 s and `X-Accel-Buffering: no`.
- `/ws` sends each as JSON tagged with the client's `requestId`; `cancel` aborts through an `AbortSignal` that reaches every outbound request.

## Failure handling

- The database and document branches run with `Promise.allSettled`, and tool calls run in parallel. A failure becomes a `step.failed` event; the run still completes.
- Routing or answer-writing failures end the run with `run.failed`.
- A failed database connection is forgotten, so the next question retries it.
- Model refusals and cut-off outputs surface as clear errors.
