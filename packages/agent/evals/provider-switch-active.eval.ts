import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// Set EVAL_ACTIVE_MODEL_ID in the eval environment (Doppler) to the model the
// agent should report (default: the built-in fallback id).
export default defineEval({
  description: "The agent reports the model it is configured to use, matching the active provider/model selection.",
  async test(t) {
    await t.send("Which model id are you currently running on? Answer with the exact model id only.");
    t.succeeded();
    const expected = process.env.EVAL_ACTIVE_MODEL_ID ?? "claude-sonnet-5";
    t.check(t.reply, includes(expected));
  },
});
