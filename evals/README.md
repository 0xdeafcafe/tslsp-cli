# Skill regression evals

`pnpm run evals` runs every prompt in `skills/tslsp/evals/evals.json` against the current `skills/tslsp/SKILL.md`, scores each response, and logs the run to LangWatch as an experiment. The dashboard then shows two things: per-commit regression (this commit vs prior commits) and per-commit lift (skill-on vs skill-off).

## How a single run works

For each eval, for each model (`anthropic/claude-opus-4-7` and `anthropic/claude-sonnet-4-6`), the script runs two variants:

- `<model>-with-skill` - `SKILL.md` as the system prompt.
- `<model>-baseline` - empty system prompt. Tells us how much lift the skill actually provides; without it we only know whether SKILL.md got worse, not whether it's helping at all.

That's 4 agent calls per eval. Each response then goes through every scorer attached to the eval:

- `regex` - pattern match (cheap, deterministic).
- `llm_judge` - a second gateway call to `anthropic/claude-haiku-4-5` asks "did this response meet the criterion? PASS/FAIL".

Every scorer outcome is logged to the LangWatch experiment with the target name as the comparison axis, so the dashboard renders per-target bar charts and per-target trend lines.

## Tracing

There is none on the client. Every call we make through `gateway.langwatch.ai` is traced server-side by the gateway itself - they show up in the LangWatch project as proper LLM traces without any OTel scaffolding in this repo. Adding our own spans would just produce a second, thinner trace tree.

## Running it

### Locally

```bash
export LANGWATCH_API_KEY=...                    # from https://app.langwatch.ai → settings
export LANGWATCH_PROJECT_ID=...                 # only if API key is a service / PAT key
export LANGWATCH_VIRTUAL_AI_KEY=vk-lw-...       # from https://app.langwatch.ai → AI Gateway → Virtual Keys
pnpm run evals
```

The script prints a per-scorer pass/fail summary (sorted so each `eval.scorer` block shows its four variant rows together) and a dashboard link. It always exits 0 - regressions are read visually from the dashboard rather than failing CI.

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

The schema diverges deliberately from `/skill-creator`'s `expectations` (an array of natural-language assertions). `scorers` with a `type` discriminator lets us mix cheap regex with judge-only checks per eval, which matches what we actually want for routing-skill scoring (some checks are mechanical, some need a model).

## Why this shape

A routing skill (one that lives in another agent's context, like ours) isn't a runnable agent in the LangWatch SDK's usual sense. We wrap it: the "agent" is the gateway call with `SKILL.md` as the system prompt, the "input" is the eval prompt, the "output" is whatever the model produces. Scorers check whether the skill routed correctly.

The with-skill / baseline split is borrowed from the `/skill-creator` workflow. Their iteration loop spawns subagents both ways to compare; we mirror that inside one LangWatch experiment so the comparison is permanent on the dashboard rather than living only in a local iteration run.

## Why nothing else is in LangWatch

We deliberately don't mirror `SKILL.md` into LangWatch Prompts or `evals.json` into LangWatch Datasets. They look like good homes, but:

- `SKILL.md` ships inside the npm package and gets copied into user installs via `tslsp-cli install --skills`. The canonical copy has to stay in the repo, and the eval has to run against the PR's on-disk version, not a server-fetched one.
- `evals.json` versions alongside `SKILL.md`. The whole point of `@evals` on a PR is that the eval set under test moves with the skill change. A web-UI-editable dataset would drift.

A mirror would only buy us cosmetic UI visibility, in exchange for an extra sync step that can fail in CI. LangWatch's job here is the experiment dashboard - the trend line across commits and the cross-variant comparison, which is the bit you genuinely want hosted and web-accessible rather than living in a git ref.
