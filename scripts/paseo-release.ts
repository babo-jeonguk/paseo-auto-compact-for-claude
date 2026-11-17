/**
 * Decides which Paseo releases to announce: a new minor line's betas and its first release, never a
 * patch. Each line gets one issue; later versions of the line are comments on it. Pure; the CLI acts.
 *
 * The baseline is the newest Paseo CLI the native simulation runs, not the SDK pin: the package stays
 * compiled against SDK 0.12 as its minimum contract, so the pin never moves when a line is supported.
 */

export interface DistTags {
  latest?: string;
  beta?: string;
}

/** A watch issue, read back from the markers in its body and comments. */
export interface WatchIssue {
  number: number;
  line: string;
  versions: string[];
}

export type Action =
  | { kind: "open"; line: string; version: string }
  | { kind: "comment"; issue: number; line: string; version: string };

interface Version {
  core: [number, number, number];
  pre: string[];
}

const MARKER = /<!-- paseo-release-watch line=(\S+) version=(\S+) -->/g;

function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  if (!match) throw new Error(`${JSON.stringify(text)} is not a version`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const a = /^\d+$/.test(left);
  const b = /^\d+$/.test(right);
  if (a && b) return Math.sign(Number(left) - Number(right));
  if (a !== b) return a ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic-version order: core first, then a prerelease below its release. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index += 1) {
    const order = compareIdentifiers(a.pre[index]!, b.pre[index]!);
    if (order) return order;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

const CLI_SPEC = /^npm:@getpaseo\/cli@(.+)$/;

/** The newest `@getpaseo/cli` version among the simulation's aliased dependencies. */
export function newestTested(dependencies: Record<string, string>): string {
  const versions = Object.values(dependencies).flatMap((spec) => CLI_SPEC.exec(spec)?.[1] ?? []);
  if (!versions.length) throw new Error("the simulation pins no @getpaseo/cli version");
  return versions.sort(compareVersions).at(-1)!;
}

function lineOf(version: string): string {
  const { core } = parseVersion(version);
  return `${core[0]}.${core[1]}`;
}

/** The tagged versions to announce, oldest first: a `.0` beta or a `.0` release newer than the tested one. */
export function watchedReleases(tags: DistTags, tested: string): string[] {
  const found: string[] = [];
  if (tags.latest) {
    const latest = parseVersion(tags.latest);
    if (!latest.pre.length && latest.core[2] === 0) found.push(tags.latest);
  }
  if (tags.beta) {
    const beta = parseVersion(tags.beta);
    const ahead = !tags.latest || compareVersions(tags.beta, tags.latest) > 0;
    if (beta.pre.length && beta.core[2] === 0 && ahead) found.push(tags.beta);
  }
  return found.filter((version) => compareVersions(version, tested) > 0).sort(compareVersions);
}

/** Opens a line's issue for its first announced version and comments once for each later one. */
export function planActions(tags: DistTags, tested: string, issues: WatchIssue[]): Action[] {
  const actions: Action[] = [];
  for (const version of watchedReleases(tags, tested)) {
    const line = lineOf(version);
    const issue = issues.find((candidate) => candidate.line === line);
    if (!issue) actions.push({ kind: "open", line, version });
    else if (!issue.versions.includes(version)) actions.push({ kind: "comment", issue: issue.number, line, version });
  }
  return actions;
}

/** `texts` are the issue body and its comments; an issue without a marker is not a watch issue. */
export function readIssue(number: number, texts: string[]): WatchIssue | null {
  let line: string | undefined;
  const versions: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(MARKER)) {
      line ??= match[1];
      versions.push(match[2]!);
    }
  }
  return line ? { number, line, versions } : null;
}

function marker(version: string): string {
  return `<!-- paseo-release-watch line=${lineOf(version)} version=${version} -->`;
}

function notes(version: string): string {
  return `https://github.com/getpaseo/paseo/releases/tag/v${version}`;
}

function mention(owner: string | undefined): string {
  return owner ? `@${owner} ` : "";
}

export function issueTitle(line: string): string {
  return `Support Paseo ${line}`;
}

export function issueBody(line: string, version: string, tested: string, owner: string | undefined): string {
  const tag = parseVersion(version).pre.length ? "beta" : "latest";
  return `${marker(version)}
${mention(owner)}Paseo **${version}** is on npm under the \`${tag}\` tag. The native simulation runs up to **${tested}**.

Release notes: ${notes(version)}

- [ ] Prepare the plugin for ${line}: add its CLI alias to \`tests/simulation/package.json\`, a \`test:simulation:${line}\` script and the version to both CI matrices, run \`npm run check\` and its native simulation as \`docs/testing.md\` describes, and update the tested versions in the docs.
- [ ] Open a pull request that closes this issue.
- [ ] Recheck it against the ${line}.0 release, then merge it.

Later ${line} betas and the ${line}.0 release are posted here as comments.
`;
}

export function commentBody(version: string, owner: string | undefined): string {
  const what = parseVersion(version).pre.length
    ? `Paseo **${version}** is on npm under the \`beta\` tag.`
    : `Paseo **${version}** is released under the \`latest\` tag. Recheck the pull request against it, then merge it.`;
  return `${marker(version)}
${mention(owner)}${what}

Release notes: ${notes(version)}
`;
}
