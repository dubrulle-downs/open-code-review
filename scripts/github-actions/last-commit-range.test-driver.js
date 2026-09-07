// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runPostReviewComments } = require("./post-review-comments");

const ROOT = path.resolve(__dirname, "../..");
const ACTION = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function step(name) {
  const start = ACTION.indexOf(`    - name: ${name}\n`);
  assert.notEqual(start, -1, `action.yml must contain ${name}`);
  const end = ACTION.indexOf("\n    - name:", start + 1);
  return ACTION.slice(start, end < 0 ? undefined : end);
}

function body(block, key, indent) {
  const marker = `${" ".repeat(indent)}${key}: |\n`;
  const start = block.indexOf(marker);
  assert.notEqual(start, -1, `${key} script is missing`);
  return block.slice(start + marker.length).split("\n")
    .map((line) => line.slice(indent + 2)).join("\n");
}

function evaluate(value, state) {
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match, expression) => {
    return new Function("inputs", "github", "env", "steps", `return (${expression});`)(
      state.inputs,
      state.github,
      state.env,
      { range: { outputs: state.outputs } },
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

class LastCommitRangeDriver {
  static create(t) {
    const driver = new LastCommitRangeDriver();
    t.after(() => driver.dispose());
    return driver;
  }

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-last-commit-range-"));
    this.git("init", "-q");
    this.git("config", "user.email", "fixture@example.test");
    this.git("config", "user.name", "Fixture");
    this.git("config", "commit.gpgsign", "false");
    this.base = this.commit("base.txt", "base");
    this.previous = this.commit("previous.txt", "previous PR work");
    this.immediateParent = this.commit("earlier.txt", "earlier PR work");
    this.head = this.commit("target.txt", "the selected last commit");
    this.expectedFrom = this.immediateParent;
    this.origin = null;
    this.outputs = {};
    this.inputs = { review_range: "last_commit", checkpoint_range: "true", full_review: "false" };
    this.github = {
      event_name: "issue_comment",
      repository: "owner/repo",
      event: {
        action: "created",
        issue: { number: 123 },
        // The issue_comment event does not use these fields for resolution,
        // but the action's shared env contract still evaluates their values.
        pull_request: {
          draft: false,
          head: { sha: this.head, repo: { full_name: "owner/repo" } },
        },
      },
    };
    this.env = {
      HEAD_SHA: this.head,
      BASE_REF: "main",
      MERGE_BASE: this.base,
      GITHUB_ACTION_PATH: ROOT,
      GITHUB_WORKSPACE: this.dir,
      REVIEW_TASK_TIMEOUT: "15",
    };
    this.makeOcrFixture();
  }

  makeOcrFixture() {
    this.bin = path.join(this.dir, "bin");
    fs.mkdirSync(this.bin, { recursive: true });
    this.calls = path.join(this.dir, "calls.json");
    fs.writeFileSync(
      path.join(this.bin, "ocr"),
      `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)));\nconsole.log('{}');\n`,
      { mode: 0o755 },
    );
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

  givenMergeHead() {
    const mainBranch = this.git("branch", "--show-current");
    this.git("checkout", "-qb", "merge-side", this.immediateParent);
    const side = this.commit("side.txt", "side branch change");
    this.git("checkout", mainBranch);
    const mainTip = this.commit("main-tip.txt", "main branch change");
    this.git("merge", "--no-ff", "merge-side", "-m", "merge selected commit");
    this.head = this.git("rev-parse", "HEAD");
    this.expectedFrom = mainTip;
    this.side = side;
    this.env.HEAD_SHA = this.head;
  }

  givenMissingObjectsThatCanBeFetched() {
    const original = this.dir;
    this.origin = original;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-last-commit-fetch-"));
    this.git("init", "-q");
    this.git("remote", "add", "origin", original);
    this.git("config", "user.email", "fixture@example.test");
    this.git("config", "user.name", "Fixture");
    this.env.GITHUB_WORKSPACE = this.dir;
    this.makeOcrFixture();
  }

  givenRootHead() {
    this.head = this.base;
    this.env.HEAD_SHA = this.head;
  }

  givenHead(value) {
    this.env.HEAD_SHA = value;
  }

  givenWrongEvent() {
    this.github.event_name = "pull_request_target";
  }

  givenFullReview() {
    this.inputs.full_review = "true";
  }

  givenInput(key, value) {
    this.inputs[key] = value;
  }

  async whenReviewRuns({ skipResolver = false } = {}) {
    try {
      const validation = step("Validate review_range");
      const validationResult = spawnSync("bash", ["-e", "-o", "pipefail", "-c", body(validation, "run", 6)], {
        env: { ...process.env, ...environment(validation, this) },
        encoding: "utf8",
      });
      if (validationResult.status !== 0) {
        throw new Error(validationResult.stdout + validationResult.stderr);
      }

      if (!skipResolver) {
        const resolve = step("Resolve review range");
        const script = body(resolve, "script", 8);
        await new AsyncFunction("require", "process", "core", "github", "context", script)(
          require,
          { env: { ...this.env, ...environment(resolve, this) } },
          {
            setOutput: (key, value) => { this.outputs[key] = value; },
            info() {},
            warning() {},
          },
          this.github,
          {},
        );
      }

      const run = step("Run OpenCodeReview");
      const script = body(run, "run", 6).replaceAll("/tmp/ocr-", `${this.dir}/ocr-`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: this.dir,
        encoding: "utf8",
        env: {
          ...process.env,
          ...this.env,
          ...environment(run, this),
          GITHUB_ENV: path.join(this.dir, "github-env"),
          CALLS: this.calls,
          PATH: `${this.bin}:${process.env.PATH}`,
        },
      });
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    } catch (error) {
      this.error = error;
    }
  }

  thenOnlyLastCommitIsReviewed() {
    assert.equal(this.error, undefined, this.error?.stack);
    const args = JSON.parse(fs.readFileSync(this.calls, "utf8"));
    assert.equal(args[args.indexOf("--from") + 1], this.expectedFrom);
    assert.equal(args[args.indexOf("--to") + 1], this.head);
    assert.deepEqual(
      this.git("diff", "--name-only", this.expectedFrom, this.head).split("\n").filter(Boolean),
      this.expectedFrom === this.immediateParent ? ["target.txt"] : ["side.txt"],
    );
    assert.equal(this.outputs.range_mode, "last_commit");
    assert.equal(this.outputs.range_reason, "first_parent");
    assert.equal(this.outputs.range_from, this.expectedFrom);
    assert.equal(this.outputs.range_to, this.head);
    assert.equal(this.outputs.checkpoint_carry, "");
    assert.equal(this.outputs.config_fingerprint, "");

    const post = step("Post review comments");
    const match = /checkpointEnabled: (.*),/.exec(post);
    assert.ok(match, "Post review comments must configure checkpointEnabled");
    assert.equal(
      evaluate(match[1], this),
      "false",
      "last_commit reviews must never advance checkpoints",
    );
  }

  thenNoReviewIsInvoked(message) {
    assert.ok(this.error, "invalid last_commit range must fail");
    assert.match(this.error.message, message);
    assert.equal(fs.existsSync(this.calls), false, "no CLI/LLM review after an invalid range");
  }

  givenPublicationHeadMoved() {
    this.reviewedHead = this.head;
    this.currentHead = "b".repeat(40);
    this.publicationReads = 0;
    this.publicationWrites = 0;
  }

  async whenPublishingLastCommitResult() {
    const github = {
      rest: {
        pulls: {
          get: async () => {
            this.publicationReads += 1;
            return { data: { head: { sha: this.currentHead } } };
          },
        },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => {
            this.publicationWrites += 1;
            return { data: { id: 1, html_url: "https://example.invalid/comment/1" } };
          },
          updateComment: async () => {
            this.publicationWrites += 1;
            return { data: { id: 1, html_url: "https://example.invalid/comment/1" } };
          },
        },
      },
    };
    const context = {
      repo: { owner: "owner", repo: "repo" },
      issue: { number: 123 },
      eventName: "issue_comment",
      payload: {},
    };
    const core = { setOutput() {}, info() {} };
    const fsApi = {
      readFileSync(file) {
        if (file === "/tmp/ocr-result.json") return JSON.stringify({ comments: [] });
        if (file === "/tmp/ocr-stderr.log") return "";
        throw new Error(`unexpected read: ${file}`);
      },
    };
    try {
      await runPostReviewComments({
        github,
        context,
        core,
        fs: fsApi,
        rangeMode: "last_commit",
        rangeFrom: this.expectedFrom,
        rangeTo: this.reviewedHead,
        checkpointEnabled: false,
      });
    } catch (error) {
      this.publicationError = error;
    }
  }

  thenPublicationIsRefused() {
    assert.ok(this.publicationError, "a moved last_commit head must fail publication");
    assert.match(this.publicationError.message, /last_commit review head changed before publication/);
    assert.equal(this.publicationReads, 1, "publication must re-read the live PR head exactly once");
    assert.equal(this.publicationWrites, 0, "a stale result must not write a summary or review");
  }

  dispose() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    if (this.origin) fs.rmSync(this.origin, { recursive: true, force: true });
  }
}

module.exports = { LastCommitRangeDriver };
