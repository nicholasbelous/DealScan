// A fake Anthropic API for --mock runs and tests. Its numbers mean nothing and
// must never back a claim. Prices stay near the asking price, scores wander a
// little, and every seventh call returns garbage to exercise retries.

export function installMockApi() {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const text = body.messages[0].content.at(-1).text;
    const price = Number(text.match(/Asking price: \$?([\d.]+)/)?.[1] ?? 100);
    const score = 50 + (calls % 5);
    const answer =
      calls % 7 === 0
        ? "{not json"
        : JSON.stringify({
            score,
            verdict: "Fair",
            recommendation: "Negotiate",
            marketLow: price * 0.8,
            marketHigh: price * 1.2,
            suggestedOffer: price * 0.9,
            summary: "Mock answer.",
          });
    return {
      ok: true,
      json: async () => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: answer }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    };
  };
}
