import assert from "node:assert/strict";
import test from "node:test";
import {
  commentBody,
  compareVersions,
  issueBody,
  issueTitle,
  newestTested,
  planActions,
  readIssue,
  watchedReleases,
  type WatchIssue,
} from "./paseo-release";

test("versions order by their core, then a prerelease below its release", () => {
  assert.equal(compareVersions("0.17.0", "0.16.1"), 1);
  assert.equal(compareVersions("0.16.1", "0.16.1"), 0);
  assert.equal(compareVersions("0.17.0-beta.1", "0.16.1"), 1);
  assert.equal(compareVersions("0.17.0-beta.1", "0.17.0"), -1);
  assert.equal(compareVersions("0.17.0-beta.2", "0.17.0-beta.10"), -1, "numeric identifiers compare as numbers");
  assert.equal(compareVersions("0.17.0-beta.2", "0.17.0-beta.2"), 0);
  assert.equal(compareVersions("0.17.0-beta", "0.17.0-beta.1"), -1, "a shorter prerelease sorts first");
  assert.throws(() => compareVersions("next", "0.16.1"));
});

test("the baseline is the newest Paseo CLI the simulation pins", () => {
  const dependencies = {
    "@anthropic-ai/claude-code": "2.1.306",
    "@getpaseo/cli-0-12": "npm:@getpaseo/cli@0.12.0",
    "@getpaseo/cli-0-16-stable": "npm:@getpaseo/cli@0.16.0",
    "@getpaseo/cli-0-16-beta": "npm:@getpaseo/cli@0.16.0-beta.1",
    "playwright-core": "1.58.2",
  };
  assert.equal(newestTested(dependencies), "0.16.0");
  assert.equal(newestTested({ ...dependencies, "@getpaseo/cli-0-17-beta": "npm:@getpaseo/cli@0.17.0-beta.1" }), "0.17.0-beta.1");
  assert.throws(() => newestTested({ "playwright-core": "1.58.2" }));
});

test("a new line's betas and its first release are watched; patches are not", () => {
  assert.deepEqual(watchedReleases({ latest: "0.16.1", beta: "0.17.0-beta.1" }, "0.16.0"), ["0.17.0-beta.1"]);
  assert.deepEqual(watchedReleases({ latest: "0.17.0", beta: "0.17.0" }, "0.16.0"), ["0.17.0"]);
  assert.deepEqual(watchedReleases({ latest: "0.16.2", beta: "0.16.2" }, "0.16.0"), [], "a patch is ignored");
  assert.deepEqual(watchedReleases({ latest: "0.16.1", beta: "0.16.2-beta.1" }, "0.16.0"), [], "a patch beta is ignored");
  assert.deepEqual(watchedReleases({ latest: "0.17.0", beta: "0.17.0" }, "0.17.0"), [], "nothing past the tested version");
  assert.deepEqual(
    watchedReleases({ latest: "0.17.0", beta: "0.17.0-beta.2" }, "0.16.0"),
    ["0.17.0"],
    "a beta tag left behind its release is ignored",
  );
  assert.deepEqual(
    watchedReleases({ latest: "0.17.0", beta: "0.18.0-beta.1" }, "0.16.0"),
    ["0.17.0", "0.18.0-beta.1"],
    "lines are reported oldest first",
  );
  assert.deepEqual(watchedReleases({ latest: "0.17.0", beta: "0.17.0" }, "0.17.0-beta.2"), ["0.17.0"], "a tested beta");
  assert.deepEqual(watchedReleases({ latest: "0.17.0" }, "0.16.0"), ["0.17.0"], "no beta tag");
});

test("the first watched version of a line opens its issue", () => {
  assert.deepEqual(planActions({ latest: "0.16.1", beta: "0.17.0-beta.1" }, "0.16.0", []), [
    { kind: "open", line: "0.17", version: "0.17.0-beta.1" },
  ]);
  assert.deepEqual(planActions({ latest: "0.17.0", beta: "0.17.0" }, "0.16.0", []), [
    { kind: "open", line: "0.17", version: "0.17.0" },
  ]);
});

test("later versions of the line comment once on its issue, open or closed", () => {
  const issue: WatchIssue = { number: 41, line: "0.17", versions: ["0.17.0-beta.1"] };
  assert.deepEqual(planActions({ latest: "0.16.1", beta: "0.17.0-beta.2" }, "0.16.0", [issue]), [
    { kind: "comment", issue: 41, line: "0.17", version: "0.17.0-beta.2" },
  ]);
  assert.deepEqual(planActions({ latest: "0.17.0", beta: "0.17.0" }, "0.16.0", [issue]), [
    { kind: "comment", issue: 41, line: "0.17", version: "0.17.0" },
  ]);
  assert.deepEqual(planActions({ latest: "0.16.1", beta: "0.17.0-beta.1" }, "0.16.0", [issue]), [], "already posted");
  const other: WatchIssue = { number: 40, line: "0.16", versions: ["0.16.0-beta.1", "0.16.0"] };
  assert.deepEqual(planActions({ latest: "0.16.1", beta: "0.17.0-beta.1" }, "0.16.0", [other]), [
    { kind: "open", line: "0.17", version: "0.17.0-beta.1" },
  ]);
});

test("an issue is read back from the markers its own posts carry", () => {
  const owner = "maintainer";
  const body = issueBody("0.17", "0.17.0-beta.1", "0.16.0", owner);
  assert.match(body, /@maintainer/);
  assert.match(body, /releases\/tag\/v0\.17\.0-beta\.1/);
  assert.match(body, /test:simulation:0\.17/);
  assert.match(issueTitle("0.17"), /0\.17/);
  const comments = [commentBody("0.17.0-beta.2", owner), "Looks fine on my side.", commentBody("0.17.0", undefined)];
  assert.doesNotMatch(comments[2], /@/);
  assert.deepEqual(readIssue(41, [body, ...comments]), {
    number: 41,
    line: "0.17",
    versions: ["0.17.0-beta.1", "0.17.0-beta.2", "0.17.0"],
  });
  assert.equal(readIssue(42, ["An issue someone wrote by hand."]), null);
});
