// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const ACTION = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function step(name) {
  const start = ACTION.indexOf(`    - name: ${name}\n`);
  assert.notEqual(start, -1);
  const end = ACTION.indexOf("\n    - name:", start + 1);
  return ACTION.slice(start, end < 0 ? undefined : end);
}
function body(block, key, indent) {
  const marker = `${" ".repeat(indent)}${key}: |\n`;
  const start = block.indexOf(marker);
  assert.notEqual(start, -1);
  return block.slice(start + marker.length).split("\n")
    .map(line => line.slice(indent + 2)).join("\n");
}
function evaluate(value, state) {
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    return new Function("inputs", "github", "env", "steps", `return (${expression});`)(
      state.inputs, state.github, state.env, { range: { outputs: state.outputs } },
    ) ?? "";
  });
}
function environment(block, state) {
  const env = {};
  for (const line of block.split("\n")) {
    const match = /^        ([A-Z_]+): (.*)$/.exec(line);
    if (match) env[match[1]] = evaluate(match[2], state);
  }
  return env;
}

class PushRangeDriver {
  static create(t) {
    const driver = new PushRangeDriver();
    t.after(() => fs.rmSync(driver.dir, { recursive: true, force: true }));
    return driver;
  }
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-push-range-"));
    this.git("init", "-q");
    this.git("config", "user.email", "fixture@example.test");
    this.git("config", "user.name", "Fixture");
    this.git("config", "commit.gpgsign", "false");
    this.base = this.commit("base.txt", "base");
    this.before = this.commit("earlier.txt", "earlier PR work");
    this.first = this.commit("first.txt", "first pushed commit");
    this.after = this.commit("second.txt", "second pushed commit");
    this.latest = this.commit("later.txt", "a later push must not replace the event head");
    this.outputs = {};
    this.inputs = { review_range: "push", checkpoint_range: "true", full_review: "false" };
    this.github = { event_name: "pull_request_target", repository: "owner/repo", event: {
      action: "synchronize", before: this.before, after: this.after,
      pull_request: { draft: false, head: { sha: this.after, repo: { full_name: "owner/repo" } } },
    } };
    this.env = { HEAD_SHA: this.after, BASE_REF: "main", MERGE_BASE: this.base,
      GITHUB_ACTION_PATH: ROOT, GITHUB_WORKSPACE: this.dir, REVIEW_TASK_TIMEOUT: "15" };
    this.bin = path.join(this.dir, "bin");
    fs.mkdirSync(this.bin);
    this.calls = path.join(this.dir, "calls.json");
    fs.writeFileSync(path.join(this.bin, "ocr"), `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)));\nconsole.log('{}');\n`, { mode: 0o755 });
  }
  git(...args) {
    const result = spawnSync("git", args, { cwd: this.dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  commit(file, content) {
    fs.writeFileSync(path.join(this.dir, file), content);
    this.git("add", file);
    this.git("commit", "-qm", content);
    return this.git("rev-parse", "HEAD");
  }
  givenBrokenCheckpoint() {
    this.github.rest = new Proxy({}, { get: () => { throw new Error("checkpoint API rate limit"); } });
    fs.mkdirSync(path.join(this.dir, ".opencodereview"));
    fs.writeFileSync(path.join(this.dir, ".opencodereview/rule.json"), "unreadable checkpoint configuration");
  }
  givenEventChange(key, value) { this.github.event[key] = value; }
  givenInput(key, value) { this.inputs[key] = value; }
  givenDraft() { this.github.event.pull_request.draft = true; }
  givenFork() { this.github.event.pull_request.head.repo.full_name = "fork/repo"; }
  givenWrongEvent() { this.github.event_name = "issue_comment"; }
  givenWrongHeadOverride() { this.env.HEAD_SHA = this.latest; }
  givenMismatchedHead() { this.github.event.pull_request.head.sha = this.latest; }
  givenRewrittenHistory() {
    this.git("checkout", "--detach", this.base);
    const rewritten = this.commit("rewrite.txt", "rewritten PR history");
    this.github.event.after = rewritten;
    this.github.event.pull_request.head.sha = rewritten;
    this.env.HEAD_SHA = rewritten;
  }
  givenMissingObjectsThatCanBeFetched() {
    const origin = this.dir;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-push-fetch-"));
    this.origin = origin;
    this.git("init", "-q");
    this.git("remote", "add", "origin", origin);
    this.env.GITHUB_WORKSPACE = this.dir;
    this.git("config", "user.email", "fixture@example.test");
  }
  async whenReviewRuns({ skipResolver = false } = {}) {
    try {
      const validation = step("Validate review_range");
      const validationResult = spawnSync("bash", ["-e", "-c", body(validation, "run", 6)], {
        env: { ...process.env, ...environment(validation, this) }, encoding: "utf8",
      });
      if (validationResult.status !== 0) throw new Error(validationResult.stdout + validationResult.stderr);
      if (!skipResolver) {
        const block = step("Resolve review range");
        const script = body(block, "script", 8);
        await new AsyncFunction("require", "process", "core", "github", "context", script)(
          require, { env: { ...this.env, ...environment(block, this) } },
          { setOutput: (key, value) => { this.outputs[key] = value; }, info() {}, warning() {} },
          this.github, {},
        );
      }
      const run = step("Run OpenCodeReview");
      const script = body(run, "run", 6).replaceAll("/tmp/ocr-", `${this.dir}/ocr-`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: this.dir, encoding: "utf8", env: { ...process.env, ...this.env,
          ...environment(run, this), GITHUB_ENV: path.join(this.dir, "env"),
          CALLS: this.calls, PATH: `${this.bin}:${process.env.PATH}` },
      });
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    } catch (error) { this.error = error; }
  }
  thenOnlyPushedChangesAreReviewed() {
    assert.equal(this.error, undefined, this.error?.stack);
    const args = JSON.parse(fs.readFileSync(this.calls, "utf8"));
    assert.equal(args[args.indexOf("--from") + 1], this.before);
    assert.equal(args[args.indexOf("--to") + 1], this.after);
    // This is the CLI's merge-base behavior, not an assumed direct git diff.
    const selectedBase = this.git("merge-base", this.before, this.after);
    assert.deepEqual(this.git("diff", "--name-only", selectedBase, this.after).split("\n"), ["first.txt", "second.txt"]);
    assert.equal(this.outputs.range_mode, "push");
    assert.equal(this.outputs.range_from, this.before);
    assert.equal(this.outputs.range_to, this.after);
    assert.equal(this.outputs.checkpoint_carry, "");
    assert.equal(this.outputs.config_fingerprint, "");
    const post = step("Post review comments");
    const match = /checkpointEnabled: (.*),/.exec(post);
    assert.equal(evaluate(match[1], this), "false", "push reviews must not advance a checkpoint even if enabled by caller");
  }
  thenNoReviewIsInvoked(message) {
    assert.ok(this.error, "invalid range must fail");
    assert.match(this.error.message, message);
    assert.equal(fs.existsSync(this.calls), false, "no CLI/LLM review after an invalid range");
  }
  disposeOrigin(t) {
    t.after(() => fs.rmSync(this.origin, { recursive: true, force: true }));
  }
}
module.exports = { PushRangeDriver };
