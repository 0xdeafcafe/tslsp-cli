# Skill regression evals

`pnpm run evals` runs every prompt in `skills/tslsp/evals/evals.json` against the current `skills/tslsp/SKILL.md`, scores each response, and logs the run to LangWatch as an experiment. Trends across commits show up on the LangWatch dashboard, so a PR that makes the skill worse is visible the moment it lands.

## How a single run works

For each eval, for each model (`anthropic/claude-opus-4-7` and `anthropic/claude-sonnet-4-6`):

1. The script calls the **LangWatch AI Gateway** with `SKILL.md` as the system prompt and the eval's `prompt` as the user message.
2. Each scorer attached to the eval runs against the response:
   - `regex` - pattern match (cheap, deterministic).
   - `llm_judge` - a second gateway call to `anthropic/claude-haiku-4-5` asks "did this response meet the criterion? PASS/FAIL".
3. Every scorer outcome is logged to the LangWatch experiment with the model name as the target, so the dashboard can render per-model bar charts and trends.

## Running it

### Locally

```bash
export LANGWATCH_API_KEY=...                    # from https://app.langwatch.ai → settings
export LANGWATCH_PROJECT_ID=...                 # only if API key is a service / PAT key
export LANGWATCH_VIRTUAL_AI_KEY=vk-lw-...       # from https://app.langwatch.ai → AI Gateway → Virtual Keys
pnpm run evals
```

The script prints a per-scorer pass/fail summary and a dashboard link. It always exits 0 (the experiment is informational). Treat regressions visually via the LangWatch dashboard.

### From a PR

Comment `@evals` on any PR. The `.github/workflows/skill-evals.yml` workflow picks up the comment, checks out the PR's head, runs the evals against that commit, and posts the result back as a follow-up comment with a link to the experiment.

Opt-in by design: not every PR touches the skill, so we don't burn API tokens by default. Comment `@evals` when you've changed `skills/tslsp/SKILL.md` or anything in `src/` that an agent reading the skill would care about.

## Adding a new eval

Edit `skills/tslsp/evals/evals.json`. Each entry needs:

- `id` - unique integer.
- `eval_name` - kebab-case, short. Becomes part of the scorer keys in LangWatch.
- `prompt` - the user message (write it like a real user request, not abstract).
- `scorers` - an array of `regex` or `llm_judge` entries. Multiple per eval is fine; each becomes a separate logged metric.

Rule of thumb: prefer `regex` for "did the agent reach for this specific command", `llm_judge` for "did the agent's reasoning preserve some invariant" (e.g. "didn't over-query", "preserved a referenced binding").

## Why this shape

A routing skill (one that lives in another agent's context, like ours) isn't a runnable agent in the LangWatch SDK's usual sense. We wrap it: the "agent" is the gateway call with `SKILL.md` as the system prompt, the "input" is the eval prompt, the "output" is whatever the model produces. Scorers check whether the skill routed correctly.

## A note on LangWatch Prompts vs Datasets

LangWatch has two separate features that look like they could host this stuff. They don't fit, for opposite reasons:

- **LangWatch Prompts** (versioned system-prompt management) - tempting home for SKILL.md, but SKILL.md ships inside the npm package and gets copied into user installs via `tslsp-cli install --skills`. The canonical copy has to stay in the repo.
- **LangWatch Datasets** (test data, editable in the web UI) - tempting home for the eval prompts, but they version alongside SKILL.md. Changing the skill and the evals together in one commit is the whole point. A web-UI dataset drifts away from the code reviewing it.

Both stay in the repo. LangWatch's job here is the experiment dashboard - the trend line across commits, which is the bit you genuinely want hosted and web-accessible rather than living in a git ref.
