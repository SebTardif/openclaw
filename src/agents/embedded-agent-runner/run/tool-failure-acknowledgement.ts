import { normalizeTextForComparison } from "../../embedded-agent-helpers.js";

const MUTATING_FAILURE_ACTION_PATTERN =
  "(?:write|edit|update|save|create|delete|remove|modify|change|apply|patch|move|rename|send|reply|message|run|execute|execution|command|script|shell|bash|exec|tool|action|operation|request|call|api|link)";
// Truthful negative outcomes models use when describing a failed mutation
// without the words "failed"/"failure" (see openclaw/openclaw#110153).
const MUTATING_FAILURE_OUTCOME_PATTERN =
  "(?:failed|failure|errored|rejected|refused|denied|blocked|bounced)";
const MUTATING_FAILURE_INABILITY_PATTERN = new RegExp(
  `\\b(?:couldn't|could not|can't|cannot|unable to|am unable to|wasn't able to|was not able to|were unable to)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN = new RegExp(
  `\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b.{0,100}\\b${MUTATING_FAILURE_OUTCOME_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN = new RegExp(
  `\\b${MUTATING_FAILURE_OUTCOME_PATTERN}\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN = new RegExp(
  `\\b(?:hit|encountered|ran into)\\b.{0,60}\\berror\\b.{0,100}\\b(?:while|trying to|when)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
// Successful statements that must not count as failure acknowledgement
// ("the update was not rejected", "never refused", "no denial", etc.).
const DID_NOT_FAIL_PATTERN = /\b(?:did not|didn't)\s+fail\b/u;
const NEGATED_FAILURE_PATTERN = /\b(?:no|not|without)\s+(?:failures?|errors?)\b/u;
const NEGATED_OUTCOME_PATTERN = new RegExp(
  `\\b(?:did not|didn't|does not|doesn't|was not|wasn't|were not|weren't|is not|isn't|are not|aren't|not|never|no|without)\\s+(?:been\\s+)?${MUTATING_FAILURE_OUTCOME_PATTERN}\\b|\\b(?:no|without)\\s+(?:rejection|refusal|denial|block(?:age)?|bounce)\\b`,
  "u",
);

/** Detect a user-visible acknowledgement that a mutating action did not complete. */
export function hasExplicitMutatingToolFailureAcknowledgement(text: string): boolean {
  const normalizedText = normalizeTextForComparison(text);
  if (!normalizedText) {
    return false;
  }
  // Negated success phrasing must win before positive outcome matching.
  if (
    DID_NOT_FAIL_PATTERN.test(normalizedText) ||
    NEGATED_FAILURE_PATTERN.test(normalizedText) ||
    NEGATED_OUTCOME_PATTERN.test(normalizedText)
  ) {
    return false;
  }
  if (MUTATING_FAILURE_INABILITY_PATTERN.test(normalizedText)) {
    return true;
  }
  return (
    MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN.test(normalizedText)
  );
}
