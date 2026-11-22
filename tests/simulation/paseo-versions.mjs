// Paseo CLI versions pinned in package.json, by the alias each is installed under.
// The native and restart runners both resolve a requested version here.
export const paseoPackages = new Map([
  ['0.12.0', '@getpaseo/cli-0-12'],
  ['0.13.0', '@getpaseo/cli-0-13'],
  ['0.14.0', '@getpaseo/cli-0-14'],
  ['0.15.0-beta.1', '@getpaseo/cli-0-15'],
  ['0.15.0', '@getpaseo/cli-0-15-stable'],
  ['0.16.0-beta.1', '@getpaseo/cli-0-16-beta'],
  ['0.16.0', '@getpaseo/cli-0-16-stable'],
  ['0.16.2', '@getpaseo/cli-0-16-2'],
  ['0.17.0-beta.1', '@getpaseo/cli-0-17-beta'],
  ['0.17.1', '@getpaseo/cli-0-17-1'],
]);
