// The side panel's state machine. Pure: every state is explicit, and all async
// work is bound to a run number.
//
// Each read or evaluation starts a new run, and moving to a different listing
// starts one too. A result that comes back with an old run number was computed
// for something the user has left, so it's dropped here, in one place. That's
// what stops one listing's verdict from appearing on another listing's page.

export const PANEL_STATES = [
  "not_marketplace",
  "ready",
  "reading",
  "evaluating",
  "result",
  "rejected",
  "error",
];

export const initialPanelState = {
  name: "not_marketplace",
  itemId: null,
  run: 0,
  listing: null,
  verdict: null,
  rejection: null,
  errorMessage: null,
};

// The same listing, with whatever it was showing cleared and a new run.
const fresh = (state, name, extra = {}) => ({
  ...initialPanelState,
  itemId: state.itemId,
  run: state.run + 1,
  name,
  ...extra,
});

// Events that finish async work name the run they belong to.
const FINISHES_A_RUN = new Set(["read-finished", "read-failed", "evaluated", "answer-rejected", "evaluation-failed"]);

export function panelReducer(state, event) {
  if (FINISHES_A_RUN.has(event.type) && event.run !== state.run) return state;

  switch (event.type) {
    case "navigated":
      // Same listing (the URL changed but not the item): keep what's on screen.
      if (event.itemId === state.itemId) return state;
      return fresh({ ...state, itemId: event.itemId }, event.itemId ? "reading" : "not_marketplace");

    case "read-started":
      return fresh(state, "reading");

    case "read-finished": {
      const { listing } = event;
      if (!listing.reliable) {
        return { ...state, name: "rejected", rejection: { kind: "read", reason: listing.rejectReason } };
      }
      if (listing.itemId !== state.itemId) {
        return { ...state, name: "rejected", rejection: { kind: "read", reason: "The page changed while it was being read." } };
      }
      return { ...state, name: "ready", listing };
    }

    case "read-failed":
    case "evaluation-failed":
      return { ...state, name: "error", errorMessage: event.message };

    case "evaluate-started":
      return { ...state, name: "evaluating", run: state.run + 1 };

    case "evaluated":
      return { ...state, name: "result", verdict: event.verdict };

    case "answer-rejected":
      return { ...state, name: "rejected", rejection: { kind: "answer", reason: event.reason } };

    default:
      return state;
  }
}

/** True while work is running, so a second click can't double-charge. */
export const isBusy = (state) => state.name === "reading" || state.name === "evaluating";
