// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const { test } = require("node:test");
const { PushRangeDriver } = require("./push-range.test-driver");

test("reviews all changes in the event push despite broken checkpoints and a newer live head", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenBrokenCheckpoint();
  await driver.whenReviewRuns();
  driver.thenOnlyPushedChangesAreReviewed();
});

test("fetches immutable event commits when the checkout lacks them", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenMissingObjectsThatCanBeFetched();
  driver.disposeOrigin(t);
  await driver.whenReviewRuns();
  driver.thenOnlyPushedChangesAreReviewed();
});

test("rejects rewritten history rather than letting the CLI widen to merge-base", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenRewrittenHistory();
  await driver.whenReviewRuns();
  driver.thenNoReviewIsInvoked(/not an ancestor/);
});

for (const [name, value, message] of [
  ["missing", "", /non-zero 40-character SHA/],
  ["malformed", "not-a-sha", /non-zero 40-character SHA/],
  ["zero", "0".repeat(40), /non-zero 40-character SHA/],
  ["unavailable", "f".repeat(40), /could not resolve commit/],
]) {
  test(`rejects a ${name} starting commit without invoking a review`, async t => {
    const driver = PushRangeDriver.create(t);
    driver.givenEventChange("before", value);
    await driver.whenReviewRuns();
    driver.thenNoReviewIsInvoked(message);
  });
}

for (const [name, setup, message] of [
  ["fork", "givenFork", /current repository/],
  ["draft", "givenDraft", /ready for review/],
  ["manual event", "givenWrongEvent", /pull_request_target/],
  ["head override", "givenWrongHeadOverride", /head override/],
  ["inconsistent event head", "givenMismatchedHead", /does not match/],
]) {
  test(`rejects a ${name} before review`, async t => {
    const driver = PushRangeDriver.create(t);
    driver[setup]();
    await driver.whenReviewRuns();
    driver.thenNoReviewIsInvoked(message);
  });
}

test("rejects full_review in push mode", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenInput("full_review", "true");
  await driver.whenReviewRuns();
  driver.thenNoReviewIsInvoked(/full_review conflicts/);
});

test("rejects push mode for ready_for_review rather than shrinking its full scope", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenEventChange("action", "ready_for_review");
  await driver.whenReviewRuns();
  driver.thenNoReviewIsInvoked(/synchronize/);
});

test("rejects an unknown policy instead of defaulting to a full review", async t => {
  const driver = PushRangeDriver.create(t);
  driver.givenInput("review_range", "typo");
  await driver.whenReviewRuns();
  driver.thenNoReviewIsInvoked(/must be 'pull_request' or 'push'/);
});

test("refuses a full fallback when push range outputs are missing", async t => {
  const driver = PushRangeDriver.create(t);
  await driver.whenReviewRuns({ skipResolver: true });
  driver.thenNoReviewIsInvoked(/Validated push range is missing/);
});
