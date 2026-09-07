// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const { test } = require("node:test");
const { LastCommitRangeDriver } = require("./last-commit-range.test-driver");

test("reviews only the selected head's first parent range after multiple previous commits", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  await driver.whenReviewRuns();
  driver.thenOnlyLastCommitIsReviewed();
});

test("uses the merge commit's first parent, not its second parent or PR root", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  driver.givenMergeHead();
  await driver.whenReviewRuns();
  driver.thenOnlyLastCommitIsReviewed();
});

test("fetches the immutable supplied head and its parent when the checkout lacks them", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  driver.givenMissingObjectsThatCanBeFetched();
  await driver.whenReviewRuns();
  driver.thenOnlyLastCommitIsReviewed();
});

for (const [name, setup, message] of [
  ["non-issue-comment event", "givenWrongEvent", /issue_comment/],
  ["full review fallback", "givenFullReview", /full_review must be false/],
  ["root head", "givenRootHead", /no first parent/],
]) {
  test(`rejects a ${name} before invoking a review`, async (t) => {
    const driver = LastCommitRangeDriver.create(t);
    driver[setup]();
    await driver.whenReviewRuns();
    driver.thenNoReviewIsInvoked(message);
  });
}

for (const [name, value, message] of [
  ["missing head", "", /non-zero 40-character SHA/],
  ["malformed head", "not-a-sha", /non-zero 40-character SHA/],
  ["zero head", "0".repeat(40), /non-zero 40-character SHA/],
  ["unavailable head", "f".repeat(40), /could not resolve commit/],
]) {
  test(`rejects ${name} without invoking a review`, async (t) => {
    const driver = LastCommitRangeDriver.create(t);
    driver.givenHead(value);
    await driver.whenReviewRuns();
    driver.thenNoReviewIsInvoked(message);
  });
}

test("refuses the full-review fallback when the bounded resolver was skipped", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  await driver.whenReviewRuns({ skipResolver: true });
  driver.thenNoReviewIsInvoked(/Validated last_commit range is missing/);
});

test("rejects a review_range policy that is not last_commit in this harness", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  driver.givenInput("review_range", "typo");
  await driver.whenReviewRuns();
  driver.thenNoReviewIsInvoked(/must be 'pull_request', 'push', or 'last_commit'/);
});

test("refuses to publish a last-commit result when the PR head moved", async (t) => {
  const driver = LastCommitRangeDriver.create(t);
  driver.givenPublicationHeadMoved();
  await driver.whenPublishingLastCommitResult();
  driver.thenPublicationIsRefused();
});
