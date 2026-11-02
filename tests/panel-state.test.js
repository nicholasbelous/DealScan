// The side panel state machine as a pure reducer: its transitions, and results
// from an old run being dropped. The same races run on the real page in
// panel.browser.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_STATES, initialPanelState, isBusy, panelReducer } from "../src/shared/panel-state.js";

const run = (events, start = initialPanelState) => events.reduce(panelReducer, start);

const listing = (itemId, title = "Fake Bike") => ({ itemId, reliable: true, title, rejectReason: null });
const VERDICT_A = { score: 70, summary: "Verdict for A" };

const onListing = (itemId) => run([{ type: "navigated", itemId }, { type: "read-started" }]);

// A is being evaluated. `run` is the number the in-flight request will return with.
function evaluatingA() {
  let state = onListing("A");
  state = panelReducer(state, { type: "read-finished", run: state.run, listing: listing("A") });
  return panelReducer(state, { type: "evaluate-started" });
}

test("the states are exactly the ones in the spec", () => {
  assert.deepEqual(PANEL_STATES.slice().sort(), [
    "error", "evaluating", "not_marketplace", "reading", "ready", "rejected", "result",
  ]);
});

test("the normal path: not_marketplace, reading, ready, evaluating, result", () => {
  let state = initialPanelState;
  assert.equal(state.name, "not_marketplace");
  state = panelReducer(state, { type: "navigated", itemId: "A" });
  assert.equal(state.name, "reading");
  state = panelReducer(state, { type: "read-started" });
  state = panelReducer(state, { type: "read-finished", run: state.run, listing: listing("A") });
  assert.equal(state.name, "ready");
  state = panelReducer(state, { type: "evaluate-started" });
  assert.equal(state.name, "evaluating");
  state = panelReducer(state, { type: "evaluated", run: state.run, verdict: VERDICT_A });
  assert.equal(state.name, "result");
  assert.equal(state.verdict, VERDICT_A);
});

// --- The race ----------------------------------------------------------------------

test("RACE: a verdict that returns after moving to another listing is discarded", () => {
  const inFlight = evaluatingA();
  const moved = panelReducer(inFlight, { type: "navigated", itemId: "B" });

  const after = panelReducer(moved, { type: "evaluated", run: inFlight.run, verdict: VERDICT_A });

  assert.equal(after.name, "reading");
  assert.equal(after.itemId, "B");
  assert.equal(after.verdict, null);
  assert.equal(after.listing, null);
});

test("RACE: a late rejection or failure for the old listing is discarded too", () => {
  const inFlight = evaluatingA();
  const moved = panelReducer(inFlight, { type: "navigated", itemId: "B" });
  for (const late of [
    { type: "answer-rejected", run: inFlight.run, reason: "bad" },
    { type: "evaluation-failed", run: inFlight.run, message: "boom" },
  ]) {
    assert.equal(panelReducer(moved, late), moved);
  }
});

test("RACE: leaving Marketplace also discards it", () => {
  const inFlight = evaluatingA();
  const moved = panelReducer(inFlight, { type: "navigated", itemId: null });
  const after = panelReducer(moved, { type: "evaluated", run: inFlight.run, verdict: VERDICT_A });
  assert.equal(after.name, "not_marketplace");
  assert.equal(after.verdict, null);
});

test("RACE: going A to B and back to A still discards the old request", () => {
  const inFlight = evaluatingA();
  const back = run([{ type: "navigated", itemId: "B" }, { type: "navigated", itemId: "A" }], inFlight);
  const after = panelReducer(back, { type: "evaluated", run: inFlight.run, verdict: VERDICT_A });
  assert.equal(after.verdict, null);
  assert.equal(after.name, "reading");
});

test("RACE: a late read for the old listing is discarded", () => {
  const reading = onListing("A");
  const moved = panelReducer(reading, { type: "navigated", itemId: "B" });
  const after = panelReducer(moved, { type: "read-finished", run: reading.run, listing: listing("A") });
  assert.equal(after.name, "reading");
  assert.equal(after.listing, null);
});

test("RACE: a superseded evaluation of the same listing is discarded", () => {
  const first = evaluatingA();
  const again = panelReducer(first, { type: "evaluate-started" });
  const after = panelReducer(again, { type: "evaluated", run: first.run, verdict: VERDICT_A });
  assert.equal(after.name, "evaluating");
});

// --- Binding ---------------------------------------------------------------------

test("moving to another listing clears a shown result at once", () => {
  const inFlight = evaluatingA();
  const shown = panelReducer(inFlight, { type: "evaluated", run: inFlight.run, verdict: VERDICT_A });
  const moved = panelReducer(shown, { type: "navigated", itemId: "B" });
  assert.equal(moved.verdict, null);
  assert.equal(moved.listing, null);
  assert.equal(moved.name, "reading");
});

test("a navigation event for the same listing changes nothing", () => {
  const inFlight = evaluatingA();
  const shown = panelReducer(inFlight, { type: "evaluated", run: inFlight.run, verdict: VERDICT_A });
  assert.equal(panelReducer(shown, { type: "navigated", itemId: "A" }), shown);
});

test("a reliable read for a different item than the page is rejected", () => {
  const reading = onListing("A");
  const after = panelReducer(reading, { type: "read-finished", run: reading.run, listing: listing("B") });
  assert.equal(after.name, "rejected");
  assert.equal(after.listing, null);
});

// --- Rejected and error stay different ---------------------------------------------

test("a failed read is rejected, with its reason", () => {
  const reading = onListing("A");
  const after = panelReducer(reading, {
    type: "read-finished",
    run: reading.run,
    listing: { itemId: null, reliable: false, rejectReason: "Couldn't confirm." },
  });
  assert.equal(after.name, "rejected");
  assert.deepEqual(after.rejection, { kind: "read", reason: "Couldn't confirm." });
});

test("a bad model answer is rejected as an answer, which may have been billed", () => {
  const inFlight = evaluatingA();
  const after = panelReducer(inFlight, { type: "answer-rejected", run: inFlight.run, reason: "bad" });
  assert.equal(after.name, "rejected");
  assert.equal(after.rejection.kind, "answer");
});

test("a failure is an error, not a rejection", () => {
  const inFlight = evaluatingA();
  const after = panelReducer(inFlight, { type: "evaluation-failed", run: inFlight.run, message: "boom" });
  assert.equal(after.name, "error");
  assert.equal(after.errorMessage, "boom");
  assert.equal(after.rejection, null);
});

test("isBusy covers reading and evaluating only", () => {
  assert.equal(isBusy(onListing("A")), true);
  assert.equal(isBusy(evaluatingA()), true);
  assert.equal(isBusy(initialPanelState), false);
});
