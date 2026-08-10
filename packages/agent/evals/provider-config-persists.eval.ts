import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// The active model selection stays stable across sessions (a proxy for the
// restart-persistence property, which a single eval run cannot trigger).
export default defineEval({
  description: "Active model selection persists across sessions.",
  async test(t) {
    const expected = process.env.EVAL_ACTIVE_MODEL_ID ?? "claude-sonnet-5";
    await t.send("Reply with the exact model id you are running on.");
    t.succeeded();
    t.check(t.reply, includes(expected));
    await t.newSession();
    await t.send("Same question: reply with the exact model id again.");
    t.succeeded();
    t.check(t.reply, includes(expected));
  },
});
