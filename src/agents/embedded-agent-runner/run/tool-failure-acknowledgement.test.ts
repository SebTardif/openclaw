// Regression coverage for mutating-tool failure acknowledgement vocabulary (#110153).
import { describe, expect, it } from "vitest";
import { hasExplicitMutatingToolFailureAcknowledgement } from "./tool-failure-acknowledgement.js";

describe("hasExplicitMutatingToolFailureAcknowledgement", () => {
  it.each([
    "I couldn't update the file, so no changes were applied.",
    "I couldn't run the command because python was not found.",
    "The write failed with a permission error.",
    "Command failed while applying the patch.",
    "The sub-issue API rejected the link so each body carries a Related pointer instead.",
    "The API refused the update, so I left the existing body unchanged.",
    "GitHub denied the request to create the issue.",
    "The shell command was blocked by the approval policy.",
    "The outbound message bounced, so nothing was delivered.",
    "The update was rejected by the remote API.",
    // Negated success then genuine later failure must still acknowledge.
    "The first attempt was not rejected. The second write failed.",
    "The API was never refused on try one, but the final request failed.",
  ])("acknowledges truthful negative outcome: %s", (text) => {
    expect(hasExplicitMutatingToolFailureAcknowledgement(text)).toBe(true);
  });

  it.each([
    "No issues found. The update is complete.",
    "I did not find any issues in the file. The update is complete.",
    "I did not need to update the file; it is already correct.",
    "There were no failures during the write path.",
    "The command did not fail; it completed with exit 0.",
    "Status loaded.",
    "The update was not rejected; it succeeded.",
    "The API was never refused; the write completed cleanly.",
    "The request was not denied by GitHub.",
    "The command was not blocked by the approval policy.",
    "The message was not bounced.",
    "There was no rejection from the remote API.",
  ])("does not treat non-failure or negated-success phrasing as acknowledgement: %s", (text) => {
    expect(hasExplicitMutatingToolFailureAcknowledgement(text)).toBe(false);
  });
});
