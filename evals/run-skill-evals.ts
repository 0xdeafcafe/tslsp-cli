/**
 * Run the tslsp skill regression evals against Opus + Sonnet, with and
 * without SKILL.md as the system prompt. Each eval becomes four chat
 * calls (2 models × {with-skill, baseline}); each scorer logs four
 * rows tagged by target so the LangWatch dashboard shows both
 * regression (this commit vs prior commits) and lift (with-skill vs
 * baseline).
 *
 * Tracing is handled by the AI Gateway itself - every call we make
 * through `gateway.langwatch.ai` becomes a trace in the LangWatch
 * project automatically. No client-side OTel instrumentation here.
 *
 * Env:
 *   LANGWATCH_API_KEY           SDK auth for `experiments.init`.
 *   LANGWATCH_PROJECT_ID        Required when the API key is a
 *                               service / PAT key.
 *   LANGWATCH_VIRTUAL_AI_KEY    Virtual key (vk-lw-...) from
 *                               AI Gateway → Virtual Keys. Used for
 *                               every model call (agent + judge).
 *   GITHUB_SHA, GITHUB_PR_NUMBER  Optional metadata to tag the run.
 *
 * Run locally:
 *   pnpm run evals
 *
 * Always exits 0 (informational, not a CI gate).
 * Inspect trends in https://app.langwatch.ai → Experiments.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LangWatch } from "langwatch";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_MD_PATH = resolve(ROOT, "skills/tslsp/SKILL.md");
const EVALS_PATH = resolve(ROOT, "skills/tslsp/evals/evals.json");

const GATEWAY_URL = "https://gateway.langwatch.ai/v1/chat/completions";
const MODELS = ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6"];
const JUDGE_MODEL = "anthropic/claude-haiku-4-5";

interface RegexScorer {
  type: "regex";
  name: string;
  pattern: string;
}
interface LlmJudgeScorer {
  type: "llm_judge";
  name: string;
  criterion: string;
}
type Scorer = RegexScorer | LlmJudgeScorer;

interface Eval {
  id: number;
  eval_name: string;
  prompt: string;
  scorers: Scorer[];
}

interface EvalsFile {
  skill_name: string;
  description?: string;
  evals: Eval[];
}

const vk = process.env.LANGWATCH_VIRTUAL_AI_KEY;
if (!vk) {
  console.error(
    "LANGWATCH_VIRTUAL_AI_KEY is required. Mint a virtual key in the LangWatch app under AI Gateway → Virtual Keys and export it as LANGWATCH_VIRTUAL_AI_KEY.",
  );
  process.exit(2);
}
if (!process.env.LANGWATCH_API_KEY) {
  console.error("LANGWATCH_API_KEY is required for experiment logging.");
  process.exit(2);
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

class GatewayError extends Error {
  // Plain field instead of a constructor parameter property: Node's
  // --experimental-strip-types is strip-only and doesn't desugar that
  // form.
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** Sleep with jittered backoff. */
function backoff(attempt: number): Promise<void> {
  const baseMs = 500 * 2 ** attempt;
  const jitterMs = Math.floor(Math.random() * 250);
  return new Promise((r) => setTimeout(r, baseMs + jitterMs));
}

/** One call into the gateway. The agent cap is generous enough to fit a
 * multi-paragraph response with a command at the end; judge calls override
 * to a much smaller cap since they answer PASS/FAIL on one line. */
async function chat(
  model: string,
  system: string,
  user: string,
  maxTokens = 2048,
): Promise<string> {
  // An empty system prompt means "no skill" - the baseline variant. Drop
  // the role entirely so the model isn't biased by a default the gateway
  // might inject for an empty system message.
  const messages =
    system.length > 0
      ? [
          { role: "system", content: system },
          { role: "user", content: user },
        ]
      : [{ role: "user", content: user }];
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens });

  // Retry transient failures: network errors and 5xx from the gateway.
  // 4xx is the caller's fault (auth, model name, oversized request) and
  // won't fix itself on retry, so let those throw immediately.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vk}`,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new GatewayError(`gateway ${res.status} for ${model}: ${text}`, res.status);
        if (res.status >= 500 && attempt < maxAttempts - 1) {
          lastErr = err;
          await backoff(attempt);
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as ChatResponse;
      return json.choices[0]?.message?.content ?? "";
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      // Network / DNS / abort - retry.
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await backoff(attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function scoreRegex(response: string, scorer: RegexScorer): { score: number; details: string } {
  const matched = new RegExp(scorer.pattern, "i").test(response);
  return {
    score: matched ? 1 : 0,
    details: matched ? `matched /${scorer.pattern}/i` : `no match for /${scorer.pattern}/i`,
  };
}

async function scoreLlmJudge(
  response: string,
  scorer: LlmJudgeScorer,
  promptForContext: string,
): Promise<{ score: number; details: string }> {
  const judgePrompt = [
    "You are evaluating an AI agent's response to a user task.",
    "",
    `User task: ${promptForContext}`,
    "",
    "Agent response:",
    '"""',
    response,
    '"""',
    "",
    `Criterion: ${scorer.criterion}`,
    "",
    'Reply on a single line: "PASS - <one-sentence reason>" or "FAIL - <one-sentence reason>".',
  ].join("\n");
  const verdict = await chat(
    JUDGE_MODEL,
    "You are a precise binary evaluator. Output PASS or FAIL with one short reason.",
    judgePrompt,
    200,
  );
  const trimmed = verdict.trim();
  const passed = /^pass\b/i.test(trimmed);
  return { score: passed ? 1 : 0, details: trimmed.slice(0, 240) };
}

const skillMd = await readFile(SKILL_MD_PATH, "utf8");
const evalsFile = JSON.parse(await readFile(EVALS_PATH, "utf8")) as EvalsFile;

const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7) || "local";
const pr = process.env.GITHUB_PR_NUMBER ?? "";
const runId = pr ? `pr-${pr}-${sha}` : sha;
const experimentName = `${evalsFile.skill_name}-skill-evals`;

const langwatch = new LangWatch();
const experiment = await langwatch.experiments.init(experimentName, { runId });
console.log(`LangWatch experiment: ${experimentName} (run ${runId})`);

// The lift baseline: an empty system prompt isolates the skill's
// contribution. Each eval row runs against both variants per model.
const VARIANTS = [
  { suffix: "with-skill", system: skillMd },
  { suffix: "baseline", system: "" },
] as const;

interface DatasetRow {
  index: number;
  eval: Eval;
  model: string;
  variant: (typeof VARIANTS)[number];
}

const dataset: DatasetRow[] = evalsFile.evals.flatMap((ev, ei) =>
  MODELS.flatMap((model, mi) =>
    VARIANTS.map((variant, vi) => ({
      index: ei * MODELS.length * VARIANTS.length + mi * VARIANTS.length + vi,
      eval: ev,
      model,
      variant,
    })),
  ),
);

let passes = 0;
let fails = 0;
const lines: string[] = [];

await experiment.run(dataset, async ({ item, index }) => {
  const { eval: ev, model, variant } = item;
  const modelShort = model.split("/").pop() ?? model;
  const targetName = `${modelShort}-${variant.suffix}`;
  const targetMetadata = { model, skill: variant.suffix === "with-skill" };

  let response: string;
  try {
    response = await chat(model, variant.system, ev.prompt);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    lines.push(`  ${ev.eval_name} [${targetName}]  agent call FAILED: ${msg}`);
    experiment.log("agent_call_error", {
      index,
      score: 0,
      details: msg,
      target: targetName,
      metadata: targetMetadata,
    });
    return;
  }

  for (const scorer of ev.scorers) {
    let result: { score: number; details: string };
    try {
      result =
        scorer.type === "regex"
          ? scoreRegex(response, scorer)
          : await scoreLlmJudge(response, scorer, ev.prompt);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      lines.push(`  ${ev.eval_name}.${scorer.name} [${targetName}]  scorer error: ${msg}`);
      experiment.log(`${ev.eval_name}.${scorer.name}`, {
        index,
        score: 0,
        details: `scorer error: ${msg}`,
        target: targetName,
        metadata: targetMetadata,
      });
      continue;
    }
    if (result.score) passes++;
    else fails++;
    const flag = result.score ? "PASS" : "FAIL";
    lines.push(`  ${flag}  ${ev.eval_name}.${scorer.name} [${targetName}]  ${result.details}`);
    experiment.log(`${ev.eval_name}.${scorer.name}`, {
      index,
      score: result.score,
      passed: result.score === 1,
      details: result.details,
      target: targetName,
      metadata: targetMetadata,
    });
  }
});

console.log("");
console.log(`Results (${passes + fails} scorers, ${passes} pass / ${fails} fail):`);
// Group output by eval + scorer so with-skill vs baseline reads cleanly.
lines.sort();
for (const l of lines) console.log(l);
console.log("");
console.log(`Dashboard: https://app.langwatch.ai`);

process.exit(0);
